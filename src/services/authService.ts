/**
 * authService.ts
 *
 * Funções utilitárias de autenticação:
 *  - Hash e comparação de senhas com bcrypt
 *  - Geração e verificação de JWT
 */

import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const SALT_ROUNDS = 12;
const JWT_SECRET = process.env.JWT_SECRET || "spotted_dev_secret_mude_em_producao";
const JWT_EXPIRES_IN = "30d"; // Token dura 30 dias

export interface JwtPayload {
  userId: string;
  email: string;
}

/**
 * Gera o hash de uma senha em texto puro.
 */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

/**
 * Verifica se uma senha bate com o hash armazenado.
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Assina um JWT com o payload do usuário.
 */
export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Verifica e decodifica um JWT. Lança erro se inválido ou expirado.
 */
export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}
