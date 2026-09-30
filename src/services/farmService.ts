/**
 * farmService.ts
 * 
 * Motor de Farm (Acúmulo) de SpottedCoins.
 * 
 * Responsabilidades:
 *  1. Buscar o estado atual do spotted no banco (processed_* e last_synced_at).
 *  2. Validar o cooldown de 120 minutos (anti rate-limit e anti-inflação).
 *  3. Chamar a Meta API para obter as métricas atuais.
 *  4. Calcular o Delta (atual - processado) para cada métrica.
 *  5. Converter o Delta em SpottedCoins usando a tabela de pesos.
 *  6. Persistir o novo estado no banco (claimable_coins, processed_*, last_synced_at).
 */

import { supabase } from "../config/supabase";
import { getMediaEngagement } from "./instagramMetricsService";
import { decrypt } from "./cryptoService";

// ════════════════════════════════════════════════════
//  CONFIGURAÇÕES DO MOTOR
// ════════════════════════════════════════════════════

const COOLDOWN_MINUTES = 120;

/**
 * Limites máximos que um post pode acumular para cada métrica,
 * evitando abusos (ex: cara comentar 100x).
 */
const METRIC_CAPS = {
  likes: 500,
  comments: 20,
  shares: 150,
  saved: 150,
  reach: 15000,
};

/**
 * Tabela de pesos para conversão de métricas em SC.
 * Baseado na regra: 1.000 SC = R$ 1,00
 */
const SC_WEIGHTS = {
  reach_per_10: 1,    // 1 SC a cada 10 contas alcançadas
  like: 10,           // 10 SC por curtida
  comment: 30,        // 30 SC por comentário
  saved: 40,          // 40 SC por salvamento
  share: 50,          // 50 SC por compartilhamento
};

// ════════════════════════════════════════════════════
//  TIPOS
// ════════════════════════════════════════════════════

export interface FarmSyncResult {
  success: boolean;
  spotted_id: string;
  new_coins_earned: number;
  claimable_coins: number;
  next_sync_available_at: string;
  delta: {
    likes: number;
    comments: number;
    reach: number;
    saved: number;
    shares: number;
  };
  cooldown_remaining_minutes?: number;
}

interface SpottedFarmRow {
  id: string;
  user_id: string;
  instagram_media_id: string;
  wants_coin: boolean;
  claimable_coins: number;
  claimed_coins: number;
  processed_likes: number;
  processed_comments: number;
  processed_shares: number;
  processed_reach: number;
  processed_saved: number;
  last_synced_at: string | null;
}

// ════════════════════════════════════════════════════
//  FUNÇÕES AUXILIARES
// ════════════════════════════════════════════════════

/**
 * Calcula quantas moedas o delta de métricas gera.
 * Usa Math.floor para arredondamento para baixo (padrão de jogos).
 */
function calculateSC(delta: {
  likes: number;
  comments: number;
  reach: number;
  saved: number;
  shares: number;
}): number {
  const fromLikes    = delta.likes    * SC_WEIGHTS.like;
  const fromComments = delta.comments * SC_WEIGHTS.comment;
  const fromReach    = Math.floor(delta.reach / 10) * SC_WEIGHTS.reach_per_10;
  const fromSaved    = delta.saved    * SC_WEIGHTS.saved;
  const fromShares   = delta.shares   * SC_WEIGHTS.share;

  const total = fromLikes + fromComments + fromReach + fromSaved + fromShares;

  console.log(`💰 Cálculo SC:
    Likes     (+${delta.likes} × ${SC_WEIGHTS.like})          = ${fromLikes} SC
    Comments  (+${delta.comments} × ${SC_WEIGHTS.comment})     = ${fromComments} SC
    Reach     (+${delta.reach} ÷ 10 × ${SC_WEIGHTS.reach_per_10}) = ${fromReach} SC
    Saved     (+${delta.saved} × ${SC_WEIGHTS.saved})          = ${fromSaved} SC
    Shares    (+${delta.shares} × ${SC_WEIGHTS.share})          = ${fromShares} SC
    ─────────────────────────────────────────
    TOTAL     = ${total} SC`);

  return total;
}

