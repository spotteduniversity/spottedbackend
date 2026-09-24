import { Router } from "express";
import { register, login, getMe } from "../controllers/authController";
import { requireAuth } from "../middleware/auth";

const router = Router();

/** POST /api/auth/register — Cria conta */
router.post("/register", register);

/** POST /api/auth/login — Faz login, retorna JWT */
router.post("/login", login);

/** GET /api/auth/me — Retorna dados do usuário logado */
router.get("/me", requireAuth, getMe);

export default router;
