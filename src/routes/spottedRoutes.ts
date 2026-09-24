import { Router } from "express";
import { sendSpotted, spottedUpload } from "../controllers/spottedController";

const router = Router();

router.post("/send", spottedUpload.single("image"), sendSpotted);

export default router;