/**
 * Verifica se o cooldown ainda está ativo.
 * Retorna os minutos restantes (0 se liberado).
 */
function getCooldownRemainingMinutes(lastSyncedAt: string | null): number {
  if (!lastSyncedAt) return 0;

  const lastSync = new Date(lastSyncedAt).getTime();
  const now = Date.now();
  const elapsed = (now - lastSync) / 1000 / 60; // em minutos
  const remaining = COOLDOWN_MINUTES - elapsed;

  return remaining > 0 ? Math.ceil(remaining) : 0;
}

// ════════════════════════════════════════════════════
//  FUNÇÃO PRINCIPAL DO MOTOR
// ════════════════════════════════════════════════════

export async function syncUserFarming(userId: string): Promise<FarmSyncResult> {
  if (!supabase) {
    throw new Error("Supabase não configurado. Verifique as variáveis de ambiente.");
  }

  // ── ETAPA 1: Busca o usuário no banco ──────────────────────────────────────
  const { data: user, error: fetchUserError } = await supabase
    .from("users")
    .select("id, last_synced_at, lifetime_sc")
    .eq("id", userId)
    .maybeSingle();

  if (fetchUserError) {
    // Erro de coluna inexistente no banco (lifetime_sc / last_synced_at não foram criadas)
    if (fetchUserError.message?.includes("column") || fetchUserError.code === "42703") {
      throw new Error(
        "Colunas 'lifetime_sc' e/ou 'last_synced_at' não existem na tabela users. " +
        "Execute o SQL de migração no Supabase:\n" +
        "ALTER TABLE public.users ADD COLUMN IF NOT EXISTS lifetime_sc INTEGER DEFAULT 0;\n" +
        "ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP WITH TIME ZONE;"
      );
    }
    throw new Error(`Erro ao buscar usuário: ${fetchUserError.message}`);
  }

  if (!user) {
    throw new Error(`Usuário não encontrado: ${userId}`);
  }

  // ── ETAPA 2: Valida o cooldown do usuário ───────────────────────────────────
  const cooldownRemaining = getCooldownRemainingMinutes(user.last_synced_at);

  if (cooldownRemaining > 0) {
    const nextAvailable = new Date(
      new Date(user.last_synced_at!).getTime() + COOLDOWN_MINUTES * 60 * 1000
    ).toISOString();

    console.warn(`⏳ Cooldown ativo para usuário ${userId}. Faltam ${cooldownRemaining} minutos.`);

    return {
      success: false,
      spotted_id: "user-sync", // mantendo a compatibilidade do tipo por enquanto
      new_coins_earned: 0,
      claimable_coins: 0,
      next_sync_available_at: nextAvailable,
      cooldown_remaining_minutes: cooldownRemaining,
      delta: { likes: 0, comments: 0, reach: 0, saved: 0, shares: 0 },
    };
  }

  // ── ETAPA 3: Busca todos os spotteds elegíveis do usuário ───────────────────
  const { data: spotteds, error: fetchPostsError } = await supabase
    .from("spotteds")
    .select(`
      id, user_id, instagram_media_id, wants_coin, claimable_coins, claimed_coins,
      processed_likes, processed_comments, processed_shares, processed_reach, processed_saved,
      instagram_account_id,
      instagram_accounts(id, access_token_encrypted, connection_status)
    `)
    .eq("user_id", userId)
    .eq("status", "PUBLISHED")
    .eq("wants_coin", true)
    .not("instagram_media_id", "is", null);

  if (fetchPostsError) {
    throw new Error(`Falha ao buscar posts do usuário: ${fetchPostsError.message}`);
  }

  let totalNewCoins = 0;
  let totalDelta = { likes: 0, comments: 0, reach: 0, saved: 0, shares: 0 };

  console.log(`🔄 Iniciando sync em lote para o usuário ${userId}. Posts encontrados: ${spotteds?.length || 0}`);

  // ── ETAPA 4 e 5: Chama a Meta API e calcula deltas para cada post ───────────
  if (spotteds && spotteds.length > 0) {
    for (const post of spotteds) {
      try {
        const account = post.instagram_accounts as any;
        if (!account || account.connection_status !== 'ok' || !account.access_token_encrypted) {
           console.log(`⚠️ Post ${post.id} ignorado: conta do Instagram desconectada ou sem token.`);
           continue;
        }

        const accessToken = decrypt(account.access_token_encrypted);

        console.log(`📡 Buscando métricas do Instagram para media ID: ${post.instagram_media_id}...`);
        const { basic, insights } = await getMediaEngagement(post.instagram_media_id, accessToken);

        // Aplica os limites máximos (caps) nas métricas vindas da API
        const cappedLikes    = Math.min(basic.like_count, METRIC_CAPS.likes);
        const cappedComments = Math.min(basic.comments_count, METRIC_CAPS.comments);
        const cappedReach    = Math.min(insights.reach, METRIC_CAPS.reach);
        const cappedSaved    = Math.min(insights.saved, METRIC_CAPS.saved);
        const cappedShares   = Math.min(insights.shares, METRIC_CAPS.shares);

        const delta = {
          likes:    Math.max(0, cappedLikes    - (post.processed_likes    ?? 0)),
          comments: Math.max(0, cappedComments - (post.processed_comments ?? 0)),
          reach:    Math.max(0, cappedReach    - (post.processed_reach    ?? 0)),
          saved:    Math.max(0, cappedSaved    - (post.processed_saved    ?? 0)),
          shares:   Math.max(0, cappedShares   - (post.processed_shares   ?? 0)),
        };

        const newCoins = calculateSC(delta);
        const newClaimable = post.claimable_coins + newCoins;

        // Atualiza os totais
        totalNewCoins += newCoins;
        totalDelta.likes += delta.likes;
        totalDelta.comments += delta.comments;
        totalDelta.reach += delta.reach;
        totalDelta.saved += delta.saved;
        totalDelta.shares += delta.shares;

        // ── ETAPA 6: Persiste o novo estado no post ──────────────────────────────
        await supabase
          .from("spotteds")
          .update({
            claimable_coins:    newClaimable,
            processed_likes:    cappedLikes,
            processed_comments: cappedComments,
            processed_shares:   cappedShares,
            processed_reach:    cappedReach,
            processed_saved:    cappedSaved,
          })
          .eq("id", post.id);

        console.log(`✅ Post ${post.id} atualizado. Ganhou +${newCoins} SC.`);
      } catch (err: any) {
        console.error(`❌ Erro ao sincronizar post ${post.id}: ${err.message}`);
        if (err.isAuthError && post.instagram_account_id) {
          try {
             // import { adminRepository } from "./adminRepository"; is needed!
             const { adminRepository } = require("./adminRepository");
             await adminRepository.updateConnection(post.instagram_account_id, {
                needs_reauth: true,
                // A coluna só aceita 'ok' | 'needs_reauth'.
               connection_status: 'needs_reauth',
                last_error: err.message
             });
          } catch(e) {}
        }
        // Continua para o próximo post mesmo se um der erro
      }
    }
  }

  // ── ETAPA 7: Atualiza o last_synced_at do usuário ───────────────────────────
  const nowIso = new Date().toISOString();
  const nextSyncAt = new Date(Date.now() + COOLDOWN_MINUTES * 60 * 1000).toISOString();

  const { error: updateUserError } = await supabase
    .from("users")
    .update({ 
      last_synced_at: nowIso,
      lifetime_sc: ((user as any).lifetime_sc || 0) + totalNewCoins
    })
    .eq("id", userId);

  if (updateUserError) {
    throw new Error(`Falha ao atualizar cooldown do usuário: ${updateUserError.message}`);
  }

  console.log(`✅ Sincronização em lote concluída para o usuário ${userId}! Total: +${totalNewCoins} SC.`);

  return {
    success: true,
    spotted_id: "user-sync", // mantendo compatibilidade
    new_coins_earned: totalNewCoins,
    claimable_coins: totalNewCoins, // não é exato para o total, mas atende a interface
    next_sync_available_at: nextSyncAt,
    delta: totalDelta,
  };
}
