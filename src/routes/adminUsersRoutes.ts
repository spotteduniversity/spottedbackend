/**
 * adminUsersRoutes.ts
 *
 * Rotas para gerenciamento de admins.
 * Montadas em /api/admin/users
 */

import { Router } from "express";
import { requireAdmin, requireSuperAdmin } from "../middleware/adminAuth";
import { createAdmin } from "../controllers/adminUsersController";

const router = Router();

// Apenas super-admins podem criar novos administradores
router.post("/", requireAdmin, requireSuperAdmin, createAdmin);

export default router;
