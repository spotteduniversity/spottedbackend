/**
 * instagramService.ts
 *
 * Serviço de integração com a Instagram Graph API.
 *
 * MUDANÇA PRINCIPAL: o accessToken e igUserId não são mais globais (process.env).
 * São passados como parâmetro em cada chamada, permitindo múltiplas contas simultâneas.
 *
 * Fluxo de publicação (CAROUSEL):
 * 1. Criar containers individuais para cada imagem (is_carousel_item = true)
 * 2. Criar um container de carrossel referenciando os containers filhos
 * 3. Publicar o carrossel no perfil
 *
 * Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing#carousel-posts
 */

const GRAPH_API_URL = "https://graph.facebook.com/v23.0";

/**
 * Posição da imagem do usuário no carrossel.
 * 1 = primeiro slide (antes do card de texto)
 * 2 = segundo slide (depois do card de texto)
 */
const USER_IMAGE_SLIDE_POSITION: number = 2;

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface IgCredentials {
  accessToken: string;
  igUserId: string;
}

export interface PublishingLimit {
  /** Posts já publicados na janela atual. */
  used: number;
  /** Total permitido na janela (25 por padrão). */
  limit: number;
  remaining: number;
}

/**
 * Consulta a cota de publicação da conta (25 posts / 24h por padrão).
 *
 * Sem isso, estourar a cota só aparece como erro críptico no meio do fluxo de
 * carrossel, depois de o card já ter sido gerado e enviado ao Storage.
 *
 * A Meta devolve `quota_usage` como string no formato "usado, limite".
 * Se o parsing falhar, logamos e assumimos que há cota disponível — a
 * publicação em si falhará com erro claro da Meta se a cota estiver esgotada.
 */
export async function getPublishingLimit(
  creds: IgCredentials
): Promise<PublishingLimit> {
  const url =
    `${GRAPH_API_URL}/${creds.igUserId}/content_publishing_limit` +
    `?fields=quota_usage,config&access_token=${encodeURIComponent(creds.accessToken)}`;

  const res = await fetch(url);
  const data = (await res.json()) as any;

  if (data.error) {
    // Se a Meta devolver erro, não bloqueamos — deixamos a publicação tentar
    // e falhar com a mensagem real dela.
    console.warn(
      `[QUOTA] Erro da Meta ao consultar cota (continuando): ${data.error.message} (code ${data.error.code})`,
      { subcode: data.error.error_subcode, retorno: JSON.stringify(data).slice(0, 300) }
    );
    return { used: 0, limit: 25, remaining: 25 };
  }

  const raw = data?.data?.[0]?.quota_usage;
  if (raw === undefined || raw === null || raw === "") {
    console.warn("[QUOTA] quota_usage ausente — assumindo cota disponível", {
      retorno: JSON.stringify(data).slice(0, 300),
    });
    return { used: 0, limit: 25, remaining: 25 };
  }

  const used = Number(raw);
  const limit = Number(data?.data?.[0]?.config?.quota_total ?? 25);

  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) {
    console.warn(`[QUOTA] quota_usage em formato inesperado: "${raw}" — assumindo cota disponível`);
    return { used: 0, limit: 25, remaining: 25 };
  }

  return { used, limit, remaining: Math.max(0, limit - used) };
}

/**
 * Confere se o par (IG User ID, access token) é válido para publicar.
 *
 * Faz o GET mais barato possível — só `username` — o que serve a dois
 * propósitos de uma vez: confirma que o token existe e que enxerga aquela
 * conta, e devolve o @username real para o painel não depender do admin
 * digitar certo.
 *
 * Lança em qualquer erro da Meta; a mensagem chega ao admin.
 */
