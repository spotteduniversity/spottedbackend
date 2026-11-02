/**
 * metaTokenService.ts
 *
 * Serviço de geração / troca de Long-Lived User Access Token da Meta / Facebook.
 *
 * Troca um User Access Token de curta duração (~1 a 2 horas) por um
 * token de longa duração (~60 dias) utilizando o App ID e App Secret do aplicativo Meta.
 *
 * Endpoint oficial da Graph API:
 * GET https://graph.facebook.com/{graph-api-version}/oauth/access_token?
 *     grant_type=fb_exchange_token&
 *     client_id={app-id}&
 *     client_secret={app-secret}&
 *     fb_exchange_token={your-access-token}
 */

export interface MetaPageItem {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: {
    id: string;
    username: string;
  };
}

export interface LongLivedTokenResult {
  access_token: string;
  token_type: string;
  expires_in?: number;
  pages?: MetaPageItem[];
}

export async function exchangeForLongLivedToken(
  shortLivedToken: string
): Promise<LongLivedTokenResult> {
  const appId =
    process.env.FB_APP_ID ||
    process.env.META_APP_ID ||
    process.env.FACEBOOK_APP_ID;

  const appSecret =
    process.env.FB_APP_SECRET ||
    process.env.META_APP_SECRET ||
    process.env.FACEBOOK_APP_SECRET;

  const apiVersion =
    process.env.FB_GRAPH_API_VERSION ||
    process.env.GRAPH_API_VERSION ||
    "v22.0";

  if (!appId || !appSecret) {
    throw new Error(
      "FB_APP_ID e/ou FB_APP_SECRET não estão configurados no backend (.env). " +
      "Configure as credenciais do seu aplicativo Meta no arquivo .env."
    );
  }

  const token = shortLivedToken ? shortLivedToken.trim() : "";
  if (!token) {
    throw new Error("Informe o token de acesso (access_token) para gerar o long-lived token.");
  }

  // Monta a URL da Graph API do Facebook
  const url = new URL(`https://graph.facebook.com/${apiVersion}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", appId.trim());
  url.searchParams.set("client_secret", appSecret.trim());
  url.searchParams.set("fb_exchange_token", token);

  const res = await fetch(url.toString(), {
    method: "GET",
  });

  const data = (await res.json()) as any;

  if (!res.ok || data.error) {
    const errorMsg =
      data?.error?.message ||
      data?.error?.error_user_msg ||
      `Erro retornado pela Meta API (status ${res.status})`;
    const code = data?.error?.code ? ` (código ${data.error.code})` : "";
    throw new Error(`${errorMsg}${code}`);
  }

  if (!data.access_token) {
    throw new Error("A Meta não retornou o access_token esperado.");
  }

  // Tenta buscar as páginas vinculadas ao token (Page Access Tokens nunca expiram)
  let pages: MetaPageItem[] = [];
  try {
    const pagesUrl = new URL(`https://graph.facebook.com/${apiVersion}/me/accounts`);
    pagesUrl.searchParams.set(
      "fields",
      "id,name,access_token,instagram_business_account{id,username}"
    );
    pagesUrl.searchParams.set("access_token", data.access_token);

    const pagesRes = await fetch(pagesUrl.toString());
    const pagesData = (await pagesRes.json()) as any;
    if (pagesData && Array.isArray(pagesData.data)) {
      pages = pagesData.data.map((p: any) => ({
        id: p.id,
        name: p.name,
        access_token: p.access_token,
        instagram_business_account: p.instagram_business_account
          ? {
              id: p.instagram_business_account.id,
              username: p.instagram_business_account.username,
            }
          : undefined,
      }));
    }
  } catch (err: any) {
    console.warn("[LONG-LIVED-TOKEN] Não foi possível listar páginas da conta:", err?.message);
  }

  return {
    access_token: data.access_token,
    token_type: data.token_type || "bearer",
    expires_in: data.expires_in,
    pages: pages.length > 0 ? pages : undefined,
  };
}
