/**
 * storeController.ts
 *
 * Endpoints da Lojinha:
 *  GET  /api/store/products   — Lista produtos ativos
 *  POST /api/store/orders     — Compra um produto (debita SC)
 *  GET  /api/store/orders/me  — Histórico de pedidos do usuário
 */

import { Request, Response } from "express";
import { storeRepository } from "../services/storeRepository";
import { userRepository } from "../services/userRepository";
import { supabase } from "../config/supabase";

// ════════════════════════════════════════════════════
//  GET /api/store/products
// ════════════════════════════════════════════════════
export async function listProducts(req: Request, res: Response): Promise<void> {
  try {
    const products = await storeRepository.listActiveProducts();
    res.status(200).json({ success: true, products });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    console.error("[STORE] Erro ao listar produtos:", message);
    res.status(500).json({ success: false, message: "Erro ao buscar produtos." });
  }
}

// ════════════════════════════════════════════════════
//  POST /api/store/orders
//  Body: { product_id: string }
// ════════════════════════════════════════════════════
export async function createOrder(req: Request, res: Response): Promise<void> {
  const { product_id } = req.body;
  const userId = req.user!.userId;

  if (!product_id) {
    res.status(400).json({ success: false, message: "product_id é obrigatório." });
    return;
  }

  try {
    // 1. Valida produto
    const product = await storeRepository.findProductById(product_id);
    if (!product) {
      res.status(404).json({ success: false, message: "Produto não encontrado ou inativo." });
      return;
    }

    if (product.stock <= 0) {
      res.status(400).json({ success: false, message: "Produto esgotado." });
      return;
    }

    // 2. Valida saldo do usuário
    const user = await userRepository.findById(userId);
    if (!user) {
      res.status(404).json({ success: false, message: "Usuário não encontrado." });
      return;
    }

    if (user.balance_coins < product.price_coins) {
      res.status(400).json({
        success: false,
        message: `Saldo insuficiente. Você tem ${user.balance_coins} SC, mas o item custa ${product.price_coins} SC.`,
        balance: user.balance_coins,
        price: product.price_coins,
        missing: product.price_coins - user.balance_coins,
      });
      return;
    }

    if (!supabase) {
      res.status(500).json({ success: false, message: "Banco de dados não configurado." });
      return;
    }

    // 3. Debita saldo do usuário
    const newBalance = user.balance_coins - product.price_coins;
    const { error: balanceError } = await supabase
      .from("users")
      .update({ balance_coins: newBalance, updated_at: new Date().toISOString() })
      .eq("id", userId);

    if (balanceError) throw new Error(`Falha ao debitar saldo: ${balanceError.message}`);

    // 4. Decrementa estoque do produto
    const { error: stockError } = await supabase
      .from("products")
      .update({ stock: product.stock - 1, updated_at: new Date().toISOString() })
      .eq("id", product_id)
      .gt("stock", 0);

    if (stockError) {
      // Tenta reverter o saldo
      await supabase.from("users").update({ balance_coins: user.balance_coins }).eq("id", userId);
      throw new Error("Produto esgotou durante a compra. Saldo revertido.");
    }

    // 5. Cria o pedido
    const order = await storeRepository.createOrder({ user_id: userId, product_id });

    // 6. Registra transação de débito
    await supabase.from("transactions").insert({
      user_id: userId,
      amount: -product.price_coins,
      operation_type: "STORE_PURCHASE",
      reference_id: order.id,
    });

    console.log(`🛒 [STORE] User ${userId} comprou "${product.name}" por ${product.price_coins} SC. Novo saldo: ${newBalance}`);

    res.status(201).json({
      success: true,
      message: `🎉 "${product.name}" resgatado com sucesso!`,
      order,
      new_balance: newBalance,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    console.error("[STORE] Erro ao criar pedido:", message);
    res.status(500).json({ success: false, message: message || "Erro interno ao processar compra." });
  }
}

// ════════════════════════════════════════════════════
//  GET /api/store/orders/me
// ════════════════════════════════════════════════════
export async function getUserOrders(req: Request, res: Response): Promise<void> {
  try {
    const orders = await storeRepository.findUserOrders(req.user!.userId);
    res.status(200).json({ success: true, orders });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    console.error("[STORE] Erro ao buscar pedidos:", message);
    res.status(500).json({ success: false, message: "Erro ao buscar histórico de pedidos." });
  }
}
