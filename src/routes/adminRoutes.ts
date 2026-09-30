/**
 * adminRoutes.ts
 *
 * Rotas do painel admin.
 * Requer autenticação de admin (requireAdmin).
 */

import { Router, Request, Response } from "express";
import { requireAdmin, requireAccountAccess, requireSuperAdmin } from "../middleware/adminAuth";
import { spottedRepository } from "../services/spottedRepository";
import { generateSpottedImage, generateSpottedImageBuffer, resolveTheme } from "../services/imageService";
import { storageService } from "../services/storageService";
import { instagramService } from "../services/instagramService";
import { adminRepository } from "../services/adminRepository";
import { decrypt } from "../services/cryptoService";
import { supabase } from "../config/supabase";
import { getPublishingLimit } from "../services/instagramService";
import { fetchTemplateBuffer, TemplateFetchError } from "../services/templateFetchService";

const router = Router();

// GET /api/admin/pending
// Pode receber ?account_id=<uuid> para filtrar. Se não, filtra por req.admin.accountIds
router.get("/pending", requireAdmin, async (req: Request, res: Response) => {
  try {
    if (!supabase) throw new Error("Supabase não configurado.");

    const { account_id } = req.query;

    let query = supabase
      .from("spotteds")
      .select("*, instagram_accounts(username, display_name, is_active)")
      .eq("status", "PENDING")
      .order("created_at", { ascending: false });

    if (account_id) {
      if (!req.admin!.is_super && !req.admin!.accountIds.includes(account_id as string)) {
        return res.status(403).json({ success: false, message: "Sem permissão." });
      }
      query = query.eq("instagram_account_id", account_id);
    } else if (!req.admin!.is_super) {
      if (req.admin!.accountIds.length === 0) {
        return res.json({ success: true, posts: [] });
      }
      query = query.in("instagram_account_id", req.admin!.accountIds);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Contas arquivadas somem da fila: os posts continuam no banco, mas
    // param de não publicar. Filtro em JS porque o join é um LEFT JOIN.
    const posts = (data ?? []).filter(
      (row) => row.instagram_accounts?.is_active !== false
    );

    res.json({ success: true, posts });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/admin/approve/:id
router.post("/approve/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!supabase) throw new Error("Supabase não configurado.");

  // 1. Busca o post pendente
  const dbRecord = await spottedRepository.findById(id);
  if (!dbRecord) return res.status(404).json({ success: false, message: "Post não encontrado." });
  if (dbRecord.status !== "PENDING") return res.status(400).json({ success: false, message: "Post não está pendente." });

  const accountId = dbRecord.instagram_account_id;
  if (!accountId) return res.status(400).json({ success: false, message: "Spotted sem conta vinculada." });

  // 2. Verifica permissão do admin
  if (!req.admin!.is_super && !req.admin!.accountIds.includes(accountId)) {
    return res.status(403).json({ success: false, message: "Sem permissão para esta conta." });
  }

  // 3. Busca conta com campos necessários (inclui base_caption)
  const { data: account, error: accountErr } = await supabase
    .from("instagram_accounts")
    .select("id, username, ig_user_id, access_token_encrypted, connection_status, needs_reauth, template_image_url, base_image_url, text_color, shadow_color, base_caption")
    .eq("id", accountId)
    .single();

  if (accountErr || !account) return res.status(404).json({ success: false, message: "Conta não encontrada." });

  // 4. Valida base_caption obrigatória
  if (!account.base_caption || account.base_caption.trim() === "") {
    return res.status(400).json({ success: false, message: "Legenda base (base_caption) não configurada para esta conta." });
  }

  // 5. Reserva display_id (idempotente: reusa se já reservado)
  let displayId: number;
  try {
    displayId = await spottedRepository.getOrReserveDisplayId(accountId, dbRecord.display_id ?? null);
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }

  // 6. Se era novo, persiste o display_id no post para retry idempotente
  if (!dbRecord.display_id) {
    const { error: dispErr } = await supabase
      .from("spotteds")
      .update({ display_id: displayId })
      .eq("id", id);
    if (dispErr) {
      console.error("[APPROVE] Falha ao gravar display_id:", dispErr.message);
      return res.status(500).json({ success: false, message: "Falha ao reservar número do post." });
    }
  }

  // 7. Busca template
  const templateUrl = account.template_image_url;
  if (!templateUrl) {
    return res.status(400).json({ success: false, message: "Template do card não configurado para esta cidade." });
  }
  let templateBuffer: Buffer;
  try {
    templateBuffer = await fetchTemplateBuffer(templateUrl);
  } catch (e) {
    if (e instanceof TemplateFetchError) {
      console.error("[APPROVE] Template fetch failed:", { code: e.code, status: e.status, message: e.message });
      return res.status(400).json({ success: false, message: "Template da conta inválido, reenvie a imagem base" });
    }
    throw e;
  }

  const theme = resolveTheme(account);
  const hasUserImage = !!dbRecord.image_url;
  const { fileName, postId } = await generateSpottedImage(dbRecord.content, displayId, hasUserImage, templateBuffer, theme);

  // 8. Monta legenda a partir do base_caption do banco
  const instagramCaption = `[${postId}] - ${dbRecord.content}\n\n${account.base_caption}`;

  let instagramMediaId: string | undefined = undefined;
  let creationId: string | undefined = undefined;
  let publishError: Error | null = null;
  let creds: { accessToken: string; igUserId: string } | undefined = undefined;

  // 9. Publica no Instagram (se conectado)
  if (account.connection_status === 'ok' && account.access_token_encrypted) {
    try {
      const accessToken = decrypt(account.access_token_encrypted);
      creds = { accessToken, igUserId: account.ig_user_id };

      const quota = await getPublishingLimit(creds);
      if (quota.remaining <= 0) {
        return res.status(429).json({
          success: false,
          message: `Cota de publicação esgotada (${quota.used}/${quota.limit} nas últimas 24h). Tente mais tarde.`,
        });
      }

      const cardUrl = await storageService.uploadCard(fileName);
      if (!cardUrl) throw new Error("Falha ao enviar card para bucket público.");

      const baseImageUrl = account.base_image_url;
      if (!baseImageUrl) {
        throw new Error("Foto de encerramento não configurada para esta cidade.");
      }

      console.log(`[APPROVE] Publicando no Instagram...`, {
        accountId,
        igUserId: account.ig_user_id,
        username: account.username,
        hasUserImage,
        displayId,
        cardUrl: cardUrl?.slice(0, 100),
        baseImageUrl: baseImageUrl?.slice(0, 100),
      });

      let publishResult: { mediaId: string; creationId: string };

      if (hasUserImage) {
        publishResult = await instagramService.postCarouselWithUserImage(
          cardUrl, dbRecord.image_url!, baseImageUrl, instagramCaption, creds
        );
      } else {
        publishResult = await instagramService.postCarousel(
          cardUrl, baseImageUrl, instagramCaption, creds
        );
      }

      instagramMediaId = publishResult.mediaId;
      creationId = publishResult.creationId;

      console.log(`[APPROVE] Publicado com sucesso! Media ID: ${instagramMediaId}`);
    } catch (igError: any) {
      publishError = igError;
      // Captura creationId do erro (anexado pelo instagramService quando publishMedia falha)
      if (!creationId && igError.creationId) {
        creationId = igError.creationId;
      }
      console.error("Erro ao postar no Instagram:", {
        message: igError.message,
        metaCode: igError.metaCode,
        metaSubcode: igError.metaSubcode,
        metaUserMsg: igError.metaUserMsg,
        metaUserTitle: igError.metaUserTitle,
        httpStatus: igError.httpStatus,
        stack: igError.stack,
      });
      if (igError.isAuthError) {
        await adminRepository.updateConnection(accountId, {
          needs_reauth: true,
          connection_status: 'needs_reauth',
          last_error: igError.message
        });
      }
    }
  }

  // 10. Verifica se publicado mesmo com erro (Meta pode publicar e ainda retornar erro)
  let verifiedMediaId: string | null | undefined = undefined;
  if (publishError && creationId) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        verifiedMediaId = await instagramService.verifyPublished(creationId, instagramCaption, creds!);
      } catch (e) {
        console.warn(`[APPROVE] Falha ao verificar publicação (tentativa ${attempt}/2):`, e);
      }
      if (verifiedMediaId) {
        console.log(`[APPROVE] Publicação confirmada na Meta na tentativa ${attempt}: ${verifiedMediaId}`);
        break;
      }
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  }

  // Log de órfãos se a verificação falhou — para você limpar na Meta
  if (publishError && !verifiedMediaId && creationId) {
    const err = publishError as any;
    if (err.childrenIds?.length) {
      console.error("[APPROVE] Publicação falhou e verificação não encontrou o post. Órfãos na Meta:", {
        creationId,
        childrenIds: err.childrenIds,
      });
    }
  }

  // 11. Atualiza status — SEMPRE roda, mesmo se publishError
  // Se publicou: PUBLISHED com media_id
  // Se falhou: mantém PENDING (não mudou), mas logamos o erro
  // Se não conectado: PUBLISHED sem media_id (fluxo manual?)
  try {
    const finalMediaId = verifiedMediaId || instagramMediaId;
    const didPublish = !!finalMediaId;

    if (!didPublish) {
      // Falhou na publicação e não foi verificado: mantém PENDING
      await supabase.from("spotteds").update({
        reviewed_by: req.admin!.adminId,
        reviewed_at: new Date().toISOString(),
        // status permanece PENDING
      }).eq("id", id);
      return res.status(500).json({ success: false, message: `Erro Instagram: ${publishError!.message}` });
    }

    // Sucesso (verificado ou sem erro): marca PUBLISHED
    await spottedRepository.updateStatus(id, "PUBLISHED", finalMediaId);

    await supabase.from("spotteds").update({
      reviewed_by: req.admin!.adminId,
      reviewed_at: new Date().toISOString()
    }).eq("id", id);

    res.json({ success: true, message: "Post aprovado com sucesso.", postId, instagramMediaId: finalMediaId, displayId });
  } catch (statusErr: any) {
    console.error("[APPROVE] Erro ao atualizar status:", statusErr.message);
    // Se o post foi pro Instagram mas falhou o updateStatus, logamos mas não perdemos o media_id
    const finalMediaId = verifiedMediaId || instagramMediaId;
    return res.status(500).json({
      success: false,
      message: `Post publicado no Instagram (Media ID: ${finalMediaId}) mas falha ao atualizar banco: ${statusErr.message}`
    });
  }
});

// POST /api/admin/reject/:id
router.post("/reject/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    const dbRecord = await spottedRepository.findById(id);
    if (!dbRecord) return res.status(404).json({ success: false, message: "Post não encontrado." });

    const accountId = dbRecord.instagram_account_id;

    // Se o post tem conta, valida permissão normal.
    // Se NÃO tem conta (NULL), só super admin pode rejeitar.
    if (accountId) {
      if (!req.admin!.is_super && !req.admin!.accountIds.includes(accountId)) {
        return res.status(403).json({ success: false, message: "Sem permissão." });
      }
    } else if (!req.admin!.is_super) {
      return res.status(403).json({ success: false, message: "Post sem conta vinculada: apenas super admin pode rejeitar." });
    }

    await spottedRepository.updateStatus(id, "BLOCKED");

    if (!supabase) throw new Error("Supabase não configurado.");
    await supabase.from("spotteds").update({
      reviewed_by: req.admin!.adminId,
      reviewed_at: new Date().toISOString()
    }).eq("id", id);

    res.json({ success: true, message: "Post rejeitado com sucesso." });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/admin/preview
// Gera um preview de como o card vai ficar para uma dada conta e texto.
router.post("/preview", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { accountId, content } = req.body;
    if (!accountId || !content) {
      return res.status(400).json({ success: false, message: "accountId e content são obrigatórios." });
    }

    if (!req.admin!.is_super && !req.admin!.accountIds.includes(accountId)) {
      return res.status(403).json({ success: false, message: "Sem permissão." });
    }

    if (!supabase) throw new Error("Supabase não configurado.");
    const { data: account } = await supabase
      .from("instagram_accounts")
      .select("template_image_url, text_color, shadow_color")
      .eq("id", accountId)
      .single();

    if (!account || !account.template_image_url) {
      return res.status(400).json({ success: false, message: "Template do card não configurado para esta cidade." });
    }

    // Baixa template da URL pública
    let templateBuffer: Buffer;
    try {
      templateBuffer = await fetchTemplateBuffer(account.template_image_url!);
    } catch (e) {
      if (e instanceof TemplateFetchError) {
        console.error("[PREVIEW] Template fetch failed:", { code: e.code, status: e.status, message: e.message });
        return res.status(400).json({ success: false, message: "Template da conta inválido, reenvie a imagem base" });
      }
      throw e;
    }

    const theme = resolveTheme(account);

    // Preview não escreve nada em disco: pede o buffer direto ao imageService.
    const buffer = await generateSpottedImageBuffer(content, 9999, false, templateBuffer, theme);

    return res.json({ success: true, imageBase64: `data:image/jpeg;base64,${buffer.toString("base64")}` });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;