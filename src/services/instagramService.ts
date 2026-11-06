/**
 * instagramService.ts
 *
 * Serviço de integração com a Instagram Graph API.
 *
 * O accessToken e o igUserId são passados como parâmetro em cada chamada
 * (nada de process.env global), permitindo múltiplas contas simultâneas.
 *
 * Fluxo de publicação (CAROUSEL):
 * 1. Criar containers individuais para cada imagem (is_carousel_item = true)
 * 2. Criar um container de carrossel referenciando os containers filhos
 * 3. Publicar o carrossel no perfil
 *
 * Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing#carousel-posts
 */

const GRAPH_API_URL = "https://graph.facebook.com/v23.0";

/** Tempo máximo de cada requisição à Meta. Sem isso, um fetch travado trava o fluxo inteiro. */
const FETCH_TIMEOUT_MS = 30_000;

/** Pausa entre o upload de um item e o próximo. */
const DELAY_BETWEEN_ITEMS_MS = 1500;

/** Pausa antes de criar o container pai, depois de todos os itens estarem FINISHED. */
const DELAY_BEFORE_CONTAINER_MS = 1500;

/** Códigos de token inválido/expirado da Meta. */
const AUTH_ERROR_CODES = [190, 102, 463, 467];

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

/** Erro devolvido pela Meta, com os campos úteis para decidir o que fazer. */
export class MetaApiError extends Error {
  metaCode?: number;
  metaSubcode?: number;
  metaUserMsg?: string;
  metaUserTitle?: string;
  httpStatus?: number;
  /** A Meta marcou a falha como temporária (vale repetir). */
  isTransient = false;
  /** Token inválido/expirado: a conta precisa ser reconectada. */
  isAuthError = false;
  /** Preenchidos quando a publicação falha, para o chamador poder verificar/retomar. */
  creationId?: string;
  childrenIds?: string[];

