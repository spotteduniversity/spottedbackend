/**
 * adminAuthService.ts
 *
 * Autenticação de admins: hash de senha e JWT dedicado.
 *
 * IMPORTANTE: usa ADMIN_JWT_SECRET separado do JWT_SECRET dos usuários comuns.
 * Isso evita elevação de privilégio cruzada (um token de user não vira token de admin).
 *
 * Variáveis de ambiente:
 *   ADMIN_JWT_SECRET — segredo para assinar JWTs de admin (diferente de JWT_SECRET)
 *   Gere com: node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
 */

import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const SALT_ROUNDS = 12;
const ADMIN_JWT_EXPIRES_IN = "8h";

function getAdminJwtSecret(): string {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) {
    throw new Error(
      "ADMIN_JWT_SECRET não configurado. " +
      "Gere com: node -e \"console.log(require('crypto').randomBytes(48).toString('base64'))\""
    );
  }
  return secret;
}

// ─── Payload do JWT de admin ──────────────────────────────────────────────────

export interface AdminJwtPayload {
  adminId: string;
  username: string;
  is_super: boolean;
  /** IDs das contas que este admin pode gerenciar (vazio = nenhuma, ignorado se is_super) */
  accountIds: string[];
}

// ─── Funções ──────────────────────────────────────────────────────────────────

/**
 * Gera o hash bcrypt de uma senha em texto puro.
 */
export async function hashAdminPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

/**
 * Verifica se uma senha bate com o hash armazenado.
 */
export async function verifyAdminPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Assina um JWT de admin com expiração de 8h.
 */
export function signAdminToken(payload: AdminJwtPayload): string {
  return jwt.sign(payload, getAdminJwtSecret(), { expiresIn: ADMIN_JWT_EXPIRES_IN });
}

/**
 * Verifica e decodifica um JWT de admin.
 * Lança erro se inválido, expirado ou assinado com o segredo errado.
 */
export function verifyAdminToken(token: string): AdminJwtPayload {
  return jwt.verify(token, getAdminJwtSecret()) as AdminJwtPayload;
}
