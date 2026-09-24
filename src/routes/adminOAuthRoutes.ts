/**
 * adminOAuthRoutes.ts
 *
 * Rotas do fluxo OAuth para conectar contas do Instagram.
 * Montadas em /api/admin/oauth (ver index.ts).
 */

import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth";
import { oauthStart, oauthCallback } from "../controllers/adminOAuthController";

const router = Router();

/**
 * GET /api/admin/oauth/instagram/start?account_id=<uuid>
 * Inicia o fluxo OAuth, redireciona para a Meta.
 * Requer autenticação de admin.
 */
router.get("/instagram/start", requireAdmin, oauthStart);

/**
 * GET /api/admin/oauth/instagram/callback
 * Callback da Meta após autorização do usuário.
 * NÃO requer requireAdmin — a meta redireciona direto para cá sem o JWT.
 * A validação de identidade é feita pelo state (JWT de 10min).
 */
router.get("/instagram/callback", oauthCallback);

export default router;
