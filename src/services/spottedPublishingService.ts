import { supabase } from "../config/supabase";
import { adminRepository } from "./adminRepository";
import { decrypt } from "./cryptoService";
import { generateSpottedImage, resolveTheme } from "./imageService";
import { getPublishingLimit, instagramService, type IgCredentials } from "./instagramService";
import { spottedRepository } from "./spottedRepository";
import { storageService } from "./storageService";
import { fetchTemplateBuffer, TemplateFetchError } from "./templateFetchService";

/** Erro com status HTTP para a rota de aprovação responder corretamente. */
export class PublishError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "PublishError";
    this.status = status;
  }
}

export interface PublishOutcome {
  /** Número exibido no card, ex.: "[42]". */
  postId: string;
  displayId: number;
  instagramMediaId: string;
}

export interface PublishOptions {
  /**
   * Admin que aprovou. `null` = publicação automática (sem revisor).
   * `undefined` = não grava reviewed_by.
   */
  reviewedBy?: string | null;
}

const ACCOUNT_SELECT =
  "id, username, slug, ig_user_id, access_token_encrypted, connection_status, needs_reauth, " +
  "template_image_url, base_image_url, text_color, shadow_color, base_caption";

interface PublishAccount {
  id: string;
  username: string;
  slug: string | null;
  ig_user_id: string;
  access_token_encrypted: string | null;
  connection_status: string;
  needs_reauth: boolean;
  template_image_url: string | null;
  base_image_url: string | null;
  text_color: string | null;
  shadow_color: string | null;
  base_caption: string | null;
}

/**
 * Publica um spotted PENDING no Instagram e atualiza o status.
 *
 * Reutilizado pelo endpoint de aprovação do admin e pelo envio público quando
 * a conta tem `is_moderated = false`. Se a publicação falhar, o post continua
 * PENDING (o chamador decide como responder).
 */
