import { supabase } from "../config/supabase";
import fs from "fs";
import path from "path";

/**
 * Serviço para upload de imagens ao Supabase Storage.
 * O Instagram Graph API exige uma URL pública da imagem para postar.
 * Usamos o Supabase Storage como CDN intermediária.
 */
export const storageService = {
  /**
   * Faz upload de um arquivo para o Supabase Storage e retorna a URL pública.
   */
  async uploadFile(filePath: string, storagePath: string): Promise<string | null> {
    if (!supabase) {
      console.warn("Supabase não configurado. Upload ignorado.");
      return null;
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`Arquivo não encontrado: ${filePath}`);
    }

    const fileBuffer = fs.readFileSync(filePath);
    const contentType = filePath.endsWith(".png") ? "image/png" : "image/jpeg";

    const { error: uploadError } = await supabase.storage
      .from("spotted-posts")
      .upload(storagePath, fileBuffer, {
        contentType,
        upsert: true,
      });

    if (uploadError) {
      console.error("Erro no upload para Supabase Storage:", uploadError.message);
      throw new Error(`Falha no upload: ${uploadError.message}`);
    }

    const { data } = supabase.storage
      .from("spotted-posts")
      .getPublicUrl(storagePath);

    console.log(`✅ Upload concluído: ${data.publicUrl}`);
    return data.publicUrl;
  },

  /**
   * Faz upload de um buffer diretamente para o Supabase Storage.
   */
  async uploadBuffer(buffer: Buffer, storagePath: string, contentType: string = "image/png"): Promise<string | null> {
    if (!supabase) {
      console.warn("Supabase não configurado. Upload ignorado.");
      return null;
    }

    const { error: uploadError } = await supabase.storage
      .from("spotted-posts")
      .upload(storagePath, buffer, {
        contentType,
        upsert: true,
      });

    if (uploadError) {
      console.error("Erro no upload para Supabase Storage:", uploadError.message);
      throw new Error(`Falha no upload: ${uploadError.message}`);
    }

    const { data } = supabase.storage
      .from("spotted-posts")
      .getPublicUrl(storagePath);

    console.log(`✅ Upload de buffer concluído: ${data.publicUrl}`);
    return data.publicUrl;
  },

  /**
   * Upload do card gerado (spotted com texto).
   */
  async uploadCard(fileName: string): Promise<string | null> {
    const filePath = path.join(require("os").tmpdir(), "posts", fileName);
    return this.uploadFile(filePath, `cards/${fileName}`);
  },

  /**
   * Upload da imagem enviada pelo usuário (já comprimida pelo imageCompressionService).
   */
  async uploadUserImage(fileName: string): Promise<string | null> {
    const filePath = path.join(require("os").tmpdir(), "user-images", fileName);
    return this.uploadFile(filePath, `user-images/${fileName}`);
  },

  /**
   * Upload da imagem do Bandeco (cardápio do RU).
   */
  async uploadBandecoImage(buffer: Buffer, type: "almoco" | "jantar"): Promise<string | null> {
    const fileName = `bandeco_${type}_${Date.now()}.png`;
    return this.uploadBuffer(buffer, `bandeco/${fileName}`, "image/png");
  },
};
