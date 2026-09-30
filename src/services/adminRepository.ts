/**
 * adminRepository.ts
 *
 * CRUD de admins e lookup de contas do Instagram vinculadas.
 * Acessa as tabelas `admins` e `admin_instagram_accounts` via service role.
 *
 * RLS está habilitado nessas tabelas sem policies públicas —
 * acesso exclusivo pelo backend com SUPABASE_SERVICE_KEY.
 */

import { supabase } from "../config/supabase";

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface AdminRecord {
  id: string;
  username: string;
  password_hash: string;
  is_super: boolean;
  created_at: string;
  updated_at: string;
}

export type SafeAdmin = Omit<AdminRecord, "password_hash">;

export interface InstagramAccountSummary {
  id: string;
  username: string;
  ig_user_id: string;
  display_name: string | null;
  connection_status: string;
  needs_reauth: boolean;
  last_error: string | null;
  base_image_path: string | null;
  text_card_template_path: string | null;
  text_color: string;
  shadow_color: string;
  base_caption: string | null;
  token_expires_at: string | null;
  token_refreshed_at: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Repository ──────────────────────────────────────────────────────────────

export const adminRepository = {
  /**
   * Busca admin por username (inclui password_hash para login).
   */
  async findByUsernameWithHash(username: string): Promise<AdminRecord | null> {
    if (!supabase) return null;

    const { data, error } = await supabase
      .from("admins")
      .select("*")
      .eq("username", username.toLowerCase().trim())
      .single();

    if (error || !data) return null;
    return data as AdminRecord;
  },

  /**
   * Busca admin por ID (sem password_hash).
   */
  async findById(id: string): Promise<SafeAdmin | null> {
    if (!supabase) return null;

    const { data, error } = await supabase
      .from("admins")
      .select("id, username, is_super, created_at, updated_at")
      .eq("id", id)
      .single();

    if (error || !data) return null;
    return data as SafeAdmin;
  },

  /**
   * Cria um novo admin (usado pelo script CLI de seed).
   */
  async create(data: {
    username: string;
    password_hash: string;
    is_super?: boolean;
  }): Promise<SafeAdmin> {
    if (!supabase) throw new Error("Supabase não configurado.");

    const { data: record, error } = await supabase
      .from("admins")
      .insert({
        username: data.username.toLowerCase().trim(),
        password_hash: data.password_hash,
        is_super: data.is_super ?? false,
      })
      .select("id, username, is_super, created_at, updated_at")
      .single();

    if (error) {
      if (error.code === "23505") throw new Error("DUPLICATE_USERNAME");
      throw new Error(`Falha ao criar admin: ${error.message}`);
    }

    return record as SafeAdmin;
  },

  /**
   * Lista todos os admins com as contas vinculadas de cada um.
   */
  async listAll(): Promise<Array<SafeAdmin & { account_ids: string[] }>> {
    if (!supabase) return [];

    const { data, error } = await supabase
      .from("admins")
      .select("id, username, is_super, created_at, updated_at")
      .order("created_at", { ascending: true });

    if (error || !data) return [];

    const { data: links } = await supabase
      .from("admin_instagram_accounts")
      .select("admin_id, instagram_account_id");

    const byAdmin = new Map<string, string[]>();
    for (const link of links ?? []) {
      const list = byAdmin.get(link.admin_id) ?? [];
      list.push(link.instagram_account_id);
      byAdmin.set(link.admin_id, list);
    }

    return data.map((admin) => ({
      ...(admin as SafeAdmin),
      account_ids: byAdmin.get(admin.id) ?? [],
    }));
  },

  /**
   * Atualiza username, flag de super e/ou senha de um admin existente.
   * Campos ausentes ficam intactos.
   */
  async update(
    id: string,
    data: { username?: string; password_hash?: string; is_super?: boolean }
  ): Promise<SafeAdmin> {
    if (!supabase) throw new Error("Supabase não configurado.");

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (data.username !== undefined) patch.username = data.username.toLowerCase().trim();
    if (data.password_hash !== undefined) patch.password_hash = data.password_hash;
    if (data.is_super !== undefined) patch.is_super = data.is_super;

    const { data: record, error } = await supabase
      .from("admins")
      .update(patch)
      .eq("id", id)
      .select("id, username, is_super, created_at, updated_at")
      .single();

    if (error) {
      if (error.code === "23505") throw new Error("DUPLICATE_USERNAME");
      throw new Error(`Falha ao atualizar admin: ${error.message}`);
    }

    return record as SafeAdmin;
  },

  /**
   * Remove um admin e todas as suas vinculações com contas.
   */
  async remove(id: string): Promise<void> {
    if (!supabase) throw new Error("Supabase não configurado.");

    const { error: linkError } = await supabase
      .from("admin_instagram_accounts")
      .delete()
      .eq("admin_id", id);

    if (linkError) throw new Error(`Falha ao desvincular contas: ${linkError.message}`);

    const { error } = await supabase.from("admins").delete().eq("id", id);
    if (error) throw new Error(`Falha ao remover admin: ${error.message}`);
  },

  /**
   * Substitui o conjunto de contas de um admin pelo array recebido.
   */
  async setAccounts(adminId: string, accountIds: string[]): Promise<void> {
    if (!supabase) throw new Error("Supabase não configurado.");

    const { error: deleteError } = await supabase
      .from("admin_instagram_accounts")
      .delete()
      .eq("admin_id", adminId);

    if (deleteError) {
      throw new Error(`Falha ao limpar vínculos: ${deleteError.message}`);
    }

    if (accountIds.length === 0) return;

    const { error } = await supabase.from("admin_instagram_accounts").insert(
      accountIds.map((instagram_account_id) => ({
        admin_id: adminId,
        instagram_account_id,
      }))
    );

    if (error) throw new Error(`Falha ao vincular contas: ${error.message}`);
  },

  /**
   * Conta quantos super-admins ativos existem. Usado para impedir que o
   * sistema fique sem nenhum super-admin.
   */
  async countSuperAdmins(): Promise<number> {
    if (!supabase) return 0;

    const { count, error } = await supabase
      .from("admins")
      .select("id", { count: "exact", head: true })
      .eq("is_super", true);

    if (error) return 0;
    return count ?? 0;
  },

  /**
   * Retorna os IDs das contas do Instagram que um admin pode gerenciar.
   * is_super → retorna todas as contas.
   */
  async getAccountIds(adminId: string, is_super: boolean): Promise<string[]> {
    if (!supabase) return [];

    if (is_super) {
      const { data, error } = await supabase
        .from("instagram_accounts")
        .select("id");

      if (error || !data) return [];
      return data.map((row) => row.id);
    }

    const { data, error } = await supabase
      .from("admin_instagram_accounts")
      .select("instagram_account_id")
      .eq("admin_id", adminId);

    if (error || !data) return [];
    return data.map((row) => row.instagram_account_id);
  },

  /**
   * Retorna os dados das contas do Instagram que o admin pode ver.
   * Nunca retorna o token — apenas metadados.
   */
  async getAccounts(
    adminId: string,
    is_super: boolean
  ): Promise<InstagramAccountSummary[]> {
    if (!supabase) return [];

    const SELECT_COLS = `
      id, username, ig_user_id, display_name,
      connection_status, needs_reauth, last_error,
      base_image_path, text_card_template_path,
      text_color, shadow_color,
      base_caption,
      token_expires_at, token_refreshed_at,
      created_at, updated_at
    `;

    if (is_super) {
      const { data, error } = await supabase
        .from("instagram_accounts")
        .select(SELECT_COLS)
        .order("created_at");

      if (error) {
        console.error("[ADMIN_REPO] getAccounts (super) falhou:", error.message);
        return [];
      }
      if (!data) return [];
      return data as InstagramAccountSummary[];
    }

    // Para admin não-super: JOIN via admin_instagram_accounts
    const { data, error } = await supabase
      .from("instagram_accounts")
      .select(`${SELECT_COLS}, admin_instagram_accounts!inner(admin_id)`)
      .eq("admin_instagram_accounts.admin_id", adminId)
      .order("created_at");

    if (error) {
      console.error("[ADMIN_REPO] getAccounts (vinculado) falhou:", error.message);
      return [];
    }
    if (!data) return [];
    return data as InstagramAccountSummary[];
  },

  /**
   * Retorna o token descriptografado de uma conta.
   * USO INTERNO APENAS — nunca expor em responses de API.
   */
  async getEncryptedToken(accountId: string): Promise<string | null> {
    if (!supabase) return null;

    const { data, error } = await supabase
      .from("instagram_accounts")
      .select("access_token_encrypted")
      .eq("id", accountId)
      .single();

    if (error || !data) return null;
    return data.access_token_encrypted ?? null;
  },

  /**
   * Atualiza os dados de conexão de uma conta. Usado tanto ao salvar
   * credenciais quanto ao marcar a conta para reconexão após erro de token.
   */
  async updateConnection(
    accountId: string,
    patch: {
      username?: string;
      ig_user_id?: string;
      access_token_encrypted?: string;
      token_expires_at?: string;
      token_refreshed_at?: string;
      connection_status?: string;
      needs_reauth?: boolean;
      last_error?: string | null;
    }
  ): Promise<void> {
    if (!supabase) return;

    const { error } = await supabase
      .from("instagram_accounts")
      .update(patch)
      .eq("id", accountId);

    if (error) {
      throw new Error(`Falha ao atualizar conta: ${error.message}`);
    }
  },

  /**
   * Cria uma nova conta do Instagram (ou atualiza se ig_user_id já existir).
   */
  async upsertAccount(data: {
    username: string;
    ig_user_id: string;
    display_name?: string;
    access_token_encrypted: string;
    token_expires_at: string;
    token_refreshed_at: string;
    connection_status: string;
    base_image_path?: string;
    text_card_template_path?: string;
  }): Promise<InstagramAccountSummary> {
    if (!supabase) throw new Error("Supabase não configurado.");

    const { data: record, error } = await supabase
      .from("instagram_accounts")
      .upsert(data, { onConflict: "ig_user_id" })
      .select(
        "id, username, ig_user_id, display_name, connection_status, needs_reauth, last_error, base_image_path, text_card_template_path, text_color, shadow_color, base_caption, token_expires_at, token_refreshed_at, created_at, updated_at"
      )
      .single();

    if (error) throw new Error(`Falha ao upsert conta: ${error.message}`);
    return record as InstagramAccountSummary;
  },

  /**
   * Vincula um admin a uma conta do Instagram.
   */
  async linkAdminToAccount(adminId: string, accountId: string): Promise<void> {
    if (!supabase) throw new Error("Supabase não configurado.");

    const { error } = await supabase
      .from("admin_instagram_accounts")
      .upsert(
        { admin_id: adminId, instagram_account_id: accountId },
        { onConflict: "admin_id,instagram_account_id" }
      );

    if (error) throw new Error(`Falha ao vincular admin: ${error.message}`);
  },

  /**
   * Retorna todas as contas que precisam de renovação de token.
   * Usado pelo job de renovação automática.
   */
  async getAccountsNeedingRefresh(daysBeforeExpiry: number = 10): Promise<
    Array<{ id: string; access_token_encrypted: string; token_expires_at: string }>
  > {
    if (!supabase) return [];

    const cutoff = new Date(
      Date.now() + daysBeforeExpiry * 24 * 60 * 60 * 1000
    ).toISOString();

    const { data, error } = await supabase
      .from("instagram_accounts")
      .select("id, access_token_encrypted, token_expires_at")
      .eq("connection_status", "ok")
      .eq("needs_reauth", false)
      .not("access_token_encrypted", "is", null)
      .lt("token_expires_at", cutoff);

    if (error || !data) return [];
    return data;
  },
};
