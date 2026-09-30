/**
 * cityAssetsService.ts
 *
 * Gerencia as imagens de branding de cada cidade (conta do Instagram).
 *
 * Bucket: spotted-assets (PÚBLICO — URL direta)
 * Estrutura:
 *   {instagram_account_id}/base.jpg          — foto de encerramento (slide final do carrossel)
 *   {instagram_account_id}/template.jpg      — template de fundo do card de texto (slide 1)
 *
 * Upload: admin panel envia arquivo -> processa com sharp -> sobe pro bucket público -> retorna URL pública
 * Publicação: adminRoutes lê a URL direto do banco e passa pra Meta.
 *
 * Não há cache de download nem signed URL — a URL pública já é acessível pela Meta.
 */

import { supabase } from "../config/supabase";
import multer from "multer";
import sharp from "sharp";

const BUCKET = "spotted-assets";
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB
const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1350;
const JPEG_QUALITY = 88;

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

export const assetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(new Error("Formato aceito: PNG, JPEG ou WebP."));
      return;
    }
    cb(null, true);
  },
});

async function processAssetBuffer(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .rotate()
    .flatten({ background: "#fff" })
    .resize(OUTPUT_WIDTH, OUTPUT_HEIGHT, {
      fit: "cover",
      position: "centre",
    })
    .toColorspace("srgb")
    .jpeg({
      quality: JPEG_QUALITY,
      progressive: false,
      mozjpeg: true,
    })
    .toBuffer();
}

export const cityAssetsService = {
  /**
   * Faz upload de uma imagem de branding para o bucket público spotted-assets.
   * Processa a imagem (rotate, flatten, resize 1080x1350, sRGB, JPEG 88).
   * Retorna a URL pública completa com cache-busting (para gravar em instagram_accounts).
   */
  async uploadAsset(
    buffer: Buffer,
    type: "base" | "template",
    accountId: string,
    contentType: "image/png" | "image/jpeg" | "image/webp"
  ): Promise<string> {
    if (!supabase) throw new Error("Supabase não configurado.");

    const processedBuffer = await processAssetBuffer(buffer);

    const fileName = type === "base" ? "base.jpg" : "template.jpg";
    const storagePath = `${accountId}/${fileName}`;

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, processedBuffer, {
        contentType: "image/jpeg",
        upsert: true,
      });

    if (error) throw new Error(`Falha ao fazer upload do asset: ${error.message}`);

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
    const cacheBust = `?v=${Date.now()}`;
    return `${data.publicUrl}${cacheBust}`;
  },

  /**
   * Deleta os assets de uma conta (útil se a conta for arquivada/removida no futuro).
   */
  async deleteAssets(accountId: string): Promise<void> {
    if (!supabase) return;
    await supabase.storage.from(BUCKET).remove([`${accountId}/base.jpg`, `${accountId}/template.jpg`]);
  },
};