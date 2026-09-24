import { Request, Response } from "express";
import { runAlmocoFlow, runJantarFlow } from "../services/bandecoService";

export const getAlmoco = async (req: Request, res: Response) => {
  try {
    const result = await runAlmocoFlow();

    if (!result.success) {
      return res.status(500).json({
        success: false,
        message: "Erro ao processar fluxo do almoço",
        error: result.error,
        data: result.data,
      });
    }

    res.status(200).json({
      success: true,
      message: "Fluxo do almoço executado com sucesso",
      imageUrl: result.imageUrl,
      instagramMediaId: result.instagramMediaId,
      data: result.data,
    });
  } catch (error: any) {
    console.error("Erro no controller do almoço:", error);
    res.status(500).json({
      success: false,
      message: "Erro interno no servidor",
      error: error.message,
    });
  }
};

export const getJantar = async (req: Request, res: Response) => {
  try {
    const result = await runJantarFlow();

    if (!result.success) {
      return res.status(500).json({
        success: false,
        message: "Erro ao processar fluxo do jantar",
        error: result.error,
        data: result.data,
      });
    }

    res.status(200).json({
      success: true,
      message: "Fluxo do jantar executado com sucesso",
      imageUrl: result.imageUrl,
      instagramMediaId: result.instagramMediaId,
      data: result.data,
    });
  } catch (error: any) {
    console.error("Erro no controller do jantar:", error);
    res.status(500).json({
      success: false,
      message: "Erro interno no servidor",
      error: error.message,
    });
  }
};