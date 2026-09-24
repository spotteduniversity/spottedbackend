import { supabase } from "../config/supabase";

export type PostStatus = "PENDING" | "PUBLISHED" | "FAILED" | "BLOCKED" | "REJECTED";

export interface SpottedRecord {
  id?: string;
  content: string;
  status: PostStatus;
  instagram_media_id?: string | null;
  instagram_account_id?: string;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  image_url?: string | null;      // URL da imagem enviada pelo usuário (Supabase Storage)
  ip_address: string;
  user_agent?: string | null;
  fingerprint?: string | null;
  user_id?: string | null;        // opcional — preenchido se usuário estiver logado
  wants_coin?: boolean;           // opcional — opta pelo programa de SC
  claimable_coins?: number;
  claimed_coins?: number;
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
   * Retorna o próximo ID sequencial para exibição (baseado na contagem total de registros).
   */
  async getNextDisplayId(): Promise<number> {
    if (!supabase) return Math.floor(10000 + Math.random() * 90000); // fallback aleatório

    const { count, error } = await supabase
      .from("spotteds")
      .select("*", { count: "exact", head: true });

    if (error) {
      console.error("Erro ao contar spotteds:", error.message);
      return Math.floor(10000 + Math.random() * 90000);
    }

    return (count || 0) + 1;
  },
};