export async function verifyInstagramCredentials(
  igUserId: string,
  accessToken: string
): Promise<string> {
  const url =
    `${GRAPH_API_URL}/${igUserId}?fields=username` +
    `&access_token=${encodeURIComponent(accessToken)}`;

  const res = await fetch(url);
  const data = (await res.json()) as any;

  if (data.error) {
    throw new Error(`${data.error.message} (code ${data.error.code})`);
  }

  if (typeof data.username !== "string" || !data.username) {
    throw new Error("a Meta não devolveu username para esse IG User ID.");
  }

  return data.username;
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Remove o access_token de qualquer payload antes de escrever no log.
 * Sem isso o token fica em plaintext no arquivo de log e no console.
 */
function redactSecrets(body: Record<string, unknown>): Record<string, unknown> {
  const safe = { ...body };
  for (const key of ["access_token", "creation_id", "client_secret"]) {
    if (key in safe) safe[key] = "***redacted***";
  }
  return safe;
}

/**
 * Serializa o body como application/x-www-form-urlencoded.
 * É o formato que a documentação da Meta usa em todos os exemplos (curl -d).
 * Arrays viram lista separada por vírgula, como a API espera.
 */
function encodeForm(body: Record<string, unknown>): string {
  return new URLSearchParams(
    Object.entries(body).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(",") : String(value),
    ])
  ).toString();
}

/**
 * Chama a Meta API e lança erro com isolamento: erros de token/auth
 * marcam a conta, mas não propagam para outras contas.
 */
async function metaPost(
  url: string,
  body: Record<string, unknown>,
  context: string = "",
  encoding: "json" | "form" = "json"
): Promise<any> {
  const logPrefix = context ? `[${context}] ` : "";
  const tStart = Date.now();
  console.log(`[META][${context || "UNKNOWN"}] REQUEST_START | url=${url} | encoding=${encoding} | at=${new Date().toISOString()}`);
  console.log(`[META][${context || "UNKNOWN"}] REQUEST_BODY | ${JSON.stringify(redactSecrets(body))}`);
  if (context === "createCarouselContainer") {
    console.log(`[IG][CAROUSEL] CONTAINER_CREATE_ATTEMPT_START | children=${Array.isArray(body.children) ? (body.children as string[]).join(",") : body.children} | media_type=${body.media_type} | caption_len=${typeof body.caption === "string" ? body.caption.length : 0} | encoding=${encoding}`);
  }

  const isForm = encoding === "form";
  const response = await fetch(url, {
    method: "POST",
    headers: isForm
      ? { "Content-Type": "application/x-www-form-urlencoded" }
      : { "Content-Type": "application/json" },
    body: isForm ? encodeForm(body) : JSON.stringify(body),
  });

  // Loga o uso de rate limit se disponível (header X-Business-Use-Case-Usage)
  const usageHeader = response.headers.get("X-Business-Use-Case-Usage");
  if (usageHeader) {
    try {
      const usage = JSON.parse(usageHeader);
      const entries = Object.values(usage).flat() as any[];
      for (const entry of entries) {
        if (entry.call_count > 80) {
          console.warn(`⚠️ [META] Taxa de uso alta: ${entry.call_count}% para ${entry.type}`);
        }
      }
    } catch {
      // ignora falha no parse do header
    }
  }

  const data = await response.json();

  console.log(`[META][${context || "UNKNOWN"}] RESPONSE | status=${response.status} ${response.statusText} | +${Date.now() - tStart}ms | headers_content_type=${response.headers.get("content-type")} | body=${JSON.stringify(data).slice(0, 1500)}`);
  if (context === "createCarouselContainer") {
    console.log(`[IG][CAROUSEL] CONTAINER_CREATE_ATTEMPT_END | id=${data?.id} | full=${JSON.stringify(data)}`);
  }

  if (data.error) {
    const { message, code, error_subcode, error_user_msg, error_user_title, is_transient } = data.error;
    const err = new Error(`Instagram API Error: ${message}`) as any;
    err.metaCode = code;
    err.metaSubcode = error_subcode;
    err.metaUserMsg = error_user_msg;
    err.metaUserTitle = error_user_title;
    err.httpStatus = response.status;
    // A Meta sinaliza falhas temporárias (ex: container não pronto ainda).
    // Serve para decidir se vale repetir a chamada.
    err.isTransient = is_transient === true;
    // Códigos de token inválido/expirado da Meta: 190, 102, 463, 467
    err.isAuthError = [190, 102, 463, 467].includes(code);
    console.error(`[META][${context || "UNKNOWN"}] ERROR | message=${message} | code=${code} | subcode=${error_subcode} | is_transient=${is_transient} | error_user_msg=${error_user_msg} | error_user_title=${error_user_title} | httpStatus=${response.status} | fbtrace_id=${(data.error as any).fbtrace_id || ""} | full=${JSON.stringify(data)}`);
    throw err;
  }

  return data;
}

