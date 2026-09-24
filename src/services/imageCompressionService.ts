import sharp from "sharp";
import fs from "fs";
import path from "path";
import os from "os";

// ── Constantes configuráveis ────────────────────────────────────────────────
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1350;
const JPEG_QUALITY = 85;

/** Magic bytes para validação real do tipo de arquivo */
const MAGIC_BYTES: Record<string, number[]> = {
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47],
};

// ── Tipos ───────────────────────────────────────────────────────────────────
interface ValidationResult {
  valid: boolean;
  error?: string;
}

// ── Serviço ─────────────────────────────────────────────────────────────────
export const imageCompressionService = {
  /**
   * Valida o buffer da imagem enviada pelo usuário.
   * Verifica magic bytes (não confia no Content-Type do client) e tamanho.
   */
  validateImage(buffer: Buffer): ValidationResult {
    if (!buffer || buffer.length === 0) {
      return { valid: false, error: "Arquivo vazio." };
    }

    if (buffer.length > MAX_FILE_SIZE) {
      const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
      return {
        valid: false,
        error: `Arquivo muito grande (${sizeMB} MB). O limite é ${MAX_FILE_SIZE / (1024 * 1024)} MB.`,
      };
    }

    // Verifica magic bytes para determinar o tipo real do arquivo
    const isValidType = Object.values(MAGIC_BYTES).some((magic) =>
      magic.every((byte, index) => buffer[index] === byte)
    );

    if (!isValidType) {
      return {
        valid: false,
        error: "Formato de imagem inválido. Envie apenas JPEG ou PNG.",
      };
    }

    return { valid: true };
  },

  /**
   * Comprime e redimensiona a imagem para o formato Instagram 4:5 (1080×1350).
   *
   * - Aplica rotação baseada em EXIF antes de remover metadados
   * - Crop inteligente centralizado (cover) para manter o enquadramento
   * - Remove TODOS os metadados (EXIF, GPS, ICC, etc.)
   * - Converte para JPEG com qualidade configurável
   *
   * @returns Caminho absoluto do arquivo processado
   */
  async compressAndResize(buffer: Buffer, outputFileName: string): Promise<string> {
    const outputDir = path.join(os.tmpdir(), "user-images");

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputPath = path.join(outputDir, outputFileName);

    await sharp(buffer)
      // .rotate() sem argumento aplica a rotação do EXIF e depois remove o metadata
      .rotate()
      // Redimensiona para 1080×1350 com crop centralizado
      .resize(OUTPUT_WIDTH, OUTPUT_HEIGHT, {
        fit: "cover",
        position: "centre",
      })
      // Remove todos os metadados (EXIF, GPS, ICC profile, etc.)
      .withMetadata({})
      // Converte para JPEG com qualidade configurável
      .jpeg({
        quality: JPEG_QUALITY,
        mozjpeg: true, // Usa mozjpeg para melhor compressão
      })
      .toFile(outputPath);

    const stats = fs.statSync(outputPath);
    console.log(
      `📸 Imagem processada: ${outputFileName} (${(stats.size / 1024).toFixed(0)} KB)`
    );

    return outputPath;
  },
};
