/**
 * auth.ts — Middleware de autenticação JWT
 *
 * Extrai o token do header Authorization: Bearer <token>
 * e injeta o payload decodificado em req.user.
 *
 * Uso em rotas protegidas:
 *   router.get("/me", requireAuth, userController.getMe)
 *
 * Uso em rotas opcionalmente autenticadas:
 *   router.post("/send", optionalAuth, spottedController.sendSpotted)
 */

import { Request, Response, NextFunction } from "express";
import { verifyToken, JwtPayload } from "../services/authService";

// Extende o tipo Request do Express para incluir o user
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

/**
 * Middleware que EXIGE autenticação.
 * Retorna 401 se o token estiver ausente ou inválido.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ success: false, message: "Token de autenticação ausente." });
    return;
  }

  const token = authHeader.split(" ")[1];

  try {
    const payload = verifyToken(token);
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ success: false, message: "Token inválido ou expirado." });
  }
}

/**
 * Middleware que tenta autenticar, mas não bloqueia se não houver token.
 * Usado em rotas onde o usuário pode estar logado ou não (ex: enviar spotted anônimo).
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    try {
      req.user = verifyToken(token);
    } catch {
      // Token inválido — ignora silenciosamente, continua como anônimo
      req.user = undefined;
    }
  }

  next();
}