// ─── Helpers: aguardar media ficar FINISHED ─────────────────────────────────────

/**
 * Aguarda um media container ficar com status FINISHED.
 * A Meta exige que itens do carrossel estejam processados antes de criar o container.
 *
 * Pedimos `status` junto com `status_code` porque a Meta só diz o motivo da
 * falha no campo `status` (ex.: "Error: Media upload has failed with error
 * code 2207053"). Sem ele, um status ERROR chega sem explicação nenhuma.
 */
async function waitForMediaReady(
  mediaId: string,
  creds: IgCredentials,
  maxAttempts: number = 12,
  intervalMs: number = 3000,
  label: string = ""
): Promise<void> {
  const startedAt = Date.now();
  const lbl = label ? `[${label}]` : "";
  console.log(`[IG][WAIT] ${lbl} START | mediaId=${mediaId} | igUserId=${creds.igUserId} | maxAttempts=${maxAttempts} | intervalMs=${intervalMs}`);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const elapsed = Date.now() - startedAt;
    const url = `${GRAPH_API_URL}/${mediaId}?fields=status_code,status&access_token=${encodeURIComponent(creds.accessToken)}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      console.error(`[IG][WAIT] ${lbl} API_ERROR | mediaId=${mediaId} | attempt=${attempt}/${maxAttempts} | +${elapsed}ms | error=${JSON.stringify(data.error)}`);
      throw new Error(`Meta (status): ${data.error.message} (code ${data.error.code})`);
    }

    const statusCode = data.status_code;
    const detail = typeof data.status === "string" ? data.status : "";
    console.log(
      `[IG][WAIT] ${lbl} POLL | mediaId=${mediaId} | attempt=${attempt}/${maxAttempts} | +${elapsed}ms | status_code=${statusCode} | status="${detail || "(empty)"}" | raw=${JSON.stringify(data).slice(0, 600)}`
    );

    if (statusCode === "FINISHED") {
      console.log(`[IG][WAIT] ${lbl} FINISHED | mediaId=${mediaId} | totalWait=${Date.now() - startedAt}ms | attempts=${attempt}`);
      return;
    }

    if (statusCode === "ERROR") {
      // O campo `status` é a única fonte da causa real do erro.
      const motivo = detail
        ? `Motivo informado pela Meta: ${detail}`
        : "A Meta nao informou o motivo (campo `status` veio vazio).";
      console.error(`[IG][WAIT] ${lbl} ERROR_FATAL | mediaId=${mediaId} | totalWait=${Date.now() - startedAt}ms | attempts=${attempt} | detail="${detail || "(empty)"}" | fullData=${JSON.stringify(data)}`);
      throw new Error(`Media ${mediaId} falhou no processamento. ${motivo}`);
    }

    // Container expirado: recriar é a única saida, a Meta não recycle.
    if (statusCode === "EXPIRED") {
      console.error(`[IG][WAIT] ${lbl} EXPIRED | mediaId=${mediaId} | totalWait=${Date.now() - startedAt}ms | attempts=${attempt} | fullData=${JSON.stringify(data)}`);
      throw new Error(`Media ${mediaId} expirou antes de ficar pronto. E necessario recriar o container.`);
    }

    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  console.error(`[IG][WAIT] ${lbl} TIMEOUT | mediaId=${mediaId} | totalWait=${Date.now() - startedAt}ms | maxAttempts=${maxAttempts}`);
  throw new Error(`Timeout aguardando media ${mediaId} ficar pronto (${maxAttempts * intervalMs / 1000}s)`);
}

// ─── Serviço ──────────────────────────────────────────────────────────────────

export const instagramService = {
  /**
   * Cria um container de item do carrossel (cada imagem individual).
   */
  async createCarouselItem(imageUrl: string, creds: IgCredentials): Promise<string> {
    const url = `${GRAPH_API_URL}/${creds.igUserId}/media`;
    console.log(`[IG][ITEM] CREATE_START | igUserId=${creds.igUserId} | imageUrl=${imageUrl}`);
    const data = await metaPost(url, {
      image_url: imageUrl,
      is_carousel_item: true,
      access_token: creds.accessToken,
    }, "createCarouselItem");

    const itemId = typeof data?.id === "string" ? data.id.trim() : "";
    if (!itemId || !/^\d+$/.test(itemId)) {
      console.error(`[IG][ITEM] CREATE_INVALID_ID | imageUrl=${imageUrl} | data=${JSON.stringify(data)}`);
      throw new Error(`A Meta nao devolveu um id valido para o item do carrossel (id="${itemId || "vazio"}").`);
    }

    console.log(`[IG][ITEM] CREATE_END | itemId=${itemId} | imageUrl=${imageUrl}`);
    console.log(`📦 Item do carrossel criado: ${itemId}`);
    return itemId;
  },

  /**
   * Cria o container do carrossel referenciando os items filhos.
   */
  async createCarouselContainer(
    childrenIds: string[],
    caption: string,
    creds: IgCredentials
  ): Promise<string> {
    const url = `${GRAPH_API_URL}/${creds.igUserId}/media`;
    const tStart = Date.now();

    console.log(`[IG][CAROUSEL] CREATE_CONTAINER_START | igUserId=${creds.igUserId} | children=[${childrenIds.join(", ")}] | caption_len=${caption.length} | caption_preview=${caption.slice(0, 60).replace(/\n/g, "\\n")}`);

    // TESTE TEMPORÁRIO: sanitizar legenda para isolar causa 2207032
    let testCaption = caption;
    try {
      const cleaned = caption
        .replace(/#[^\s#]+/g, "")
        .replace(/@[^\s@]+/g, "")
        .replace(/\r\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
      if (cleaned && cleaned !== caption) {
        console.log(`[IG][CAROUSEL] CAPTION_CLEANED | before="${caption.slice(0, 80).replace(/\n/g, "\\n")}" | after="${cleaned.slice(0, 80).replace(/\n/g, "\\n")}" | len_before=${caption.length} | len_after=${cleaned.length}`);
        testCaption = cleaned;
      } else if (!cleaned) {
        console.log(`[IG][CAROUSEL] CAPTION_CLEANED_EMPTY | keeping_original_preview="${caption.slice(0, 40).replace(/\n/g, "\\n")}"`);
        testCaption = caption.slice(0, 100).trim() || caption;
      }
    } catch (e: any) {
      console.warn(`[IG][CAROUSEL] CAPTION_CLEAN_FAILED | ${e.message}`);
      testCaption = caption;
    }

    // Tentar com JSON primeiro (mais alinhado com documentação atual)
    try {
      const data = await metaPost(url, {
        media_type: "CAROUSEL",
        children: childrenIds,
        caption: testCaption,
        access_token: creds.accessToken,
      }, "createCarouselContainer", "json");

      let containerId = typeof data?.id === "string" ? data.id.trim() : "";
      console.log(`[IG][CAROUSEL] JSON_ATTEMPT | response_id=${containerId} | full=${JSON.stringify(data)}`);

      if (containerId && containerId !== "0" && /^\d+$/.test(containerId)) {
        console.log(`[IG][CAROUSEL] CREATE_CONTAINER_END | containerId=${containerId} | totalMs=${Date.now() - tStart} | method=json`);
        console.log(`🎠 Container do carrossel criado: ${containerId}`);
        return containerId;
      }

      console.warn(`[IG][CAROUSEL] JSON_RETURNED_INVALID_ID | id=${containerId} | full=${JSON.stringify(data)}`);
    } catch (e: any) {
      console.warn(`[IG][CAROUSEL] JSON_ATTEMPT_FAILED | error=${e.message}`);
    }

    // Fallback para form-urlencoded com string separada por vírgula
    const childrenStr = childrenIds.join(",");
    console.log(`[IG][CAROUSEL] FALLBACK_FORM_START | childrenStr=${childrenStr}`);
    let data = await metaPost(url, {
      media_type: "CAROUSEL",
      children: childrenStr,
      caption: testCaption,
      access_token: creds.accessToken,
    }, "createCarouselContainer", "form");

    let containerId = typeof data?.id === "string" ? data.id.trim() : "";
    console.log(`[IG][CAROUSEL] FORM_ATTEMPT | response_id=${containerId} | full=${JSON.stringify(data)}`);

    // Se vier id:"0", NÃO usar o retry com URLSearchParams (container nasce corrompido)
    // Tentar novamente com form após pequeno delay
    if (!containerId || containerId === "0") {
      console.warn(`[IG][CAROUSEL] ID_ZERO_DETECTED | not_using_urlsearchparams_fallback | waiting_2000ms`);
      await new Promise((r) => setTimeout(r, 2000));
      
      console.log(`[IG][CAROUSEL] RETRY_FORM_AFTER_DELAY | childrenStr=${childrenStr}`);
      data = await metaPost(url, {
        media_type: "CAROUSEL",
        children: childrenStr,
        caption: testCaption,
        access_token: creds.accessToken,
      }, "createCarouselContainer", "form");
      
      containerId = typeof data?.id === "string" ? data.id.trim() : "";
      console.log(`[IG][CAROUSEL] RETRY_FORM_RESPONSE | response_id=${containerId} | full=${JSON.stringify(data)}`);
    }

    if (!containerId || containerId === "0" || !/^\d+$/.test(containerId)) {
      console.error(`[IG][CAROUSEL] CREATE_CONTAINER_INVALID | finalContainerId=${containerId || "empty"} | children=${childrenStr} | lastData=${JSON.stringify(data)}`);
      throw new Error(
        `A Meta nao devolveu um container de carrossel valido (id="${containerId || "vazio"}"). ` +
        `Sem isso nao da para publicar.`
      );
    }

    console.log(`[IG][CAROUSEL] CREATE_CONTAINER_END | containerId=${containerId} | totalMs=${Date.now() - tStart}`);
    console.log(`🎠 Container do carrossel criado: ${containerId}`);
    return containerId;
  },

  /**
   * Publica o container no perfil.
   */
  async publishMedia(creationId: string, creds: IgCredentials): Promise<string> {
    const url = `${GRAPH_API_URL}/${creds.igUserId}/media_publish`;
    console.log(`[IG][PUBLISH] PUBLISH_START | igUserId=${creds.igUserId} | creationId=${creationId}`);
    const data = await metaPost(url, {
      creation_id: creationId,
      access_token: creds.accessToken,
    }, "publishMedia");
    console.log(`[IG][PUBLISH] PUBLISH_END | creationId=${creationId} | mediaId=${data.id}`);
    console.log(`🎉 Carrossel publicado no Instagram! Media ID: ${data.id}`);
    return data.id;
  },

  /**
   * Verifica se um creation_id já virou post publicado na Meta.
   * Consulta o feed da conta (/{igUserId}/media) e casa pelo caption,
   * que é único por post (contém o display_id no formato "[N] - ...").
   * Retorna o media_id se publicado, null se não.
   */
  async verifyPublished(creationId: string, caption: string, creds: IgCredentials): Promise<string | null> {
    try {
      const url = `${GRAPH_API_URL}/${creds.igUserId}/media?fields=id,permalink,media_type,caption&limit=5&access_token=${encodeURIComponent(creds.accessToken)}`;
      const res = await fetch(url);
      const data = await res.json();

      if (data.error) {
        console.warn(`[VERIFY] Erro ao buscar feed: ${data.error.message} (code ${data.error.code})`);
        return null;
      }

      const mediaList = data.data || [];
      const match = mediaList.find((m: any) => m.caption && m.caption.includes(caption));

      if (match && match.id) {
        console.log(`✅ [VERIFY] Post confirmado no feed: ${match.id} (permalink: ${match.permalink})`);
        return match.id;
      }

      return null;
    } catch (e: any) {
      console.warn(`[VERIFY] Falha ao checar ${creationId}:`, e.message);
      return null;
    }
  },

  /**
   * Fluxo completo de carrossel com 2 slides:
   * Slide 1 → card do spotted (texto)
   * Slide 2 → imagem base (branding da cidade)
   */
  async postCarousel(
    cardImageUrl: string,
    baseImageUrl: string,
    caption: string,
    creds: IgCredentials
  ): Promise<{ mediaId: string; creationId: string }> {
    const tFlow = Date.now();
    console.log(`[IG][FLOW] POST_CAROUSEL_START | igUserId=${creds.igUserId} | cardUrl=${cardImageUrl} | baseUrl=${baseImageUrl} | caption_len=${caption.length}`);
    const cardItemId = await this.createCarouselItem(cardImageUrl, creds);
    console.log(`[IG][FLOW] +${Date.now() - tFlow}ms AFTER_CREATE_CARD_ITEM | cardItemId=${cardItemId}`);
    await waitForMediaReady(cardItemId, creds, 12, 3000, "CARD_ITEM");
    console.log(`[IG][FLOW] +${Date.now() - tFlow}ms AFTER_WAIT_CARD_ITEM`);

    console.log(`[IG][FLOW] INTERVAL_START | kind=between_items | +${Date.now() - tFlow}ms`);
    console.log("⏱️ Intervalo entre uploads pro Instagram...");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    console.log(`[IG][FLOW] INTERVAL_END | kind=between_items | +${Date.now() - tFlow}ms`);

    const baseItemId = await this.createCarouselItem(baseImageUrl, creds);
    console.log(`[IG][FLOW] +${Date.now() - tFlow}ms AFTER_CREATE_BASE_ITEM | baseItemId=${baseItemId}`);
    await waitForMediaReady(baseItemId, creds, 12, 3000, "BASE_ITEM");
    console.log(`[IG][FLOW] +${Date.now() - tFlow}ms AFTER_WAIT_BASE_ITEM`);

    console.log(`[IG][FLOW] INTERVAL_START | kind=before_container | +${Date.now() - tFlow}ms`);
    console.log("⏱️ Aguardando 3s para os containers serem indexados na Meta...");
    await new Promise((resolve) => setTimeout(resolve, 3000));
    console.log(`[IG][FLOW] INTERVAL_END | kind=before_container | +${Date.now() - tFlow}ms`);

    const carouselId = await this.createCarouselContainer(
      [cardItemId, baseItemId],
      caption,
      creds
    );
    console.log(`[IG][FLOW] +${Date.now() - tFlow}ms AFTER_CREATE_CAROUSEL_CONTAINER | carouselId=${carouselId}`);

    // O container pai tambem passa por processamento antes de poder ser publicado.
    await waitForMediaReady(carouselId, creds, 12, 3000, "CAROUSEL_CONTAINER");
    console.log(`[IG][FLOW] +${Date.now() - tFlow}ms AFTER_WAIT_CAROUSEL_CONTAINER`);

    let mediaId: string;
    try {
      mediaId = await this.publishMedia(carouselId, creds);
    } catch (e: any) {
      e.creationId = carouselId;
      e.childrenIds = [cardItemId, baseItemId];
      throw e;
    }
    console.log(`[IG][FLOW] POST_CAROUSEL_END | totalMs=${Date.now() - tFlow} | mediaId=${mediaId} | creationId=${carouselId}`);
    return { mediaId, creationId: carouselId };
  },

  /**
   * Fluxo completo de carrossel com 3 slides (inclui imagem do usuário).
   */
  async postCarouselWithUserImage(
    cardImageUrl: string,
    userImageUrl: string,
    baseImageUrl: string,
    caption: string,
    creds: IgCredentials
  ): Promise<{ mediaId: string; creationId: string }> {
    const tFlow = Date.now();
    console.log(`[IG][FLOW] POST_CAROUSEL_WITH_USER_START | igUserId=${creds.igUserId} | cardUrl=${cardImageUrl} | userUrl=${userImageUrl} | baseUrl=${baseImageUrl} | caption_len=${caption.length} | userSlidePos=${USER_IMAGE_SLIDE_POSITION}`);
    const cardItemId = await this.createCarouselItem(cardImageUrl, creds);
    console.log(`[IG][FLOW] +${Date.now() - tFlow}ms AFTER_CREATE_CARD_ITEM | cardItemId=${cardItemId}`);
    await waitForMediaReady(cardItemId, creds, 12, 3000, "CARD_ITEM");

    console.log(`[IG][FLOW] INTERVAL_START | kind=between_items1 | +${Date.now() - tFlow}ms`);
    console.log("⏱️ Intervalo entre uploads pro Instagram (1)...");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    console.log(`[IG][FLOW] INTERVAL_END | kind=between_items1 | +${Date.now() - tFlow}ms`);

    const userImageItemId = await this.createCarouselItem(userImageUrl, creds);
    console.log(`[IG][FLOW] +${Date.now() - tFlow}ms AFTER_CREATE_USER_ITEM | userImageItemId=${userImageItemId}`);
    await waitForMediaReady(userImageItemId, creds, 12, 3000, "USER_ITEM");

    console.log(`[IG][FLOW] INTERVAL_START | kind=between_items2 | +${Date.now() - tFlow}ms`);
    console.log("⏱️ Intervalo entre uploads pro Instagram (2)...");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    console.log(`[IG][FLOW] INTERVAL_END | kind=between_items2 | +${Date.now() - tFlow}ms`);

    const baseItemId = await this.createCarouselItem(baseImageUrl, creds);
    console.log(`[IG][FLOW] +${Date.now() - tFlow}ms AFTER_CREATE_BASE_ITEM | baseItemId=${baseItemId}`);
    await waitForMediaReady(baseItemId, creds, 12, 3000, "BASE_ITEM");

    console.log(`[IG][FLOW] INTERVAL_START | kind=before_container | +${Date.now() - tFlow}ms`);
    console.log("⏱️ Aguardando 1.5s para os containers serem indexados na Meta...");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    console.log(`[IG][FLOW] INTERVAL_END | kind=before_container | +${Date.now() - tFlow}ms`);

    const children =
      USER_IMAGE_SLIDE_POSITION === 1
        ? [userImageItemId, cardItemId, baseItemId]
        : [cardItemId, userImageItemId, baseItemId];

    const carouselId = await this.createCarouselContainer(children, caption, creds);
    console.log(`[IG][FLOW] +${Date.now() - tFlow}ms AFTER_CREATE_CAROUSEL_CONTAINER | carouselId=${carouselId} | children=${children.join(",")}`);

    // O container pai tambem passa por processamento antes de poder ser publicado.
    await waitForMediaReady(carouselId, creds, 12, 3000, "CAROUSEL_CONTAINER");
    console.log(`[IG][FLOW] +${Date.now() - tFlow}ms AFTER_WAIT_CAROUSEL_CONTAINER`);

    let mediaId: string;
    try {
      mediaId = await this.publishMedia(carouselId, creds);
    } catch (e: any) {
      e.creationId = carouselId;
      e.childrenIds = children;
      throw e;
    }
    console.log(`[IG][FLOW] POST_CAROUSEL_WITH_USER_END | totalMs=${Date.now() - tFlow} | mediaId=${mediaId} | creationId=${carouselId}`);
    return { mediaId, creationId: carouselId };
  },

  /**
   * Publica um Story no Instagram.
   */
  async postStory(imageUrl: string, creds: IgCredentials): Promise<string> {
    const createUrl = `${GRAPH_API_URL}/${creds.igUserId}/media`;
    const createData = await metaPost(createUrl, {
      image_url: imageUrl,
      media_type: "STORIES",
      access_token: creds.accessToken,
    }, "postStory");

    console.log(`📦 Container do Story criado: ${createData.id}`);

    await new Promise((resolve) => setTimeout(resolve, 3000));

    return this.publishMedia(createData.id, creds);
  },
};
