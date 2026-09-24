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

const GRAPH_API_URL = "https://graph.facebook.com/v22.0";

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

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Chama a Meta API e lança erro com isolamento: erros de token/auth
 * marcam a conta, mas não propagam para outras contas.
 */
async function metaPost(url: string, body: Record<string, unknown>): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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

  if (data.error) {
    const { message, code, error_subcode } = data.error;
    const err = new Error(`Instagram API Error: ${message}`) as any;
    err.metaCode = code;
    err.metaSubcode = error_subcode;
    // Códigos de token inválido/expirado da Meta: 190, 102, 463, 467
    err.isAuthError = [190, 102, 463, 467].includes(code);
    throw err;
  }

  return data;
}

// ─── Serviço ──────────────────────────────────────────────────────────────────

export const instagramService = {
  /**
   * Cria um container de item do carrossel (cada imagem individual).
   */
  async createCarouselItem(imageUrl: string, creds: IgCredentials): Promise<string> {
    const url = `${GRAPH_API_URL}/${creds.igUserId}/media`;
    const data = await metaPost(url, {
      image_url: imageUrl,
      is_carousel_item: true,
      access_token: creds.accessToken,
    });
    console.log(`📦 Item do carrossel criado: ${data.id}`);
    return data.id;
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
    const data = await metaPost(url, {
      media_type: "CAROUSEL",
      children: childrenIds,
      caption,
      access_token: creds.accessToken,
    });
    console.log(`🎠 Container do carrossel criado: ${data.id}`);
    return data.id;
  },

  /**
   * Publica o container no perfil.
   */
  async publishMedia(creationId: string, creds: IgCredentials): Promise<string> {
    const url = `${GRAPH_API_URL}/${creds.igUserId}/media_publish`;
    const data = await metaPost(url, {
      creation_id: creationId,
      access_token: creds.accessToken,
    });
    console.log(`🎉 Carrossel publicado no Instagram! Media ID: ${data.id}`);
    return data.id;
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
  ): Promise<string> {
    const cardItemId = await this.createCarouselItem(cardImageUrl, creds);

    console.log("⏱️ Intervalo entre uploads pro Instagram...");
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const baseItemId = await this.createCarouselItem(baseImageUrl, creds);

    const carouselId = await this.createCarouselContainer(
      [cardItemId, baseItemId],
      caption,
      creds
    );

    await new Promise((resolve) => setTimeout(resolve, 5000));

    return this.publishMedia(carouselId, creds);
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
  ): Promise<string> {
    const cardItemId = await this.createCarouselItem(cardImageUrl, creds);

    console.log("⏱️ Intervalo entre uploads pro Instagram (1)...");
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const userImageItemId = await this.createCarouselItem(userImageUrl, creds);

    console.log("⏱️ Intervalo entre uploads pro Instagram (2)...");
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const baseItemId = await this.createCarouselItem(baseImageUrl, creds);

    const children =
      USER_IMAGE_SLIDE_POSITION === 1
        ? [userImageItemId, cardItemId, baseItemId]
        : [cardItemId, userImageItemId, baseItemId];

    const carouselId = await this.createCarouselContainer(children, caption, creds);

    await new Promise((resolve) => setTimeout(resolve, 5000));

    return this.publishMedia(carouselId, creds);
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
    });

    console.log(`📦 Container do Story criado: ${createData.id}`);

    await new Promise((resolve) => setTimeout(resolve, 3000));

    return this.publishMedia(createData.id, creds);
  },
};