export async function publishSpotted(
  id: string,
  options: PublishOptions = {}
): Promise<PublishOutcome> {
  if (!supabase) throw new PublishError("Supabase não configurado.");

  const dbRecord = await spottedRepository.findById(id);
  if (!dbRecord) throw new PublishError("Post não encontrado.", 404);
  if (dbRecord.status !== "PENDING") {
    throw new PublishError("Post não está pendente.", 400);
  }

  const accountId = dbRecord.instagram_account_id;
  if (!accountId) throw new PublishError("Spotted sem conta vinculada.", 400);

  const { data: rawAccount, error: accountErr } = await supabase
    .from("instagram_accounts")
    .select(ACCOUNT_SELECT)
    .eq("id", accountId)
    .single();

  const account = rawAccount as unknown as PublishAccount | null;
  if (accountErr || !account) throw new PublishError("Conta não encontrada.", 404);

  if (!account.base_caption || String(account.base_caption).trim() === "") {
    throw new PublishError(
      "Legenda base (base_caption) não configurada para esta conta.",
      400
    );
  }

  if (account.connection_status !== "ok" || !account.access_token_encrypted) {
    throw new PublishError("Conta não conectada ao Instagram.", 400);
  }

  let displayId: number;
  try {
    displayId = await spottedRepository.getOrReserveDisplayId(
      accountId,
      dbRecord.display_id ?? null
    );
  } catch (error: any) {
    throw new PublishError(error?.message || "Falha ao reservar número do post.", 500);
  }

  if (!dbRecord.display_id) {
    const { error: displayErr } = await supabase
      .from("spotteds")
      .update({ display_id: displayId })
      .eq("id", id);
    if (displayErr) {
      console.error("[PUBLISH] Falha ao gravar display_id:", displayErr.message);
      throw new PublishError("Falha ao reservar número do post.", 500);
    }
  }

  const templateUrl = account.template_image_url;
  if (!templateUrl) {
    throw new PublishError("Template do card não configurado para esta cidade.", 400);
  }

  let templateBuffer: Buffer;
  try {
    templateBuffer = await fetchTemplateBuffer(templateUrl);
  } catch (error) {
    if (error instanceof TemplateFetchError) {
      console.error("[PUBLISH] Template fetch failed:", {
        code: error.code,
        status: error.status,
        message: error.message,
      });
      throw new PublishError("Template da conta inválido, reenvie a imagem base", 400);
    }
    throw error;
  }

  const theme = resolveTheme(account);
  const hasUserImage = Boolean(dbRecord.image_url);
  const { fileName, postId } = await generateSpottedImage(
    dbRecord.content,
    displayId,
    hasUserImage,
    templateBuffer,
    theme
  );

  const instagramCaption = `[${postId}] - ${dbRecord.content}\n\n${account.base_caption}`;

  let instagramMediaId: string | undefined;
  let creationId: string | undefined;
  let publishError: any = null;
  let creds: IgCredentials | undefined;

  try {
    const accessToken = decrypt(account.access_token_encrypted);
    creds = { accessToken, igUserId: account.ig_user_id };

    const quota = await getPublishingLimit(creds);
    if (quota.remaining <= 0) {
      throw new PublishError(
        `Cota de publicação esgotada (${quota.used}/${quota.limit} nas últimas 24h). Tente mais tarde.`,
        429
      );
    }

    console.log(`[PUBLISH][DEBUG] UPLOAD_CARD_START | accountId=${accountId} | slug=${account.slug} | fileName=${fileName}`);
    const cardUrl = await storageService.uploadCard(fileName, account.slug);
    console.log(`[PUBLISH][DEBUG] UPLOAD_CARD_END | cardUrl=${cardUrl}`);
    if (!cardUrl) throw new Error("Falha ao enviar card para bucket público.");

    const baseImageUrl = account.base_image_url;
    if (!baseImageUrl) {
      throw new Error("Foto de encerramento não configurada para esta cidade.");
    }

    console.log("[PUBLISH] Publicando no Instagram...", {
      accountId,
      igUserId: account.ig_user_id,
      username: account.username,
      slug: account.slug,
      hasUserImage,
      displayId,
      cardUrl: cardUrl,
      baseImageUrl: baseImageUrl,
    });

    const publishResult = hasUserImage
      ? await instagramService.postCarouselWithUserImage(
          cardUrl,
          dbRecord.image_url!,
          baseImageUrl,
          instagramCaption,
          creds
        )
      : await instagramService.postCarousel(
          cardUrl,
          baseImageUrl,
          instagramCaption,
          creds
        );

    instagramMediaId = publishResult.mediaId;
    creationId = publishResult.creationId;
    console.log(`[PUBLISH] Publicado com sucesso! Media ID: ${instagramMediaId}`);
  } catch (error: any) {
    // Cota esgotada/token ausente devem chegar ao chamador sem virar retry.
    if (error instanceof PublishError) throw error;

    publishError = error;
    if (!creationId && error?.creationId) creationId = error.creationId;

    console.error("[PUBLISH][DEBUG] FULL_ERROR | " + JSON.stringify({
      message: error?.message,
      name: error?.name,
      metaCode: error?.metaCode,
      metaSubcode: error?.metaSubcode,
      metaUserMsg: error?.metaUserMsg,
      metaUserTitle: error?.metaUserTitle,
      httpStatus: error?.httpStatus,
      isTransient: error?.isTransient,
      isAuthError: error?.isAuthError,
      creationId: error?.creationId || creationId,
      childrenIds: error?.childrenIds,
    }));
    console.error("[PUBLISH] Erro ao postar no Instagram:", {
      message: error?.message,
      metaCode: error?.metaCode,
      metaSubcode: error?.metaSubcode,
      metaUserMsg: error?.metaUserMsg,
      metaUserTitle: error?.metaUserTitle,
      httpStatus: error?.httpStatus,
      stack: error?.stack,
    });

    if (error?.isAuthError) {
      await adminRepository.updateConnection(accountId, {
        needs_reauth: true,
        connection_status: "needs_reauth",
        last_error: error.message,
      });
    }
  }

  // A Meta às vezes publica e ainda devolve erro. Confere antes de desistir.
  let verifiedMediaId: string | null | undefined;
  if (publishError && creationId && creds) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        verifiedMediaId = await instagramService.verifyPublished(
          creationId,
          instagramCaption,
          creds
        );
      } catch (error) {
        console.warn(
          `[PUBLISH] Falha ao verificar publicação (tentativa ${attempt}/2):`,
          error
        );
      }
      if (verifiedMediaId) {
        console.log(
          `[PUBLISH] Publicação confirmada na Meta na tentativa ${attempt}: ${verifiedMediaId}`
        );
        break;
      }
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
      }
    }
  }

  if (publishError && !verifiedMediaId && creationId) {
    console.error("[PUBLISH] Publicação falhou e verificação não encontrou o post.", {
      creationId,
      childrenIds: publishError?.childrenIds,
    });
  }

  const finalMediaId = verifiedMediaId || instagramMediaId;

  if (!finalMediaId) {
    await markReviewed(id, options.reviewedBy);
    throw new PublishError(
      `Erro Instagram: ${publishError?.message || "publicação não confirmada."}`,
      500
    );
  }

  await spottedRepository.updateStatus(id, "PUBLISHED", finalMediaId);
  await markReviewed(id, options.reviewedBy);

  return { postId, displayId, instagramMediaId: finalMediaId };
}

async function markReviewed(id: string, reviewedBy?: string | null): Promise<void> {
  if (!supabase) return;

  const update: Record<string, unknown> = { reviewed_at: new Date().toISOString() };
  if (reviewedBy !== undefined) update.reviewed_by = reviewedBy;

  const { error } = await supabase.from("spotteds").update(update).eq("id", id);
  if (error) {
    console.error(`[PUBLISH] Falha ao gravar revisão do post ${id}:`, error.message);
  }
}
