/**
 * authController.ts
 *
 * Endpoints de autenticação:
 *  POST /api/auth/register — Cria conta
 *  POST /api/auth/login    — Faz login, retorna JWT
 *  GET  /api/auth/me       — Retorna dados do usuário autenticado
 */

import { Request, Response } from "express";
import { hashPassword, verifyPassword, signToken } from "../services/authService";
import { userRepository } from "../services/userRepository";

// ════════════════════════════════════════════════════
//  REGISTER
// ════════════════════════════════════════════════════
export async function register(req: Request, res: Response): Promise<void> {
  const { name, email, instagram_username, password } = req.body;

  // Validações básicas
  if (!name || !email || !instagram_username || !password) {
    res.status(400).json({ success: false, message: "Todos os campos são obrigatórios." });
    return;
  }

  if (typeof password !== "string" || password.length < 6) {
    res.status(400).json({ success: false, message: "A senha deve ter no mínimo 6 caracteres." });
    return;
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    res.status(400).json({ success: false, message: "E-mail inválido." });
    return;
  }

  try {
    const password_hash = await hashPassword(password);

    const user = await userRepository.create({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      instagram_username: instagram_username.replace(/^@/, "").trim().toLowerCase(),
      password_hash,
    });

    const token = signToken({ userId: user.id, email: user.email });

    res.status(201).json({
      success: true,
      message: "Conta criada com sucesso!",
      token,
      user,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";

    if (message === "DUPLICATE_EMAIL") {
      res.status(409).json({ success: false, message: "Este e-mail já está em uso." });
      return;
    }
    if (message === "DUPLICATE_INSTAGRAM") {
      res.status(409).json({ success: false, message: "Este @ do Instagram já está cadastrado." });
      return;
    }

    console.error("[AUTH] Erro no registro:", message);
    res.status(500).json({ success: false, message: "Erro interno ao criar conta." });
  }
}

// ════════════════════════════════════════════════════
//  LOGIN
// ════════════════════════════════════════════════════
export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ success: false, message: "E-mail e senha são obrigatórios." });
    return;
  }

  try {
    const user = await userRepository.findByEmailWithHash(email);

    // Usa a mesma mensagem genérica para não vazar se o email existe ou não (segurança)
    if (!user) {
      res.status(401).json({ success: false, message: "E-mail ou senha inválidos." });
      return;
    }

    const passwordMatch = await verifyPassword(password, user.password_hash);
    if (!passwordMatch) {
      res.status(401).json({ success: false, message: "E-mail ou senha inválidos." });
      return;
    }

    const { password_hash: _, ...safeUser } = user;
    const token = signToken({ userId: user.id, email: user.email });

    res.status(200).json({
      success: true,
      message: "Login realizado com sucesso!",
      token,
      user: safeUser,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    console.error("[AUTH] Erro no login:", message);
    res.status(500).json({ success: false, message: "Erro interno ao fazer login." });
  }
}

// ════════════════════════════════════════════════════
//  ME (quem sou eu?)
// ════════════════════════════════════════════════════
export async function getMe(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const user = await userRepository.findById(userId);

    if (!user) {
      res.status(404).json({ success: false, message: "Usuário não encontrado." });
      return;
    }

    res.status(200).json({ success: true, user });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    console.error("[AUTH] Erro em /me:", message);
    res.status(500).json({ success: false, message: "Erro ao buscar dados do usuário." });
  }
}
