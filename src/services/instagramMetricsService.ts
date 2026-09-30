/**
 * instagramMetricsService.ts
 *
 * Busca métricas de engajamento de posts publicados via Instagram Graph API v22.0+.
 *
 * MUDANÇA: accessToken agora é parâmetro (não mais process.env global),
 * permitindo buscar métricas de múltiplas contas de forma isolada.
 */

const GRAPH_API_URL = "https://graph.facebook.com/v22.0";

export interface InstagramBasicData {
  like_count: number;
  comments_count: number;
  media_type: string;
}

export interface InstagramInsights {
  reach: number;
  saved: number;
  shares: number;
}

export interface InstagramEngagementData {
  basic: InstagramBasicData;
  insights: InstagramInsights;
}

/**
 * Busca os dados básicos de um post (likes, comentários, tipo de mídia).
 */
async function fetchBasicData(mediaId: string, accessToken: string): Promise<InstagramBasicData> {
  const url = `${GRAPH_API_URL}/${mediaId}?fields=media_type,comments_count,like_count&access_token=${accessToken}`;
  const res = await fetch(url);
  const data = await res.json() as any;

  if (data.error) {
    const err = new Error(`Meta API (basic) error: ${data.error.message} (code ${data.error.code})`) as any;
    err.metaCode = data.error.code;
    err.isAuthError = [190, 102, 463, 467].includes(data.error.code);
    throw err;
  }

  return {
    like_count: data.like_count ?? 0,
    comments_count: data.comments_count ?? 0,
    media_type: data.media_type ?? "IMAGE",
  };
}

/**
 * Busca as métricas de insights de um post (reach, saved, shares).
 *
 * Só pedimos o que o farm realmente usa para calcular SC. `views` e
 * `total_interactions` eram solicitados antes mas nunca gravados em
 * `spotteds.processed_*`, então saíram do request: a Meta rejeita a chamada
 * inteira se um dos metrics pedidos não existir para o tipo de mídia.
 */
async function fetchInsights(mediaId: string, accessToken: string): Promise<InstagramInsights> {
  const metrics = "reach,saved,shares";
  const url = `${GRAPH_API_URL}/${mediaId}/insights?metric=${metrics}&access_token=${accessToken}`;
  const res = await fetch(url);
  const data = await res.json() as any;

  if (data.error) {
    const err = new Error(`Meta API (insights) error: ${data.error.message} (code ${data.error.code})`) as any;
    err.metaCode = data.error.code;
    err.isAuthError = [190, 102, 463, 467].includes(data.error.code);
    throw err;
  }

  const metricsMap: Record<string, number> = {};
  if (data.data && Array.isArray(data.data)) {
    for (const metric of data.data) {
      const value = metric.value ?? metric.values?.[0]?.value ?? 0;
      metricsMap[metric.name] = typeof value === "number" ? value : 0;
    }
  }

  return {
    reach: metricsMap["reach"] ?? 0,
    saved: metricsMap["saved"] ?? 0,
    shares: metricsMap["shares"] ?? 0,
  };
}

/**
 * Função principal: busca todos os dados de engajamento de um media post.
 * @param mediaId   ID do media no Instagram
 * @param accessToken  Token da conta à qual o media pertence
 */
export async function getMediaEngagement(
  mediaId: string,
  accessToken: string
): Promise<InstagramEngagementData> {
  const [basic, insights] = await Promise.all([
    fetchBasicData(mediaId, accessToken),
    fetchInsights(mediaId, accessToken),
  ]);

  return { basic, insights };
}
