/**
 * userRepository.ts
 *
 * CRUD de usuários no Supabase.
 * Separado do authService para manter a separação de responsabilidades.
 */

import { supabase } from "../config/supabase";

export interface UserRecord {
  id: string;
  name: string;
  instagram_username: string;
  email: string;
  password_hash: string;
  balance_coins: number;
  lifetime_sc: number;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

// Campos seguros para retornar ao frontend (sem password_hash)
export type SafeUser = Omit<UserRecord, "password_hash">;

export const userRepository = {
  /**
   * Cria um novo usuário.
   */
  async create(data: {
    name: string;
    email: string;
    instagram_username: string;
    password_hash: string;
  }): Promise<SafeUser> {
    if (!supabase) throw new Error("Supabase não configurado.");

    const { data: record, error } = await supabase
      .from("users")
      .insert({
        name: data.name,
        email: data.email,
        instagram_username: data.instagram_username,
        password_hash: data.password_hash,
        balance_coins: 0,
        lifetime_sc: 0,
      })
      .select("id, name, instagram_username, email, balance_coins, lifetime_sc, last_synced_at, created_at, updated_at")
      .single();

    if (error) {
      // Trata violação de unique (email ou instagram já existente)
      if (error.code === "23505") {
        if (error.message.includes("email")) throw new Error("DUPLICATE_EMAIL");
        if (error.message.includes("instagram")) throw new Error("DUPLICATE_INSTAGRAM");
      }
      throw new Error(`Falha ao criar usuário: ${error.message}`);
    }

    return record as SafeUser;
  },

  /**
   * Busca usuário por email (inclui password_hash para comparação no login).
   */
  async findByEmailWithHash(email: string): Promise<UserRecord | null> {
    if (!supabase) return null;

    const { data, error } = await supabase
      .from("users")
      .select("*")
      .eq("email", email.toLowerCase().trim())
      .single();

    if (error || !data) return null;
    return data as UserRecord;
  },

  /**
   * Busca usuário por ID (sem password_hash).
   */
  async findById(id: string): Promise<SafeUser | null> {
    if (!supabase) return null;

    const { data, error } = await supabase
      .from("users")
      .select("id, name, instagram_username, email, balance_coins, lifetime_sc, last_synced_at, created_at, updated_at")
      .eq("id", id)
      .single();

    if (error || !data) return null;
    return data as SafeUser;
  },

  /**
   * Atualiza campos do perfil do usuário.
   */
  async update(
    id: string,
    data: Partial<Pick<UserRecord, "name" | "email" | "instagram_username">>
  ): Promise<SafeUser> {
    if (!supabase) throw new Error("Supabase não configurado.");

    const { data: record, error } = await supabase
      .from("users")
      .update({ ...data, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("id, name, instagram_username, email, balance_coins, lifetime_sc, last_synced_at, created_at, updated_at")
      .single();

    if (error) {
      if (error.code === "23505") {
        if (error.message.includes("email")) throw new Error("DUPLICATE_EMAIL");
        if (error.message.includes("instagram")) throw new Error("DUPLICATE_INSTAGRAM");
      }
      throw new Error(`Falha ao atualizar perfil: ${error.message}`);
    }

    return record as SafeUser;
  },

  /**
   * Soma um valor ao saldo de moedas do usuário.
   * Usa RPC para garantir atomicidade (sem race condition).
   */
  async incrementBalance(userId: string, amount: number): Promise<void> {
    if (!supabase) throw new Error("Supabase não configurado.");

    const { error } = await supabase.rpc("increment_user_balance", {
      p_user_id: userId,
      p_amount: amount,
    });

    if (error) throw new Error(`Falha ao incrementar saldo: ${error.message}`);
  },

  /**
   * Decrementa o saldo do usuário (para compras na loja).
   * Lança erro se o saldo for insuficiente.
   */
  async decrementBalance(userId: string, amount: number): Promise<void> {
    if (!supabase) throw new Error("Supabase não configurado.");

    // Verifica saldo atual antes de debitar
    const user = await this.findById(userId);
    if (!user) throw new Error("Usuário não encontrado.");
    if (user.balance_coins < amount) throw new Error("INSUFFICIENT_BALANCE");

    const { error } = await supabase
      .from("users")
      .update({ balance_coins: user.balance_coins - amount, updated_at: new Date().toISOString() })
      .eq("id", userId);

    if (error) throw new Error(`Falha ao debitar saldo: ${error.message}`);
  },

  /**
   * Busca os spotteds de um usuário com informações de farming.
   */
  async findUserPosts(userId: string): Promise<any[]> {
    if (!supabase) return [];

    const { data, error } = await supabase
      .from("spotteds")
      .select(
        "id, content, status, instagram_media_id, created_at, claimable_coins, claimed_coins, wants_coin, processed_likes, processed_comments, processed_shares"
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[USER_REPO] Erro ao buscar posts:", error);
      return [];
    }
    return data || [];
  },

  /**
   * Agrega as estatísticas de engajamento de todos os posts do usuário.
   */
  async getUserStats(userId: string): Promise<{
    total_likes: number;
    total_comments: number;
    total_shares: number;
    total_posts_approved: number;
    total_posts_pending: number;
    total_earned_lifetime: number;
  }> {
    if (!supabase) {
      return { total_likes: 0, total_comments: 0, total_shares: 0, total_posts_approved: 0, total_posts_pending: 0, total_earned_lifetime: 0 };
    }

    const { data, error } = await supabase
      .from("spotteds")
      .select("status, processed_likes, processed_comments, processed_shares, claimed_coins, claimable_coins")
      .eq("user_id", userId);

    if (error || !data) {
      return { total_likes: 0, total_comments: 0, total_shares: 0, total_posts_approved: 0, total_posts_pending: 0, total_earned_lifetime: 0 };
    }

    return data.reduce(
      (acc, post) => ({
        total_likes: acc.total_likes + (post.processed_likes || 0),
        total_comments: acc.total_comments + (post.processed_comments || 0),
        total_shares: acc.total_shares + (post.processed_shares || 0),
        total_posts_approved: acc.total_posts_approved + (post.status === "PUBLISHED" ? 1 : 0),
        total_posts_pending: acc.total_posts_pending + (post.status === "PENDING" ? 1 : 0),
        total_earned_lifetime: acc.total_earned_lifetime + (post.claimed_coins || 0) + (post.claimable_coins || 0),
      }),
      { total_likes: 0, total_comments: 0, total_shares: 0, total_posts_approved: 0, total_posts_pending: 0, total_earned_lifetime: 0 }
    );
  },

  /**
   * Retorna as transações do usuário.
   */
  async findUserTransactions(userId: string): Promise<any[]> {
    if (!supabase) return [];

    const { data, error } = await supabase
      .from("transactions")
      .select("id, amount, operation_type, reference_id, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) return [];
    return data || [];
  },

  /**
   * Calcula o percentil do usuário no ranking global.
   */
  async getUserPercentile(userLifetimeSc: number): Promise<number> {
    if (!supabase) return 100; // sem dados = pior ranking

    // Total de usuários
    const { count: totalUsers } = await supabase
      .from("users")
      .select("*", { count: "exact", head: true });

    if (!totalUsers || totalUsers === 0) return 100;

    // Quantos usuários têm MAIS lifetime_sc que este (estão à frente no ranking)
    const { count: aheadUsers } = await supabase
      .from("users")
      .select("*", { count: "exact", head: true })
      .gt("lifetime_sc", userLifetimeSc);

    const rank = (aheadUsers || 0) + 1; // posição 1-indexada no ranking

    // "Top X%" — menor = melhor.
    // Rank 1 de 1000 → Top 0.1% (elite)
    // Rank 1 de 2   → Top 50%
    // Rank 2 de 2   → Top 100% (último)
    return (rank / totalUsers) * 100;
  },
};
