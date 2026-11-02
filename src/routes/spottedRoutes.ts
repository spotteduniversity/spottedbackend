import { Router } from "express";
import { sendSpotted } from "../controllers/spottedController";
import { assetUpload } from "../services/cityAssetsService";

const router = Router();

router.post("/send", assetUpload.single("image"), sendSpotted);

export default router;