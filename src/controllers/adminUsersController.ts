/**
 * adminUsersController.ts
 *
 * Gerenciamento de usuários admin (criação e vinculação às cidades).
 * Apenas super-admins podem usar essas rotas.
 */

import { Request, Response } from "express";
import { adminRepository } from "../services/adminRepository";
import { hashAdminPassword } from "../services/adminAuthService";

/**
 * Express 5 tipa `req.params` como `string | string[]`. Nossas rotas usam
 * sempre um único segmento, então normalizamos aqui.
 */
function paramId(req: Request): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? raw[0] : raw;
}

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

/**
 * Lista todos os admins com suas contas vinculadas.
 */
export async function listAdmins(_req: Request, res: Response): Promise<void> {
  try {
    const admins = await adminRepository.listAll();
    res.status(200).json({ success: true, admins });
  } catch (error: any) {
    console.error("Erro ao listar admins:", error);
    res.status(500).json({ success: false, message: "Erro ao carregar administradores." });
  }
}

/**
 * Atualiza username, senha, flag de super e/ou contas de um admin.
 */
export async function updateAdmin(req: Request, res: Response): Promise<void> {
  const id = paramId(req);
  const actingAdmin = req.admin;
  const { username, password, is_super, accountIds } = req.body;

  if (username === undefined && password === undefined && is_super === undefined && accountIds === undefined) {
    res.status(400).json({ success: false, message: "Nenhum campo para atualizar." });
    return;
  }

  if (password !== undefined && password.length < 8) {
    res.status(400).json({ success: false, message: "A senha deve ter no mínimo 8 caracteres." });
    return;
  }

  if (username !== undefined && !username.trim()) {
    res.status(400).json({ success: false, message: "O username não pode ficar vazio." });
    return;
  }

  if (accountIds !== undefined && !Array.isArray(accountIds)) {
    res.status(400).json({ success: false, message: "accountIds deve ser uma lista." });
    return;
  }

  try {
    const isSelf = actingAdmin?.adminId === id;
    const demotingSelf = isSelf && is_super === false;
    const removingOwnSuper = isSelf && accountIds !== undefined && Boolean(actingAdmin.is_super);

    if (demotingSelf) {
      res.status(400).json({
        success: false,
        message: "Você não pode remover o próprio acesso de super-admin.",
      });
      return;
    }

    // Garante que ao menos um super-admin continue existindo.
    if (is_super === false || removingOwnSuper) {
      const superAdmins = await adminRepository.countSuperAdmins();
      if (superAdmins <= 1) {
        res.status(400).json({
          success: false,
          message: "O sistema precisa de ao menos um super-admin.",
        });
        return;
      }
    }

    const patch: { username?: string; password_hash?: string; is_super?: boolean } = {};
    if (username !== undefined) patch.username = username;
    if (password !== undefined) patch.password_hash = await hashAdminPassword(password);
    if (is_super !== undefined) patch.is_super = Boolean(is_super);

    if (Object.keys(patch).length > 0) {
      await adminRepository.update(id, patch);
    }

    if (accountIds !== undefined) {
      await adminRepository.setAccounts(id, accountIds);
    }

    const admin = await adminRepository.findById(id);
    res.status(200).json({ success: true, message: "Admin atualizado.", admin });
  } catch (error: any) {
    if (error.message === "DUPLICATE_USERNAME") {
      res.status(409).json({ success: false, message: "Este username já está em uso." });
      return;
    }
    console.error("Erro ao atualizar admin:", error);
    res.status(500).json({ success: false, message: "Erro ao atualizar administrador." });
  }
}

/**
 * Remove permanentemente um admin e suas vinculações.
 */
export async function deleteAdmin(req: Request, res: Response): Promise<void> {
  const id = paramId(req);
  const actingAdmin = req.admin;

  if (actingAdmin?.adminId === id) {
    res.status(400).json({
      success: false,
      message: "Você não pode excluir o próprio usuário.",
    });
    return;
  }

  try {
    const target = await adminRepository.findById(id);
    if (!target) {
      res.status(404).json({ success: false, message: "Administrador não encontrado." });
      return;
    }

    if (target.is_super) {
      const superAdmins = await adminRepository.countSuperAdmins();
      if (superAdmins <= 1) {
        res.status(400).json({
          success: false,
          message: "O sistema precisa de ao menos um super-admin.",
        });
        return;
      }
    }

    await adminRepository.remove(id);
    res.status(200).json({ success: true, message: "Administrador removido." });
  } catch (error: any) {
    console.error("Erro ao remover admin:", error);
    res.status(500).json({ success: false, message: "Erro ao remover administrador." });
  }
}
