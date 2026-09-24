import { Router } from "express";
import { syncFarm } from "../controllers/farmController";
import { claimCoins } from "../controllers/claimController";
import { requireAuth } from "../middleware/auth";

const router = Router();

/**
 * POST /api/farm/sync
 * Aciona a sincronização em lote de engajamento do usuário logado
 * e credita SpottedCoins. (Exige autenticação)
 */
router.post("/sync", requireAuth, syncFarm);

/**
 * POST /api/farm/claim/:spottedId
 * Move as moedas disponíveis do spotted para a carteira do usuário. (Exige autenticação)
 */
router.post("/claim/:spottedId", requireAuth, claimCoins);

export default router;
