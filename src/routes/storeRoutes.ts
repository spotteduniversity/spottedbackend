import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { listProducts, createOrder, getUserOrders } from "../controllers/storeController";

const router = Router();

/** GET  /api/store/products  — Lista produtos ativos (público) */
router.get("/products", listProducts);

/** POST /api/store/orders    — Compra um produto (exige login) */
router.post("/orders", requireAuth, createOrder);

/** GET  /api/store/orders/me — Histórico de pedidos (exige login) */
router.get("/orders/me", requireAuth, getUserOrders);

export default router;
