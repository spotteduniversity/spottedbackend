import { Router } from "express";
import { getAlmoco, getJantar } from "../controllers/bandecoController";

const router = Router();

router.get("/almoco", getAlmoco);
router.post("/almoco", getAlmoco);
router.get("/jantar", getJantar);
router.post("/jantar", getJantar);

export default router;