/**
 * userController.ts
 *
 * Endpoints do painel do usuário:
 *  GET   /api/users/me             — Perfil + saldo
 *  PATCH /api/users/me             — Editar perfil
 *  GET   /api/users/me/posts       — Meus posts com status de farm
 *  GET   /api/users/me/stats       — Estatísticas de engajamento + gamificação
 *  GET   /api/users/me/transactions — Histórico de transações
 */

import { Request, Response } from "express";
import { userRepository } from "../services/userRepository";

// ════════════════════════════════════════════════════
//  GAMIFICAÇÃO — Tabela de Tiers por percentil
// ════════════════════════════════════════════════════
function calculateTier(topPercent: number): {
  tier: string;
  percentile: number;
  nextGoalPercentile: number;
} {
  // topPercent = "Top X%" — quanto MENOR, melhor.
  // Ex: topPercent=1  → Top 1%  → Reitor (elite)
  //     topPercent=100 → Top 100% → Bixo (pior)
  if (topPercent <= 1)   return { tier: "Reitor",     percentile: topPercent, nextGoalPercentile: 0.1  };
  if (topPercent <= 5)   return { tier: "Professor",  percentile: topPercent, nextGoalPercentile: 1    };
  if (topPercent <= 15)  return { tier: "Doutorando", percentile: topPercent, nextGoalPercentile: 5    };
  if (topPercent <= 30)  return { tier: "Mestrando",  percentile: topPercent, nextGoalPercentile: 15   };
  if (topPercent <= 50)  return { tier: "Formando",   percentile: topPercent, nextGoalPercentile: 30   };
  if (topPercent <= 75)  return { tier: "Veterano",   percentile: topPercent, nextGoalPercentile: 50   };
  return                  { tier: "Bixo",             percentile: topPercent, nextGoalPercentile: 75   };
}

// ════════════════════════════════════════════════════
//  GET /api/users/me
// ════════════════════════════════════════════════════
export async function getProfile(req: Request, res: Response): Promise<void> {
  try {
    const user = await userRepository.findById(req.user!.userId);
    if (!user) {
      res.status(404).json({ success: false, message: "Usuário não encontrado." });
      return;
    }
    res.status(200).json({ success: true, user });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    console.error("[USER] Erro em getProfile:", message);
    res.status(500).json({ success: false, message: "Erro ao buscar perfil." });
  }
}

// ════════════════════════════════════════════════════
//  PATCH /api/users/me
// ════════════════════════════════════════════════════
export async function updateProfile(req: Request, res: Response): Promise<void> {
  const { name, email, instagram_username } = req.body;

  // Pelo menos um campo deve ser enviado
  if (!name && !email && !instagram_username) {
    res.status(400).json({ success: false, message: "Nenhum campo para atualizar foi enviado." });
    return;
  }

  const updateData: Record<string, string> = {};
  if (name)               updateData.name = name.trim();
  if (email)              updateData.email = email.toLowerCase().trim();
  if (instagram_username) updateData.instagram_username = instagram_username.replace(/^@/, "").trim().toLowerCase();

  try {
    const user = await userRepository.update(req.user!.userId, updateData);
    res.status(200).json({ success: true, message: "Perfil atualizado com sucesso!", user });
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

    console.error("[USER] Erro em updateProfile:", message);
    res.status(500).json({ success: false, message: "Erro ao atualizar perfil." });
  }
}

// ════════════════════════════════════════════════════
//  GET /api/users/me/posts
// ════════════════════════════════════════════════════
export async function getUserPosts(req: Request, res: Response): Promise<void> {
  try {
    const posts = await userRepository.findUserPosts(req.user!.userId);

    // Adiciona campo calculado: cooldown restante para cada post
    const postsWithCooldown = posts.map((post) => {
      let cooldown_remaining_minutes: number | null = null;

      if (post.last_synced_at) {
        const lastSync = new Date(post.last_synced_at).getTime();
        const diff = Date.now() - lastSync;
        const elapsed = diff / 1000 / 60;
        const remaining = 120 - elapsed;
        cooldown_remaining_minutes = remaining > 0 ? Math.ceil(remaining) : 0;
      }

      return { ...post, cooldown_remaining_minutes };
    });

    res.status(200).json({ success: true, posts: postsWithCooldown });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    console.error("[USER] Erro em getUserPosts:", message);
    res.status(500).json({ success: false, message: "Erro ao buscar posts." });
  }
}

// ════════════════════════════════════════════════════
//  GET /api/users/me/stats
// ════════════════════════════════════════════════════
export async function getUserStats(req: Request, res: Response): Promise<void> {
  try {
    const [user, stats] = await Promise.all([
      userRepository.findById(req.user!.userId),
      userRepository.getUserStats(req.user!.userId),
    ]);

    if (!user) {
      res.status(404).json({ success: false, message: "Usuário não encontrado." });
      return;
    }

    const percentile = await userRepository.getUserPercentile(user.lifetime_sc || 0);
    const gamification = calculateTier(percentile);

    res.status(200).json({
      success: true,
      stats: {
        ...stats,
        current_balance: user.balance_coins,
        gamification,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    console.error("[USER] Erro em getUserStats:", message);
    res.status(500).json({ success: false, message: "Erro ao buscar estatísticas." });
  }
}

// ════════════════════════════════════════════════════
//  GET /api/users/me/transactions
// ════════════════════════════════════════════════════
export async function getUserTransactions(req: Request, res: Response): Promise<void> {
  try {
    const transactions = await userRepository.findUserTransactions(req.user!.userId);
    res.status(200).json({ success: true, transactions });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    console.error("[USER] Erro em getUserTransactions:", message);
    res.status(500).json({ success: false, message: "Erro ao buscar transações." });
  }
}
