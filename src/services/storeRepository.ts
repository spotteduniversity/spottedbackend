/**
 * storeRepository.ts
 *
 * CRUD de produtos e pedidos da Lojinha.
 */

import { supabase } from "../config/supabase";

export interface Product {
  id: string;
  name: string;
  description: string;
  price_coins: number;
  stock: number;
  is_active: boolean;
  image_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface Order {
  id: string;
  user_id: string;
  product_id: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export const storeRepository = {
  /**
   * Lista todos os produtos ativos.
   */
  async listActiveProducts(): Promise<Product[]> {
    if (!supabase) return [];

    const { data, error } = await supabase
      .from("products")
      .select("*")
      .eq("is_active", true)
      .order("price_coins", { ascending: true });

    if (error) {
      console.error("Erro ao listar produtos:", error.message);
      return [];
    }

    return (data || []) as Product[];
  },

  /**
   * Busca um produto por ID.
   */
  async findProductById(productId: string): Promise<Product | null> {
    if (!supabase) return null;

    const { data, error } = await supabase
      .from("products")
      .select("*")
      .eq("id", productId)
      .eq("is_active", true)
      .single();

    if (error || !data) return null;
    return data as Product;
  },

  /**
   * Decrementa o estoque de um produto em 1 unidade.
   * Usa update condicional para garantir que o estoque não fique negativo.
   */
  async decrementStock(productId: string): Promise<boolean> {
    if (!supabase) return false;

    const { data, error } = await supabase
      .from("products")
      .update({
        stock: supabase.rpc("decrement_stock", { p_product_id: productId }),
        updated_at: new Date().toISOString(),
      })
      .eq("id", productId)
      .gt("stock", 0) // Garante atomicidade: só atualiza se stock > 0
      .select("stock")
      .single();

    if (error || !data) return false;
    return true;
  },

  /**
   * Cria um pedido de compra.
   */
  async createOrder(data: {
    user_id: string;
    product_id: string;
    status?: string;
  }): Promise<Order> {
    if (!supabase) throw new Error("Supabase não configurado.");

    const { data: record, error } = await supabase
      .from("orders")
      .insert({
        user_id: data.user_id,
        product_id: data.product_id,
        status: data.status || "CONFIRMED",
      })
      .select("*")
      .single();

    if (error) throw new Error(`Falha ao criar pedido: ${error.message}`);
    return record as Order;
  },

  /**
   * Lista os pedidos de um usuário.
   */
  async findUserOrders(userId: string): Promise<any[]> {
    if (!supabase) return [];

    const { data, error } = await supabase
      .from("orders")
      .select(`
        id, status, created_at,
        products (id, name, description, price_coins, image_url)
      `)
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) return [];
    return data || [];
  },
};
