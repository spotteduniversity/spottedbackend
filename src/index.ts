import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import fs from "fs";
import os from "os";
import path from "path";
import spottedRoutes from "./routes/spottedRoutes";
import farmRoutes from "./routes/farmRoutes";
import authRoutes from "./routes/authRoutes";
import userRoutes from "./routes/userRoutes";
import storeRoutes from "./routes/storeRoutes";
import adminRoutes from "./routes/adminRoutes";
import adminAuthRoutes from "./routes/adminAuthRoutes";
import adminUsersRoutes from "./routes/adminUsersRoutes";
import adminAccountsRoutes from "./routes/adminAccountsRoutes";
import bandecoRoutes from "./routes/bandecoRoutes";

// Vercel Serverless canvas fontconfig workaround
const fontConfigDir = os.tmpdir();
const fontConfigPath = path.join(fontConfigDir, "fonts.conf");

if (!fs.existsSync(fontConfigPath)) {
  fs.writeFileSync(fontConfigPath, `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontConfigDir}</dir>
  <cachedir>${fontConfigDir}/fontconfig</cachedir>
</fontconfig>`);
}
process.env.FONTCONFIG_PATH = fontConfigDir;

const app = express();
const PORT = process.env.PORT || 3001;

const frontendUrl = process.env.FRONTEND_URL?.replace(/\/+$/, "") || "http://localhost:3000";

app.set("trust proxy", 1);

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: [frontendUrl, "http://localhost:3000", "https://spottedadmin.vercel.app", "https://lavrasspotted.vercel.app", "http://localhost:3002", "http://localhost:5173", "https://spottedunicamp.vercel.app", "https://admin-ruddy-two-71.vercel.app"], methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] }));
app.use(express.json({ limit: "10kb" }));

app.use("/posts", express.static(path.join(process.cwd(), "public", "posts")));

app.use("/api/spotted", rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 50,
  message: { success: false, message: "Rate limit exceeded." },
  standardHeaders: "draft-7",
  legacyHeaders: false,
}), spottedRoutes);

// Farm Engine: sincroniza engajamento e credita SC
// Rate limit: 2 req / 2h por IP (espelha o cooldown de 120min do motor)
app.use("/api/farm", farmRoutes);

// Auth: login e registro (rate limit mais restritivo para prevenir brute-force)
app.use("/api/auth", rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  limit: 10,
  message: { success: false, message: "Muitas tentativas. Aguarde 15 minutos." },
  standardHeaders: "draft-7",
  legacyHeaders: false,
}), authRoutes);

// Usuário: perfil, posts, stats
app.use("/api/users", userRoutes);

// Loja: produtos e pedidos
app.use("/api/store", storeRoutes);

// Admin: gerenciar aprovações
app.use("/api/admin", adminRoutes);
app.use("/api/admin/accounts", adminAccountsRoutes);
app.use("/api/admin/auth", adminAuthRoutes);
app.use("/api/admin/users", adminUsersRoutes);

// Bandeco: cardápio do RU (rotas abertas para cronjob externo)
app.use("/api/bandeco", bandecoRoutes);

app.get("/", (_req, res) => res.send("Spotted Unicamp Limeira Backend is running!"));

app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
  console.log(`🖼️  Serving images at /posts`);
  console.log(`🗄️  Supabase: ${process.env.SUPABASE_URL ? "Configured" : "Offline mode"}`);
});
