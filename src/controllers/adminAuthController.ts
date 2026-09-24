/**
 * adminAuthController.ts
 *
 * Endpoints de autenticação de admins:
 *   POST /api/admin/auth/login  — Login com username + senha, retorna JWT (8h)
 *   GET  /api/admin/auth/me     — Retorna dados do admin logado + contas vinculadas
 */

import { Request, Response } from "express";
import { verifyAdminPassword, signAdminToken } from "../services/adminAuthService";
import { adminRepository } from "../services/adminRepository";

// ─── LOGIN ────────────────────────────────────────────────────────────────────

export async function adminLogin(req: Request, res: Response): Promise<void> {
  const { username, password } = req.body;

  if (!username || !password) {
    res.status(400).json({ success: false, message: "username e password são obrigatórios." });
    return;
  }

  try {
    const admin = await adminRepository.findByUsernameWithHash(username);

    // Mensagem genérica para não vazar se o username existe
    if (!admin) {
      res.status(401).json({ success: false, message: "Credenciais inválidas." });
      return;
    }

    const passwordMatch = await verifyAdminPassword(password, admin.password_hash);
    if (!passwordMatch) {
      res.status(401).json({ success: false, message: "Credenciais inválidas." });
      return;
    }

    // Busca as contas que o admin pode gerenciar para embutir no token
    const accountIds = await adminRepository.getAccountIds(admin.id, admin.is_super);

    const token = signAdminToken({
      adminId: admin.id,
      username: admin.username,
      is_super: admin.is_super,
      accountIds,
    });

    res.status(200).json({
      success: true,
      message: "Login realizado com sucesso.",
      token,
      admin: {
        id: admin.id,
        username: admin.username,
        is_super: admin.is_super,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    console.error("[ADMIN_AUTH] Erro no login:", message);
    res.status(500).json({ success: false, message: "Erro interno ao fazer login." });
  }
}

// ─── ME ───────────────────────────────────────────────────────────────────────

export async function adminMe(req: Request, res: Response): Promise<void> {
  try {
    const adminId = req.admin!.adminId;

    const admin = await adminRepository.findById(adminId);
    if (!admin) {
      res.status(404).json({ success: false, message: "Admin não encontrado." });
      return;
    }

    // Retorna os metadados das contas (sem tokens)
    const accounts = await adminRepository.getAccounts(adminId, admin.is_super);

    res.status(200).json({
      success: true,
      admin,
      accounts,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    console.error("[ADMIN_AUTH] Erro em /me:", message);
    res.status(500).json({ success: false, message: "Erro ao buscar dados do admin." });
  }
}
