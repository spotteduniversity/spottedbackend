import { supabase } from "../config/supabase";

export type PostStatus = "PENDING" | "PUBLISHED" | "FAILED" | "BLOCKED";

export interface SpottedRecord {
  id?: string;
  content: string;
  status: PostStatus;
  instagram_media_id?: string | null;
  instagram_account_id?: string;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  image_url?: string | null;
  ip_address: string;
  user_agent?: string | null;
  fingerprint?: string | null;
  user_id?: string | null;
  wants_coin?: boolean;
  claimable_coins?: number;
  claimed_coins?: number;
  display_id?: number | null;
  created_at?: string;
  updated_at?: string;
}

export const spottedRepository = {
  /**
   * Cria um novo registro de spotted no Supabase.
   */
  async create(data: {
    content: string;
    ip_address: string;
    instagram_account_id: string;
    user_agent?: string;
    fingerprint?: string;
    status: PostStatus;
    user_id?: string;
    wants_coin?: boolean;
    image_url?: string;
  }): Promise<SpottedRecord> {
    if (!supabase) throw new Error("Supabase não configurado.");

    const { data: record, error } = await supabase
      .from("spotteds")
      .insert({
        content: data.content,
        ip_address: data.ip_address,
        instagram_account_id: data.instagram_account_id,
        user_agent: data.user_agent,
        fingerprint: data.fingerprint,
        status: data.status,
        user_id: data.user_id,
        wants_coin: data.wants_coin || false,
        image_url: data.image_url || null,
      })
      .select()
      .single();

    if (error) {
      console.error("Erro ao inserir spotted no Supabase:", error.message);
      throw new Error(`Falha ao salvar no banco: ${error.message}`);
    }

    return record as SpottedRecord;
  },

  /**
   * Atualiza o status de um spotted (ex: PENDING -> PUBLISHED).
   */
  async updateStatus(id: string, status: PostStatus, instagramMediaId?: string): Promise<void> {
    if (!supabase) return;

    const updateData: Partial<SpottedRecord> = { status };
    if (instagramMediaId) {
      updateData.instagram_media_id = instagramMediaId;
    }

    const { error } = await supabase
      .from("spotteds")
      .update(updateData)
      .eq("id", id);

    if (error) {
      console.error(`Erro ao atualizar spotted ${id}:`, error.message);
      throw new Error(`Falha ao atualizar no banco: ${error.message}`);
    }
  },

  /**
   * Busca um spotted pelo ID.
   */
  async findById(id: string): Promise<SpottedRecord | null> {
    if (!supabase) return null;

    const { data, error } = await supabase
      .from("spotteds")
      .select("*")
      .eq("id", id)
      .single();

    if (error) return null;
    return data as SpottedRecord;
  },

  /**
   * Reserva e retorna o próximo número de exibição para a conta.
   * Se o post já tiver display_id (retry), reusa o existente.
   * Usa RPC atômico para evitar corrida entre aprovações simultâneas.
   */
  async getOrReserveDisplayId(
    instagram_account_id: string,
    existingDisplayId?: number | null
  ): Promise<number> {
    if (!supabase) throw new Error("Supabase não configurado.");

    // Se já reservou (retry), reusa
    if (existingDisplayId && existingDisplayId > 0) {
      return existingDisplayId;
    }

    const { data, error } = await supabase.rpc("next_display_id", {
      p_account: instagram_account_id,
    });

    if (error) {
      console.error("Erro ao reservar display_id:", error.message);
      throw new Error(`Falha ao reservar número do post: ${error.message}`);
    }

    const displayId = Number(data);
    if (!Number.isInteger(displayId) || displayId <= 0) {
      throw new Error("next_display_id retornou valor inválido");
    }
    return displayId;
  },

  /**
   * Retorna o próximo ID sequencial para exibição baseado APENAS em posts PUBLICADOS da conta.
   * @deprecated Use getOrReserveDisplayId no fluxo de aprovação.
   * Mantido apenas para compatibilidade/preview.
   */
  async getNextPublishedId(instagram_account_id: string): Promise<number> {
    if (!supabase) throw new Error("Supabase não configurado.");

    const { count, error } = await supabase
      .from("spotteds")
      .select("*", { count: "exact", head: true })
      .eq("instagram_account_id", instagram_account_id)
      .eq("status", "PUBLISHED");

    if (error) {
      console.error("Erro ao contar spotteds publicados:", error.message);
      throw new Error(`Falha ao contar posts publicados: ${error.message}`);
    }

    return (count || 0) + 1;
  },

  /**
   * @deprecated Use getNextPublishedId no fluxo de aprovação.
   * Este método conta TODOS os posts (incluindo pendentes/rejeitados) e NÃO deve ser usado para o número do Instagram.
   * Mantido apenas para compatibilidade com preview do submit (número provisório).
   */
  async getNextDisplayId(instagram_account_id?: string): Promise<number> {
    if (!supabase) throw new Error("Supabase não configurado.");

    let query = supabase.from("spotteds").select("*", { count: "exact", head: true });

    if (instagram_account_id) {
      query = query.eq("instagram_account_id", instagram_account_id);
    }

    const { count, error } = await query;

    if (error) {
      console.error("Erro ao contar spotteds:", error.message);
      throw new Error(`Falha ao contar posts: ${error.message}`);
    }

    return (count || 0) + 1;
  },
};
