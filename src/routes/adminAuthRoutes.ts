/**
 * adminAuthRoutes.ts
 *
 * Rotas de autenticação do painel admin.
 * Montadas em /api/admin/auth (ver index.ts).
 */

import { Router } from "express";
import rateLimit from "express-rate-limit";
import { adminLogin, adminMe } from "../controllers/adminAuthController";
import { requireAdmin } from "../middleware/adminAuth";

const router = Router();

// Rate limit anti-brute-force para login de admin (mais restritivo que o de usuários)
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  limit: 5,                  // máx 5 tentativas por IP
  message: { success: false, message: "Muitas tentativas de login. Aguarde 15 minutos." },
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

/** POST /api/admin/auth/login — Login com username + senha, retorna JWT */
router.post("/login", adminLoginLimiter, adminLogin);

/** GET /api/admin/auth/me — Dados do admin logado + contas vinculadas */
router.get("/me", requireAdmin, adminMe);

export default router;
