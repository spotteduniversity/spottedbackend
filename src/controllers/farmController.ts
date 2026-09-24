import { Request, Response } from "express";
import { syncUserFarming } from "../services/farmService";

/**
 * POST /api/farm/sync
 * 
 * Aciona a sincronização de engajamento em lote para o usuário logado
 * e credita SpottedCoins.
 */
export async function syncFarm(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;

  if (!userId) {
    res.status(401).json({
      success: false,
      message: "Usuário não autenticado.",
    });
    return;
  }

  try {
    console.log(`\n🔄 [FARM] Iniciando sync em lote para usuário: ${userId}`);
    const result = await syncUserFarming(userId);

    // Se cooldown ativo, retorna 200 com flag de bloqueio (não é erro do cliente)
    if (!result.success && result.cooldown_remaining_minutes) {
      res.status(200).json({
        ...result,
        message: `Cooldown ativo. Nova sincronização disponível em ${result.cooldown_remaining_minutes} minutos.`,
      });
      return;
    }

    res.status(200).json({
      ...result,
      message: result.new_coins_earned > 0
        ? `🎉 +${result.new_coins_earned} SC creditados! Próxima sincronização disponível em 2 horas.`
        : `Sincronização concluída. Nenhum engajamento novo detectado desde a última sync.`,
    });

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    console.error(`❌ [FARM] Erro ao sincronizar usuário ${userId}:`, message);

    res.status(500).json({
      success: false,
      message: "Erro interno ao sincronizar o engajamento. Tente novamente mais tarde.",
    });
  }
}
