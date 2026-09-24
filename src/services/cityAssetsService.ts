/**
 * cityAssetsService.ts
 *
 * Gerencia as imagens de branding de cada cidade (conta do Instagram).
 *
 * Bucket: city-assets (PRIVADO — sem URL pública)
 * Estrutura:
 *   {instagram_account_id}/base.png          — imagem de branding (slide final do carrossel)
 *   {instagram_account_id}/text_card_template.jpg — template de fundo do card de texto
 *   default/base.png                         — fallback global
 *   default/text_card_template.jpg           — fallback global
 *
 * O backend baixa a imagem com service role, compõe o card e faz upload do resultado
 * para o bucket spotted-posts (público), que é o que a Meta usa para publicar.
 *
 * Cache em memória: imagens mudam raramente, então cacheia por accountId dentro da
 * instância serverless para evitar download repetido por post aprovado.
 */

import { supabase } from "../config/supabase";

const BUCKET = "city-assets";
const DEFAULT_BASE_PATH = "default/base.png";
const DEFAULT_TEMPLATE_PATH = "default/text_card_template.jpg";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos (razoável para serverless)

// ─── Cache simples em memória ─────────────────────────────────────────────────

interface CacheEntry {
  buffer: Buffer;
  expiresAt: number;
}

const imageCache = new Map<string, CacheEntry>();

function getCached(key: string): Buffer | null {
  const entry = imageCache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    imageCache.delete(key);
    return null;
  }
  return entry.buffer;
}

function setCache(key: string, buffer: Buffer): void {
  imageCache.set(key, { buffer, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── Download privado ─────────────────────────────────────────────────────────

/**
 * Baixa um arquivo do bucket privado city-assets via service role.
 * Retorna Buffer ou null se o arquivo não existir.
 */
async function downloadAsset(path: string): Promise<Buffer | null> {
  if (!supabase) return null;

  const cached = getCached(path);
  if (cached) return cached;

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .download(path);

  if (error || !data) {
    // Arquivo não encontrado não é erro fatal — caller vai usar fallback
    return null;
  }

  const arrayBuffer = await data.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  setCache(path, buffer);
  return buffer;
}

// ─── Serviço público ──────────────────────────────────────────────────────────

export const cityAssetsService = {
  /**
   * Retorna o buffer da imagem de branding (slide final do carrossel) para uma conta.
   * Fallback automático para default/base.png se a conta não tiver a sua própria.
   */
  async getBaseImage(accountBasePath: string | null | undefined): Promise<Buffer | null> {
    if (accountBasePath) {
      const buf = await downloadAsset(accountBasePath);
      if (buf) return buf;
      console.warn(`[ASSETS] base_image_path "${accountBasePath}" não encontrado. Usando default.`);
    }
    return downloadAsset(DEFAULT_BASE_PATH);
  },

  /**
   * Retorna o buffer do template de fundo do card de texto para uma conta.
   * Fallback automático para default/text_card_template.jpg.
   */
  async getTextCardTemplate(accountTemplatePath: string | null | undefined): Promise<Buffer | null> {
    if (accountTemplatePath) {
      const buf = await downloadAsset(accountTemplatePath);
      if (buf) return buf;
      console.warn(`[ASSETS] text_card_template_path "${accountTemplatePath}" não encontrado. Usando default.`);
    }
    return downloadAsset(DEFAULT_TEMPLATE_PATH);
  },

  /**
   * Invalida o cache para uma conta específica.
   * Chamar após upload de nova imagem via painel.
   */
  invalidateCache(accountId: string): void {
    for (const key of imageCache.keys()) {
      if (key.startsWith(accountId)) {
        imageCache.delete(key);
      }
    }
    // Invalidar também o default caso tenha mudado
    imageCache.delete(DEFAULT_BASE_PATH);
    imageCache.delete(DEFAULT_TEMPLATE_PATH);
  },

  /**
   * Cria uma URL assinada (temporária, 1 hora) para a imagem de branding (base).
   * A Meta precisa de uma URL pública para baixar a imagem.
   */
  async getSignedBaseImageUrl(accountBasePath: string | null | undefined): Promise<string | null> {
    if (!supabase) return null;
    const path = accountBasePath || DEFAULT_BASE_PATH;
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60 * 60);
    if (error || !data) return null;
    return data.signedUrl;
  },

  /**
   * Faz upload de uma imagem de branding para o bucket city-assets.
   * Valida dimensões mínimas antes do upload.
   * Retorna o path relativo armazenado (para gravar em instagram_accounts).
   */
  async uploadAsset(
    buffer: Buffer,
    type: "base" | "text_card_template",
    accountId: string,
    contentType: "image/png" | "image/jpeg"
  ): Promise<string> {
    if (!supabase) throw new Error("Supabase não configurado.");

    const ext = contentType === "image/png" ? "png" : "jpg";
    const fileName = type === "base" ? `base.${ext}` : `text_card_template.${ext}`;
    const storagePath = `${accountId}/${fileName}`;

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, buffer, {
        contentType,
        upsert: true,
      });

    if (error) throw new Error(`Falha ao fazer upload do asset: ${error.message}`);

    // Invalida cache
    imageCache.delete(storagePath);

    return storagePath;
  },
};
