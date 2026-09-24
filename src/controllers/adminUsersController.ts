/**
 * adminUsersController.ts
 *
 * Gerenciamento de usuários admin (criação e vinculação às cidades).
 * Apenas super-admins podem usar essas rotas.
 */

import { Request, Response } from "express";
import { adminRepository } from "../services/adminRepository";
import { hashAdminPassword } from "../services/adminAuthService";

export async function createAdmin(req: Request, res: Response): Promise<void> {
  const { username, password, is_super, accountIds } = req.body;

  if (!username || !password) {
    res.status(400).json({ success: false, message: "Username e senha são obrigatórios." });
    return;
  }

  if (password.length < 8) {
    res.status(400).json({ success: false, message: "A senha deve ter no mínimo 8 caracteres." });
    return;
  }

  try {
    const password_hash = await hashAdminPassword(password);

    // Cria o admin no banco
    const admin = await adminRepository.create({
      username,
      password_hash,
      is_super: Boolean(is_super),
    });

    // Se não for super admin, precisa vincular as contas selecionadas
    if (!admin.is_super && accountIds && Array.isArray(accountIds)) {
      for (const accountId of accountIds) {
        await adminRepository.linkAdminToAccount(admin.id, accountId);
      }
    }

    res.status(201).json({
      success: true,
      message: "Admin criado com sucesso.",
      admin,
    });
  } catch (error: any) {
    if (error.message === "DUPLICATE_USERNAME") {
      res.status(409).json({ success: false, message: "Este username já está em uso." });
      return;
    }
    console.error("Erro ao criar admin:", error);
    res.status(500).json({ success: false, message: "Erro ao criar administrador." });
  }
}
