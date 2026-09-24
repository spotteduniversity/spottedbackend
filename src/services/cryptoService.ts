/**
 * cryptoService.ts
 *
 * Criptografia simétrica AES-256-GCM para tokens de acesso do Instagram.
 *
 * Formato armazenado: "<iv_hex>:<tag_hex>:<ciphertext_hex>"
 *
 * Variável de ambiente obrigatória:
 *   TOKEN_ENCRYPTION_KEY — 64 caracteres hex (32 bytes)
 *   Gere com: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * NUNCA retornar o plaintext em responses de API.
 * NUNCA logar o plaintext.
 */

import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;   // 96 bits — recomendado para GCM
const TAG_LENGTH = 16;  // 128 bits — padrão GCM

function getKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw || raw.length !== 64) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY inválida ou ausente. " +
      "Deve ter exatamente 64 caracteres hex (32 bytes). " +
      "Gere com: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return Buffer.from(raw, "hex");
}

/**
 * Criptografa um plaintext com AES-256-GCM.
 * Retorna a string "iv:tag:ciphertext" em hex.
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [iv.toString("hex"), tag.toString("hex"), encrypted.toString("hex")].join(":");
}

/**
 * Descriptografa uma string no formato "iv:tag:ciphertext".
 * Lança erro se o dado estiver corrompido ou a chave for diferente.
 */
export function decrypt(ciphertext: string): string {
  const key = getKey();
  const parts = ciphertext.split(":");

  if (parts.length !== 3) {
    throw new Error("Formato de ciphertext inválido. Esperado: iv:tag:ciphertext");
  }

  const [ivHex, tagHex, encHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const encrypted = Buffer.from(encHex, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