  constructor(message: string) {
    super(message);
    this.name = "MetaApiError";
  }
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function toMetaError(error: any, httpStatus: number): MetaApiError {
  const err = new MetaApiError(`Instagram API Error: ${error.message}`);
  err.metaCode = error.code;
  err.metaSubcode = error.error_subcode;
  err.metaUserMsg = error.error_user_msg;
  err.metaUserTitle = error.error_user_title;
  err.httpStatus = httpStatus;
  err.isTransient = error.is_transient === true;
  err.isAuthError = AUTH_ERROR_CODES.includes(error.code);
  return err;
}

/** id válido = string numérica diferente de "0". */
function isValidId(id: unknown): id is string {
  return typeof id === "string" && /^\d+$/.test(id.trim()) && id.trim() !== "0";
}

function requireValidId(data: any, what: string): string {
  if (!isValidId(data?.id)) {
    console.error(`[IG] INVALID_ID | what=${what} | data=${JSON.stringify(data)}`);
    throw new Error(`A Meta nao devolveu um id valido para ${what} (id="${data?.id || "vazio"}").`);
  }
  return data.id.trim();
}

/** fetch com timeout, devolvendo o JSON. Falha com mensagem clara se a resposta não for JSON. */
async function fetchJson(
  url: string,
  init: RequestInit = {}
): Promise<{ data: any; response: Response }> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Resposta da Meta nao e JSON (HTTP ${response.status} ${response.statusText}).`);
  }
  return { data, response };
}

/** GET na Graph API. Lança MetaApiError se a Meta devolver `error`. */
async function metaGet(
  path: string,
  fields: string,
  accessToken: string,
  extraQuery: string = ""
): Promise<any> {
  const url =
    `${GRAPH_API_URL}/${path}?fields=${fields}${extraQuery}` +
    `&access_token=${encodeURIComponent(accessToken)}`;
  const { data, response } = await fetchJson(url);
  if (data.error) throw toMetaError(data.error, response.status);
  return data;
}

/**
 * Remove segredos de um payload antes de escrever no log.
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
 * Serializa o body como application/x-www-form-urlencoded (formato dos
 * exemplos da documentação da Meta). Arrays viram lista separada por vírgula.
 */
function encodeForm(body: Record<string, unknown>): string {
  return new URLSearchParams(
    Object.entries(body).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(",") : String(value),
    ])
  ).toString();
}

function warnOnHighUsage(response: Response): void {
  const header = response.headers.get("X-Business-Use-Case-Usage");
  if (!header) return;
  try {
    const entries = Object.values(JSON.parse(header)).flat() as any[];
    for (const entry of entries) {
      if (entry.call_count > 80) {
        console.warn(`⚠️ [META] Taxa de uso alta: ${entry.call_count}% para ${entry.type}`);
      }
    }
  } catch {
    // header malformado: ignora
  }
}

/** POST na Graph API. Lança MetaApiError se a Meta devolver `error`. */
async function metaPost(
  url: string,
  body: Record<string, unknown>,
  context: string,
  encoding: "json" | "form" = "json"
): Promise<any> {
  const tStart = Date.now();
  const isForm = encoding === "form";
  console.log(`[META][${context}] REQUEST | url=${url} | encoding=${encoding} | body=${JSON.stringify(redactSecrets(body))}`);

  const { data, response } = await fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": isForm ? "application/x-www-form-urlencoded" : "application/json" },
    body: isForm ? encodeForm(body) : JSON.stringify(body),
  });

  warnOnHighUsage(response);
  console.log(`[META][${context}] RESPONSE | status=${response.status} | +${Date.now() - tStart}ms | body=${JSON.stringify(data).slice(0, 1500)}`);

  if (data.error) {
    const err = toMetaError(data.error, response.status);
    console.error(`[META][${context}] ERROR | code=${err.metaCode} | subcode=${err.metaSubcode} | transient=${err.isTransient} | user_msg=${err.metaUserMsg} | fbtrace_id=${data.error.fbtrace_id || ""} | message=${data.error.message}`);
    throw err;
  }

  return data;
}

/**
 * Aguarda um media container ficar com status FINISHED.
 * A Meta exige que itens do carrossel estejam processados antes de criar o container.
 *
 * Pedimos `status` junto com `status_code` porque a Meta só diz o motivo da
 * falha no campo `status` (ex.: "Error: Media upload has failed with error
 * code 2207053").
 */
async function waitForMediaReady(
  mediaId: string,
  creds: IgCredentials,
  label: string,
  maxAttempts: number = 12,
  intervalMs: number = 3000
): Promise<void> {
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const data = await metaGet(mediaId, "status_code,status", creds.accessToken);
    const statusCode = data.status_code;
    const detail = typeof data.status === "string" ? data.status : "";

    console.log(`[IG][WAIT][${label}] mediaId=${mediaId} | attempt=${attempt}/${maxAttempts} | +${Date.now() - startedAt}ms | status_code=${statusCode} | status="${detail}"`);

    if (statusCode === "FINISHED") return;

    if (statusCode === "ERROR") {
      const motivo = detail
        ? `Motivo informado pela Meta: ${detail}`
        : "A Meta nao informou o motivo (campo `status` veio vazio).";
      throw new Error(`Media ${mediaId} (${label}) falhou no processamento. ${motivo}`);
    }

    if (statusCode === "EXPIRED") {
      throw new Error(`Media ${mediaId} (${label}) expirou antes de ficar pronto. E necessario recriar o container.`);
    }

    if (attempt < maxAttempts) await sleep(intervalMs);
  }

  throw new Error(`Timeout aguardando media ${mediaId} (${label}) ficar pronto (${(maxAttempts * intervalMs) / 1000}s)`);
}

// ─── Consultas ────────────────────────────────────────────────────────────────

/**
 * Consulta a cota de publicação da conta (25 posts / 24h por padrão).
 *
 * Sem isso, estourar a cota só aparece como erro críptico no meio do fluxo de
 * carrossel, depois de o card já ter sido gerado e enviado ao Storage.
 *
 * Se a consulta falhar ou vier em formato inesperado, logamos e assumimos que
 * há cota — a publicação em si falhará com erro claro da Meta se esgotou.
 */
export async function getPublishingLimit(creds: IgCredentials): Promise<PublishingLimit> {
  const fallback: PublishingLimit = { used: 0, limit: 25, remaining: 25 };

  let data: any;
  try {
    data = await metaGet(`${creds.igUserId}/content_publishing_limit`, "quota_usage,config", creds.accessToken);
  } catch (e: any) {
    console.warn(`[QUOTA] Erro ao consultar cota (continuando): ${e.message}`);
    return fallback;
  }

  const entry = data?.data?.[0];
  const used = Number(entry?.quota_usage);
  const limit = Number(entry?.config?.quota_total ?? 25);

  if (entry?.quota_usage == null || !Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) {
    console.warn("[QUOTA] quota_usage ausente ou em formato inesperado — assumindo cota disponível", {
      retorno: JSON.stringify(data).slice(0, 300),
    });
    return fallback;
  }

  return { used, limit, remaining: Math.max(0, limit - used) };
}

/**
 * Confere se o par (IG User ID, access token) é válido para publicar.
 *
 * Faz o GET mais barato possível — só `username` — o que confirma que o token
 * existe e enxerga aquela conta, e devolve o @username real para o painel não
 * depender do admin digitar certo.
 *
 * Lança em qualquer erro da Meta; a mensagem chega ao admin.
 */
export async function verifyInstagramCredentials(
  igUserId: string,
  accessToken: string
): Promise<string> {
  let data: any;
  try {
    data = await metaGet(igUserId, "username", accessToken);
  } catch (e: any) {
    throw new Error(e.metaCode ? `${e.message} (code ${e.metaCode})` : e.message);
  }

  if (typeof data.username !== "string" || !data.username) {
    throw new Error("a Meta não devolveu username para esse IG User ID.");
  }

  return data.username;
}

// ─── Fluxo de carrossel ───────────────────────────────────────────────────────

interface Slide {
  label: string;
  url: string;
}

/**
 * Cria os itens (aguardando cada um ficar pronto), monta o container do
 * carrossel e publica. Se a publicação falhar, o erro carrega creationId e
 * childrenIds para o chamador poder verificar/retomar.
 */
async function runCarouselFlow(
  slides: Slide[],
  caption: string,
  creds: IgCredentials
): Promise<{ mediaId: string; creationId: string }> {
  const tFlow = Date.now();
  console.log(`[IG][FLOW] START | igUserId=${creds.igUserId} | slides=${slides.map((s) => s.label).join(",")} | caption_len=${caption.length}`);

  const childrenIds: string[] = [];
  for (const [i, slide] of slides.entries()) {
    if (i > 0) await sleep(DELAY_BETWEEN_ITEMS_MS);
    const itemId = await instagramService.createCarouselItem(slide.url, creds);
    await waitForMediaReady(itemId, creds, slide.label);
    childrenIds.push(itemId);
    console.log(`[IG][FLOW] +${Date.now() - tFlow}ms ITEM_READY | ${slide.label}=${itemId}`);
  }

  await sleep(DELAY_BEFORE_CONTAINER_MS);

  const carouselId = await instagramService.createCarouselContainer(childrenIds, caption, creds);
  console.log(`[IG][FLOW] +${Date.now() - tFlow}ms CONTAINER_CREATED | carouselId=${carouselId} | children=${childrenIds.join(",")}`);

  // O container pai também passa por processamento antes de poder ser publicado.
  await waitForMediaReady(carouselId, creds, "CAROUSEL_CONTAINER");

  let mediaId: string;
  try {
    mediaId = await instagramService.publishMedia(carouselId, creds);
  } catch (e: any) {
    e.creationId = carouselId;
    e.childrenIds = childrenIds;
    throw e;
  }

  console.log(`[IG][FLOW] END | totalMs=${Date.now() - tFlow} | mediaId=${mediaId} | creationId=${carouselId}`);
  return { mediaId, creationId: carouselId };
}

// ─── Serviço ──────────────────────────────────────────────────────────────────

export const instagramService = {
  /**
   * Cria um container de item do carrossel (cada imagem individual).
   */
  async createCarouselItem(imageUrl: string, creds: IgCredentials): Promise<string> {
    const data = await metaPost(
      `${GRAPH_API_URL}/${creds.igUserId}/media`,
      { image_url: imageUrl, is_carousel_item: true, access_token: creds.accessToken },
      "createCarouselItem"
    );
    const itemId = requireValidId(data, "o item do carrossel");
    console.log(`📦 Item do carrossel criado: ${itemId} (${imageUrl})`);
    return itemId;
  },

  /**
   * Cria o container do carrossel referenciando os itens filhos.
   * Tenta JSON primeiro; se falhar (exceto erro de token) ou vier id inválido,
   * cai para form-urlencoded, com uma repetição após pequeno delay.
   */
  async createCarouselContainer(
    childrenIds: string[],
    caption: string,
    creds: IgCredentials
  ): Promise<string> {
    const url = `${GRAPH_API_URL}/${creds.igUserId}/media`;
    const body = {
      media_type: "CAROUSEL",
      children: childrenIds,
      caption,
      access_token: creds.accessToken,
    };

    console.log(`[IG][CAROUSEL] CREATE_CONTAINER | children=[${childrenIds.join(", ")}] | caption_len=${caption.length}`);

    try {
      const data = await metaPost(url, body, "createCarouselContainer", "json");
      if (isValidId(data?.id)) {
        console.log(`🎠 Container do carrossel criado: ${data.id} (json)`);
        return data.id.trim();
      }
      console.warn(`[IG][CAROUSEL] JSON devolveu id invalido (${data?.id}) — tentando form`);
    } catch (e: any) {
      if (e.isAuthError) throw e; // repetir não adianta com token ruim
      console.warn(`[IG][CAROUSEL] JSON falhou (${e.message}) — tentando form`);
    }

    let data = await metaPost(url, body, "createCarouselContainer", "form");
    if (!isValidId(data?.id)) {
      console.warn("[IG][CAROUSEL] form devolveu id invalido — repetindo apos 2s");
      await sleep(2000);
      data = await metaPost(url, body, "createCarouselContainer", "form");
    }

    const containerId = requireValidId(data, "o container do carrossel");
    console.log(`🎠 Container do carrossel criado: ${containerId} (form)`);
    return containerId;
  },

  /**
   * Publica o container no perfil.
   */
  async publishMedia(creationId: string, creds: IgCredentials): Promise<string> {
    const data = await metaPost(
      `${GRAPH_API_URL}/${creds.igUserId}/media_publish`,
      { creation_id: creationId, access_token: creds.accessToken },
      "publishMedia"
    );
    console.log(`🎉 Publicado no Instagram! Media ID: ${data.id} (creationId=${creationId})`);
    return data.id;
  },

  /**
   * Verifica se um post já foi publicado na Meta.
   * Consulta os últimos posts do feed e casa pelo caption, que é único por
   * post (contém o display_id no formato "[N] - ...").
   * Retorna o media_id se publicado, null se não (ou se a consulta falhar).
   */
  async verifyPublished(creationId: string, caption: string, creds: IgCredentials): Promise<string | null> {
    try {
      const data = await metaGet(
        `${creds.igUserId}/media`,
        "id,permalink,media_type,caption",
        creds.accessToken,
        "&limit=5"
      );
      const match = (data.data || []).find((m: any) => m.caption && m.caption.includes(caption));

      if (match?.id) {
        console.log(`✅ [VERIFY] Post confirmado no feed: ${match.id} (permalink: ${match.permalink})`);
        return match.id;
      }
      return null;
    } catch (e: any) {
      console.warn(`[VERIFY] Falha ao checar ${creationId}: ${e.message}`);
      return null;
    }
  },

  /**
   * Carrossel com 2 slides:
   * Slide 1 → card do spotted (texto)
   * Slide 2 → imagem base (branding da cidade)
   */
  async postCarousel(
    cardImageUrl: string,
    baseImageUrl: string,
    caption: string,
    creds: IgCredentials
  ): Promise<{ mediaId: string; creationId: string }> {
    return runCarouselFlow(
      [
        { label: "CARD_ITEM", url: cardImageUrl },
        { label: "BASE_ITEM", url: baseImageUrl },
      ],
      caption,
      creds
    );
  },

  /**
   * Carrossel com 3 slides (inclui imagem do usuário).
   * A posição da imagem do usuário é definida por USER_IMAGE_SLIDE_POSITION.
   */
  async postCarouselWithUserImage(
    cardImageUrl: string,
    userImageUrl: string,
    baseImageUrl: string,
    caption: string,
    creds: IgCredentials
  ): Promise<{ mediaId: string; creationId: string }> {
    const card: Slide = { label: "CARD_ITEM", url: cardImageUrl };
    const user: Slide = { label: "USER_ITEM", url: userImageUrl };
    const base: Slide = { label: "BASE_ITEM", url: baseImageUrl };

    const slides = USER_IMAGE_SLIDE_POSITION === 1 ? [user, card, base] : [card, user, base];
    return runCarouselFlow(slides, caption, creds);
  },

  /**
   * Publica um Story no Instagram.
   */
  async postStory(imageUrl: string, creds: IgCredentials): Promise<string> {
    const data = await metaPost(
      `${GRAPH_API_URL}/${creds.igUserId}/media`,
      { image_url: imageUrl, media_type: "STORIES", access_token: creds.accessToken },
      "postStory"
    );
    const containerId = requireValidId(data, "o container do Story");
    console.log(`📦 Container do Story criado: ${containerId}`);

    await waitForMediaReady(containerId, creds, "STORY");
    return this.publishMedia(containerId, creds);
  },
};
