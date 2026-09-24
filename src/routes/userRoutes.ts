import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import {
  getProfile,
  updateProfile,
  getUserPosts,
  getUserStats,
  getUserTransactions,
} from "../controllers/userController";

const router = Router();

// Todas as rotas de usuário exigem autenticação
router.use(requireAuth);

/** GET  /api/users/me              — Perfil + saldo */
router.get("/me", getProfile);

/** PATCH /api/users/me             — Editar nome, email, instagram */
router.patch("/me", updateProfile);

/** GET  /api/users/me/posts        — Posts do usuário com status de farm */
router.get("/me/posts", getUserPosts);

/** GET  /api/users/me/stats        — Engajamento total + tier de gamificação */
router.get("/me/stats", getUserStats);

/** GET  /api/users/me/transactions — Histórico de transações SC */
router.get("/me/transactions", getUserTransactions);

export default router;
