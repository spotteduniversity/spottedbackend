/**
 * adminRoutes.ts
 *
 * Rotas do painel admin.
 * Requer autenticação de admin (requireAdmin).
 */

import { Router, Request, Response } from "express";
import { requireAdmin } from "../middleware/adminAuth";
import { spottedRepository } from "../services/spottedRepository";
import { generateSpottedImageBuffer, resolveTheme } from "../services/imageService";
import { PublishError, publishSpotted } from "../services/spottedPublishingService";
import { supabase } from "../config/supabase";
import { fetchTemplateBuffer, TemplateFetchError } from "../services/templateFetchService";
import { exchangeForLongLivedToken } from "../services/metaTokenService";

const router = Router();

// GET /api/admin/pending
// Pode receber ?account_id=<uuid> para filtrar. Se não, filtra por req.admin.accountIds
router.get("/pending", requireAdmin, async (req: Request, res: Response) => {
  try {
    if (!supabase) throw new Error("Supabase não configurado.");

    const { account_id } = req.query;

    let query = supabase
      .from("spotteds")
      .select("*, instagram_accounts(username, display_name, is_active)")
      .eq("status", "PENDING")
      .order("created_at", { ascending: false });

    if (account_id) {
      if (!req.admin!.is_super && !req.admin!.accountIds.includes(account_id as string)) {
        return res.status(403).json({ success: false, message: "Sem permissão." });
      }
      query = query.eq("instagram_account_id", account_id);
    } else if (!req.admin!.is_super) {
      if (req.admin!.accountIds.length === 0) {
        return res.json({ success: true, posts: [] });
      }
      query = query.in("instagram_account_id", req.admin!.accountIds);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Contas arquivadas somem da fila: os posts continuam no banco, mas
    // param de não publicar. Filtro em JS porque o join é um LEFT JOIN.
    const posts = (data ?? []).filter(
      (row) => row.instagram_accounts?.is_active !== false
    );

    res.json({ success: true, posts });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/admin/approve/:id
router.post("/approve/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    // 1. Busca o post e valida o estado
    const dbRecord = await spottedRepository.findById(id);
    if (!dbRecord) {
      return res.status(404).json({ success: false, message: "Post não encontrado." });
    }
    if (dbRecord.status !== "PENDING") {
      return res.status(400).json({ success: false, message: "Post não está pendente." });
    }

    const accountId = dbRecord.instagram_account_id;
    if (!accountId) {
      return res.status(400).json({ success: false, message: "Spotted sem conta vinculada." });
    }

    // 2. Verifica permissão do admin
    if (!req.admin!.is_super && !req.admin!.accountIds.includes(accountId)) {
      return res.status(403).json({ success: false, message: "Sem permissão para esta conta." });
    }

    // 3. Publica (lógica compartilhada com o envio automático)
    const outcome = await publishSpotted(id, { reviewedBy: req.admin!.adminId });

    return res.json({
      success: true,
      message: "Post aprovado com sucesso.",
      postId: outcome.postId,
      instagramMediaId: outcome.instagramMediaId,
      displayId: outcome.displayId,
    });
  } catch (error: any) {
    if (error instanceof PublishError) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    console.error("[APPROVE] Erro inesperado:", error);
    return res.status(500).json({
      success: false,
      message: error?.message || "Erro ao aprovar o post.",
    });
  }
});

// POST /api/admin/reject/:id
router.post("/reject/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    const dbRecord = await spottedRepository.findById(id);
    if (!dbRecord) return res.status(404).json({ success: false, message: "Post não encontrado." });

    const accountId = dbRecord.instagram_account_id;

    // Se o post tem conta, valida permissão normal.
    // Se NÃO tem conta (NULL), só super admin pode rejeitar.
    if (accountId) {
      if (!req.admin!.is_super && !req.admin!.accountIds.includes(accountId)) {
        return res.status(403).json({ success: false, message: "Sem permissão." });
      }
    } else if (!req.admin!.is_super) {
      return res.status(403).json({ success: false, message: "Post sem conta vinculada: apenas super admin pode rejeitar." });
    }

    await spottedRepository.updateStatus(id, "BLOCKED");

    if (!supabase) throw new Error("Supabase não configurado.");
    await supabase.from("spotteds").update({
      reviewed_by: req.admin!.adminId,
      reviewed_at: new Date().toISOString()
    }).eq("id", id);

    res.json({ success: true, message: "Post rejeitado com sucesso." });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/admin/preview
// Gera um preview de como o card vai ficar para uma dada conta e texto.
router.post("/preview", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { accountId, content } = req.body;
    if (!accountId || !content) {
      return res.status(400).json({ success: false, message: "accountId e content são obrigatórios." });
    }

    if (!req.admin!.is_super && !req.admin!.accountIds.includes(accountId)) {
      return res.status(403).json({ success: false, message: "Sem permissão." });
    }

    if (!supabase) throw new Error("Supabase não configurado.");
    const { data: account } = await supabase
      .from("instagram_accounts")
      .select("template_image_url, text_color, shadow_color")
      .eq("id", accountId)
      .single();

    if (!account || !account.template_image_url) {
      return res.status(400).json({ success: false, message: "Template do card não configurado para esta cidade." });
    }

    // Baixa template da URL pública
    let templateBuffer: Buffer;
    try {
      templateBuffer = await fetchTemplateBuffer(account.template_image_url!);
    } catch (e) {
      if (e instanceof TemplateFetchError) {
        console.error("[PREVIEW] Template fetch failed:", { code: e.code, status: e.status, message: e.message });
        return res.status(400).json({ success: false, message: "Template da conta inválido, reenvie a imagem base" });
      }
      throw e;
    }

    const theme = resolveTheme(account);

    // Preview não escreve nada em disco: pede o buffer direto ao imageService.
    const buffer = await generateSpottedImageBuffer(content, 9999, false, templateBuffer, theme);

    return res.json({ success: true, imageBase64: `data:image/jpeg;base64,${buffer.toString("base64")}` });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/admin/long-lived-token
// Troca um User Access Token de curta duração por um Long-Lived Token (60 dias)
// usando o App ID e App Secret do .env via Graph API da Meta.
router.post("/long-lived-token", requireAdmin, async (req: Request, res: Response) => {
  try {
    const token =
      req.body?.access_token ||
      req.body?.fb_exchange_token ||
      req.body?.accessToken;

    if (!token || typeof token !== "string" || !token.trim()) {
      return res.status(400).json({
        success: false,
        message: "Informe o token de acesso no campo 'access_token'.",
      });
    }

    const result = await exchangeForLongLivedToken(token);

    return res.json({
      success: true,
      access_token: result.access_token,
      token_type: result.token_type,
      expires_in: result.expires_in,
      pages: result.pages,
    });
  } catch (error: any) {
    console.error("[LONG-LIVED-TOKEN] Falha na troca do token:", error?.message);
    const isConfigError =
      error?.message?.includes("FB_APP_ID") ||
      error?.message?.includes(".env");
    return res.status(isConfigError ? 500 : 400).json({
      success: false,
      message: error?.message || "Falha ao gerar o token de longa duração.",
    });
  }
});

export default router;