/**
 * adminUsersRoutes.ts
 *
 * Rotas para gerenciamento de admins.
 * Montadas em /api/admin/users
 *
 * Leitura e escrita são restritas a super-admins: a tabela `admins` concede
 * poder sobre todas as contas, então um admin comum não pode ampliar o
 * próprio escopo nem criar outros administradores.
 */

import { Router } from "express";
import { requireAdmin, requireSuperAdmin } from "../middleware/adminAuth";
import {
  createAdmin,
  listAdmins,
  updateAdmin,
  deleteAdmin,
} from "../controllers/adminUsersController";

const router = Router();

// Apenas super-admins podem ver e gerenciar administradores
router.get("/", requireAdmin, requireSuperAdmin, listAdmins);
router.post("/", requireAdmin, requireSuperAdmin, createAdmin);
router.put("/:id", requireAdmin, requireSuperAdmin, updateAdmin);
router.delete("/:id", requireAdmin, requireSuperAdmin, deleteAdmin);

export default router;
