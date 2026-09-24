/**
 * adminAuth.ts — Middleware de autenticação e autorização de admins.
 *
 * Substitui o ADMIN_SECRET por JWT assinado com ADMIN_JWT_SECRET.
 *
 * Injeta `req.admin` com:
 *   { adminId, username, is_super, accountIds }
 *
 * Autorização por cidade:
 *   is_super     → acessa qualquer conta
 *   !is_super    → só acessa contas presentes em req.admin.accountIds
 *
 * Uso:
 *   router.get("/pending", requireAdmin, ...)
 *   router.get("/pending", requireAdmin, requireAccountAccess, ...)
 */

import { Request, Response, NextFunction } from "express";
import { verifyAdminToken, AdminJwtPayload } from "../services/adminAuthService";

// Extende o tipo Request do Express para incluir req.admin
declare global {
  namespace Express {
    interface Request {
      admin?: AdminJwtPayload;
    }
  }
}

/**
 * Exige um JWT de admin válido no header Authorization: Bearer <token>.
 * Injeta req.admin com o payload decodificado.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ success: false, message: "Token de admin ausente." });
    return;
  }

  const token = authHeader.split(" ")[1];

  try {
    req.admin = verifyAdminToken(token);
    next();
  } catch {
    res.status(401).json({ success: false, message: "Token de admin inválido ou expirado." });
  }
}

/**
 * Exige que o admin seja super (is_super = true).
 * Use após requireAdmin.
 */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.admin?.is_super) {
    res.status(403).json({ success: false, message: "Acesso restrito a super-admins." });
    return;
  }
  next();
}

/**
 * Verifica se o admin tem acesso à conta especificada no body/query/params.
 * Procura `instagram_account_id` em: req.body, req.query, req.params.
 * Use após requireAdmin.
 */
export function requireAccountAccess(req: Request, res: Response, next: NextFunction): void {
  const admin = req.admin;
  if (!admin) {
    res.status(401).json({ success: false, message: "Não autenticado." });
    return;
  }

  // Super admin tem acesso total
  if (admin.is_super) {
    next();
    return;
  }

  const accountId: string | undefined =
    req.body?.instagram_account_id ||
    req.query?.account_id as string ||
    req.params?.account_id;

  if (!accountId) {
    res.status(400).json({ success: false, message: "instagram_account_id é obrigatório." });
    return;
  }

  if (!admin.accountIds.includes(accountId)) {
    res.status(403).json({ success: false, message: "Sem permissão para esta conta." });
    return;
  }

  next();
}
