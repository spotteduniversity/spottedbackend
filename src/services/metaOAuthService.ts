/**
 * metaOAuthService.ts
 *
 * Fluxo OAuth "Instagram API with Instagram Login":
 *
 * 1. Gerar URL de autorização (com state anti-CSRF)
 * 2. Trocar o code por short-lived token (POST api.instagram.com/oauth/access_token)
 * 3. Trocar por long-lived token de 60 dias (GET graph.instagram.com/access_token)
 * 4. Buscar ig_user_id e username (GET graph.instagram.com/me)
 * 5. Renovar long-lived token antes de expirar (GET graph.instagram.com/refresh_access_token)
 *
 * State anti-CSRF: JWT curto (~10min) assinado com ADMIN_JWT_SECRET, contendo adminId + nonce.
 * Não precisa de Redis nem de tabela — o JWT é stateless e expira sozinho.
 *
 * Escopos necessários (confirmados na API de 2025):
 *   instagram_business_basic
 *   instagram_business_content_publish
 *   instagram_business_manage_insights
 *
 * Variáveis de ambiente:
 *   META_APP_ID
 *   META_APP_SECRET
 *   META_REDIRECT_URI    ex: https://seu-backend.com/api/admin/oauth/instagram/callback
 *   ADMIN_JWT_SECRET     (reaproveitado para assinar o state)
 */

import jwt from "jsonwebtoken";
import crypto from "crypto";

const GRAPH_API = "https://graph.instagram.com";
const IG_AUTH_BASE = "https://api.instagram.com/oauth/authorize";
const IG_TOKEN_URL = "https://api.instagram.com/oauth/access_token";

const REQUIRED_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_insights",
].join(",");

// Token de 60 dias a partir de agora
export const TOKEN_LIFETIME_DAYS = 60;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Variável de ambiente ausente: ${key}`);
  return val;
}

// ─── State anti-CSRF ─────────────────────────────────────────────────────────

interface StatePayload {
  adminId: string;
  nonce: string;
}

/**
 * Gera um JWT de 10 minutos como parâmetro `state` para o OAuth.
 * Stateless: não precisa de armazenamento externo.
 */
export function generateOAuthState(adminId: string): string {
  const secret = getEnv("ADMIN_JWT_SECRET");
  const payload: StatePayload = {
    adminId,
    nonce: crypto.randomBytes(16).toString("hex"),
  };
  return jwt.sign(payload, secret, { expiresIn: "10m" });
}

/**
 * Valida e decodifica o state recebido no callback.
 * Lança erro se inválido, expirado ou adulterado.
 */
export function verifyOAuthState(state: string): StatePayload {
  const secret = getEnv("ADMIN_JWT_SECRET");
  return jwt.verify(state, secret) as StatePayload;
}

// ─── URL de Autorização ───────────────────────────────────────────────────────

/**
 * Constrói a URL de redirecionamento para o OAuth do Instagram.
 */
export function buildAuthorizationUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: getEnv("META_APP_ID"),
    redirect_uri: getEnv("META_REDIRECT_URI"),
    scope: REQUIRED_SCOPES,
    response_type: "code",
    state,
  });

  return `${IG_AUTH_BASE}?${params.toString()}`;
}

// ─── Troca de Tokens ─────────────────────────────────────────────────────────

export interface ShortLivedToken {
  access_token: string;
  user_id: string;
}

/**
 * Troca o authorization code por um short-lived token (1h).
 * POST https://api.instagram.com/oauth/access_token
 */
export async function exchangeCodeForShortLived(code: string): Promise<ShortLivedToken> {
  const body = new URLSearchParams({
    client_id: getEnv("META_APP_ID"),
    client_secret: getEnv("META_APP_SECRET"),
    grant_type: "authorization_code",
    redirect_uri: getEnv("META_REDIRECT_URI"),
    code,
  });

  const res = await fetch(IG_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const data = await res.json() as any;

  if (data.error_type || data.error_message) {
    throw new Error(`Meta OAuth (short-lived): ${data.error_message || JSON.stringify(data)}`);
  }

  if (!data.access_token) {
    throw new Error("Meta OAuth: access_token ausente na resposta.");
  }

  return { access_token: data.access_token, user_id: String(data.user_id) };
}

export interface LongLivedToken {
  access_token: string;
  expires_in: number;  // segundos
}

/**
 * Troca um short-lived token por um long-lived token (60 dias).
 * GET https://graph.instagram.com/access_token
 */
export async function exchangeForLongLived(shortToken: string): Promise<LongLivedToken> {
  const params = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: getEnv("META_APP_SECRET"),
    access_token: shortToken,
  });

  const res = await fetch(`${GRAPH_API}/access_token?${params.toString()}`);
  const data = await res.json() as any;

  if (data.error) {
    throw new Error(`Meta OAuth (long-lived): ${data.error.message}`);
  }

  return { access_token: data.access_token, expires_in: data.expires_in };
}

export interface IgProfile {
  ig_user_id: string;
  username: string;
}

/**
 * Busca ig_user_id e username com um access token.
 * GET https://graph.instagram.com/me
 */
export async function fetchIgProfile(accessToken: string): Promise<IgProfile> {
  const params = new URLSearchParams({
    fields: "id,username",
    access_token: accessToken,
  });

  const res = await fetch(`${GRAPH_API}/me?${params.toString()}`);
  const data = await res.json() as any;

  if (data.error) {
    throw new Error(`Meta (profile): ${data.error.message}`);
  }

  return { ig_user_id: data.id, username: data.username };
}

/**
 * Calcula a data de expiração de um token a partir de agora + expires_in segundos.
 */
export function computeExpiresAt(expiresInSeconds: number): Date {
  return new Date(Date.now() + expiresInSeconds * 1000);
}

// ─── Renovação de Token ───────────────────────────────────────────────────────

/**
 * Renova um long-lived token (o token deve ser válido e não expirado).
 * GET https://graph.instagram.com/refresh_access_token
 * Retorna novo token com 60 dias a partir de agora.
 */
export async function refreshLongLivedToken(currentToken: string): Promise<LongLivedToken> {
  const params = new URLSearchParams({
    grant_type: "ig_refresh_token",
    access_token: currentToken,
  });

  const res = await fetch(`${GRAPH_API}/refresh_access_token?${params.toString()}`);
  const data = await res.json() as any;

  if (data.error) {
    throw new Error(`Meta (refresh): ${data.error.message} (code ${data.error.code})`);
  }

  return { access_token: data.access_token, expires_in: data.expires_in };
}
