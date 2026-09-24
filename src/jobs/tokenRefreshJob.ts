/**
 * tokenRefreshJob.ts
 *
 * Job para renovar tokens long-lived da Meta (que expiram em 60 dias).
 *
 * Regras:
 * - O token deve ser renovado antes de expirar (aqui buscamos os que expiram em < 10 dias).
 * - Uma vez expirado, não pode ser renovado via API (exige OAuth manual do admin).
 * - Se a renovação falhar por token revogado (ex: usuário mudou a senha no Instagram),
 *   a conta é marcada como needs_reauth = true.
 *
 * Deve ser chamado via cron job (ex: Vercel Cron Jobs, 1x ao dia).
 */

import { adminRepository } from "../services/adminRepository";
import { refreshLongLivedToken, computeExpiresAt } from "../services/metaOAuthService";
import { encrypt, decrypt } from "../services/cryptoService";

export async function runTokenRefreshJob(): Promise<{
  total_checked: number;
  success: number;
  failed: number;
}> {
  console.log("🔄 [CRON] Iniciando job de renovação de tokens do Instagram...");

  // Busca contas cujo token expira em menos de 10 dias e que estão "ok"
  const accountsToRefresh = await adminRepository.getAccountsNeedingRefresh(10);

  if (accountsToRefresh.length === 0) {
    console.log("✅ [CRON] Nenhuma conta precisando de renovação no momento.");
    return { total_checked: 0, success: 0, failed: 0 };
  }

  let successCount = 0;
  let failCount = 0;

  for (const account of accountsToRefresh) {
    try {
      console.log(`📡 [CRON] Renovando token para conta ID: ${account.id}`);
      
      const currentToken = decrypt(account.access_token_encrypted);
      const result = await refreshLongLivedToken(currentToken);

      const newEncryptedToken = encrypt(result.access_token);
      const newExpiresAt = computeExpiresAt(result.expires_in).toISOString();

      await adminRepository.updateConnection(account.id, {
        access_token_encrypted: newEncryptedToken,
        token_expires_at: newExpiresAt,
        token_refreshed_at: new Date().toISOString(),
        connection_status: "ok",
        needs_reauth: false,
        last_error: null,
      });

      console.log(`✅ [CRON] Token renovado com sucesso para conta ${account.id}. Válido até ${newExpiresAt}.`);
      successCount++;
    } catch (error: any) {
      console.error(`❌ [CRON] Falha ao renovar token da conta ${account.id}:`, error.message);
      failCount++;

      // Se falhou (provavelmente token expirou de vez ou foi revogado),
      // marca a conta para que o painel avise o admin.
      await adminRepository.updateConnection(account.id, {
        needs_reauth: true,
        connection_status: "error",
        last_error: `Falha na renovação automática: ${error.message}`,
      });
    }
  }

  console.log(`🏁 [CRON] Job finalizado. Sucesso: ${successCount}, Falhas: ${failCount}.`);
  
  return {
    total_checked: accountsToRefresh.length,
    success: successCount,
    failed: failCount,
  };
}
