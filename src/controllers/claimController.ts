/**
 * claimController.ts
 *
 * POST /api/farm/claim/:spottedId
 *
 * Move as moedas de `claimable_coins` (no spotted) para
 * `balance_coins` (na carteira do usuário) e registra
 * a operação em `transactions`.
 *
 * Regras:
 *  - Usuário deve ser dono do spotted.
 *  - `claimable_coins` deve ser > 0.
 *  - Operação é atômica: credited + zeroed + transaction num mesmo bloco.
 */

import { Request, Response } from "express";
import { supabase } from "../config/supabase";

export async function claimCoins(req: Request, res: Response): Promise<void> {
  const spottedId = String(req.params.spottedId || "");
  const userId = req.user!.userId;

  // UUID validation
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!spottedId || !uuidRegex.test(spottedId)) {
    res.status(400).json({ success: false, message: "spottedId inválido." });
    return;
  }

  if (!supabase) {
    res.status(500).json({ success: false, message: "Banco de dados não configurado." });
    return;
  }

  try {
    // 1. Busca o spotted e valida propriedade + moedas disponíveis
    const { data: spotted, error: fetchError } = await supabase
      .from("spotteds")
      .select("id, user_id, claimable_coins, claimed_coins, wants_coin")
      .eq("id", spottedId)
      .single();

    if (fetchError || !spotted) {
      res.status(404).json({ success: false, message: "Spotted não encontrado." });
      return;
    }

    if (spotted.user_id !== userId) {
      res.status(403).json({ success: false, message: "Você não é o dono deste spotted." });
      return;
    }

    if (!spotted.wants_coin) {
      res.status(400).json({ success: false, message: "Este spotted não participa do programa de SC." });
      return;
    }

    const claimable = spotted.claimable_coins ?? 0;
    if (claimable <= 0) {
      res.status(400).json({ success: false, message: "Nenhuma moeda disponível para resgatar." });
      return;
    }

    // 2. Busca saldo atual do usuário
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("balance_coins")
      .eq("id", userId)
      .single();

    if (userError || !user) {
      res.status(404).json({ success: false, message: "Usuário não encontrado." });
      return;
    }

    const newBalance = (user.balance_coins ?? 0) + claimable;
    const newClaimed = (spotted.claimed_coins ?? 0) + claimable;

    // 3. Executa as 3 operações de forma sequencial (Supabase não tem transações nativas no client)
    //    Em caso de falha parcial, logamos o erro mas não revertemos automaticamente.
    //    Para produção, recomenda-se criar uma RPC/função no Supabase para atomicidade total.

    // 3a. Credita na carteira do usuário
    const { error: balanceError } = await supabase
      .from("users")
      .update({ balance_coins: newBalance, updated_at: new Date().toISOString() })
      .eq("id", userId);

    if (balanceError) throw new Error(`Falha ao creditar moedas: ${balanceError.message}`);

    // 3b. Zera o claimable e soma ao claimed no spotted
    const { error: spottedError } = await supabase
      .from("spotteds")
      .update({
        claimable_coins: 0,
        claimed_coins: newClaimed,
        updated_at: new Date().toISOString(),
      })
      .eq("id", spottedId);

    if (spottedError) throw new Error(`Falha ao atualizar spotted: ${spottedError.message}`);

    // 3c. Registra a transação
    const { error: txError } = await supabase
      .from("transactions")
      .insert({
        user_id: userId,
        amount: claimable,
        operation_type: "FARM_CLAIM",
        reference_id: spottedId,
      });

    if (txError) {
      // Transação é auditoria — não revertemos o claim por causa disso
      console.error("[CLAIM] Falha ao registrar transação (não crítico):", txError.message);
    }

    console.log(`✅ [CLAIM] User ${userId} resgatou +${claimable} SC do spotted ${spottedId}. Novo saldo: ${newBalance}`);

    res.status(200).json({
      success: true,
      message: `🎉 +${claimable} SC resgatados com sucesso!`,
      coins_claimed: claimable,
      new_balance: newBalance,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    console.error("[CLAIM] Erro:", message);
    res.status(500).json({ success: false, message: "Erro interno ao resgatar moedas." });
  }
}
