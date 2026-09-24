/**
 * adminOAuthController.ts
 *
 * Endpoints do fluxo OAuth para conectar uma conta do Instagram ao painel.
 *
 * GET  /api/admin/oauth/instagram/start
 *   → Gera state anti-CSRF, redireciona para URL de autorização da Meta.
 *   → Requer: query param `account_id` (UUID da instagram_account a conectar)
 *
 * GET  /api/admin/oauth/instagram/callback
 *   → Valida state, troca code por token long-lived, busca perfil, grava no banco.
 *   → Nunca retorna o token em nenhuma resposta.
 */

import { Request, Response } from "express";
import {
  generateOAuthState,
  verifyOAuthState,
  buildAuthorizationUrl,
  exchangeCodeForShortLived,
  exchangeForLongLived,
  fetchIgProfile,
  computeExpiresAt,
} from "../services/metaOAuthService";
import { encrypt } from "../services/cryptoService";
import { adminRepository } from "../services/adminRepository";

// ─── START ────────────────────────────────────────────────────────────────────

export async function oauthStart(req: Request, res: Response): Promise<void> {
  try {
    const adminId = req.admin!.adminId;
    const accountId = req.query.account_id as string | undefined;

    if (!accountId) {
      res.status(400).json({
        success: false,
        message: "account_id é obrigatório (UUID da instagram_account).",
      });
      return;
    }

    // Verifica que o admin tem acesso a essa conta (ou é super)
    if (!req.admin!.is_super && !req.admin!.accountIds.includes(accountId)) {
      res.status(403).json({ success: false, message: "Sem permissão para esta conta." });
      return;
    }

    // O state carrega adminId + nonce + account_id para recuperar no callback
    const state = generateOAuthState(adminId);

    // Persiste o account_id no state via cookie seguro (HttpOnly, SameSite=Lax, 10min)
    res.cookie("oauth_account_id", accountId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 10 * 60 * 1000, // 10 minutos
    });

    const url = buildAuthorizationUrl(state);
    res.redirect(url);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    console.error("[OAUTH] Erro ao iniciar OAuth:", message);
    res.status(500).json({ success: false, message: "Erro ao iniciar fluxo OAuth." });
  }
}

// ─── CALLBACK ─────────────────────────────────────────────────────────────────

export async function oauthCallback(req: Request, res: Response): Promise<void> {
  const frontendUrl = process.env.FRONTEND_URL?.replace(/\/+$/, "") || "http://localhost:3000";

  try {
    const { code, state, error: oauthError } = req.query as Record<string, string>;

    // Erro retornado pelo Instagram (ex: usuário cancelou)
    if (oauthError) {
      console.warn("[OAUTH] Usuário cancelou ou erro na autorização:", oauthError);
      res.redirect(`${frontendUrl}/admin/accounts?error=oauth_cancelled`);
      return;
    }

    if (!code || !state) {
      res.redirect(`${frontendUrl}/admin/accounts?error=missing_params`);
      return;
    }

    // Valida o state anti-CSRF
    let statePayload;
    try {
      statePayload = verifyOAuthState(state);
    } catch {
      console.warn("[OAUTH] State inválido ou expirado.");
      res.redirect(`${frontendUrl}/admin/accounts?error=invalid_state`);
      return;
    }

    // Recupera o account_id do cookie
    const accountId = req.cookies?.oauth_account_id as string | undefined;
    if (!accountId) {
      res.redirect(`${frontendUrl}/admin/accounts?error=missing_account_id`);
      return;
    }

    // Limpa o cookie
    res.clearCookie("oauth_account_id");

    console.log(`[OAUTH] Processando callback para account ${accountId}, admin ${statePayload.adminId}`);

    // 1. Troca code por short-lived token
    const { access_token: shortToken } = await exchangeCodeForShortLived(code);

    // 2. Troca por long-lived token (60 dias)
    const { access_token: longToken, expires_in } = await exchangeForLongLived(shortToken);

    // 3. Busca perfil (ig_user_id e username)
    const profile = await fetchIgProfile(longToken);

    // 4. Criptografa o token — NUNCA logar o token em plaintext
    const encryptedToken = encrypt(longToken);
    const expiresAt = computeExpiresAt(expires_in);
    const refreshedAt = new Date();

    // 5. Atualiza a conta no banco
    await adminRepository.updateConnection(accountId, {
      username: profile.username,
      ig_user_id: profile.ig_user_id,
      access_token_encrypted: encryptedToken,
      token_expires_at: expiresAt.toISOString(),
      token_refreshed_at: refreshedAt.toISOString(),
      connection_status: "ok",
      needs_reauth: false,
      last_error: null,
    });

    console.log(`[OAUTH] ✅ Conta @${profile.username} (${profile.ig_user_id}) conectada com sucesso.`);

    // Redireciona para o painel com sucesso
    res.redirect(`${frontendUrl}/admin/accounts?success=connected&username=${encodeURIComponent(profile.username)}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    // Nunca logar tokens — a mensagem de erro da Meta pode conter partes do token
    const safeMsgForLog = message.replace(/access_token=[^&\s]*/gi, "access_token=REDACTED");
    console.error("[OAUTH] Erro no callback:", safeMsgForLog);
    res.redirect(`${frontendUrl}/admin/accounts?error=oauth_failed`);
  }
}
