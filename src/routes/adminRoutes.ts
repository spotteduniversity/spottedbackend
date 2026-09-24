/**
 * adminRoutes.ts
 *
 * Rotas do painel admin.
 * Requer autenticação de admin (requireAdmin).
 */

import { Router, Request, Response } from "express";
import { requireAdmin, requireAccountAccess, requireSuperAdmin } from "../middleware/adminAuth";
import { spottedRepository } from "../services/spottedRepository";
import { generateSpottedImage } from "../services/imageService";
import { storageService } from "../services/storageService";
import { instagramService } from "../services/instagramService";
import { cityAssetsService } from "../services/cityAssetsService";
import { adminRepository } from "../services/adminRepository";
import { decrypt } from "../services/cryptoService";
import { supabase } from "../config/supabase";
import { runTokenRefreshJob } from "../jobs/tokenRefreshJob";

const router = Router();

// POST /api/admin/jobs/refresh-tokens
// Rota pública para ser chamada por cronjobs externos (ex: cron-job.org)
router.post("/jobs/refresh-tokens", async (req: Request, res: Response) => {
  try {
    const result = await runTokenRefreshJob();
    res.json({ success: true, result });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/admin/pending
// Pode receber ?account_id=<uuid> para filtrar. Se não, filtra por req.admin.accountIds
router.get("/pending", requireAdmin, async (req: Request, res: Response) => {
  try {
    if (!supabase) throw new Error("Supabase não configurado.");

    const { account_id } = req.query;

    let query = supabase
      .from("spotteds")
      .select("*, instagram_accounts(username, display_name)")
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

    res.json({ success: true, posts: data });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/admin/approve/:id
router.post("/approve/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    if (!supabase) throw new Error("Supabase não configurado.");

    const dbRecord = await spottedRepository.findById(id);
    if (!dbRecord) return res.status(404).json({ success: false, message: "Post não encontrado." });
    if (dbRecord.status !== "PENDING") return res.status(400).json({ success: false, message: "Post não está pendente." });

    const accountId = dbRecord.instagram_account_id;
    if (!accountId) return res.status(400).json({ success: false, message: "Spotted sem conta vinculada." });

    // Verifica permissão
    if (!req.admin!.is_super && !req.admin!.accountIds.includes(accountId)) {
      return res.status(403).json({ success: false, message: "Sem permissão para esta conta." });
    }

    // Busca conta para pegar tokens e templates
    const { data: account } = await supabase
      .from("instagram_accounts")
      .select("*")
      .eq("id", accountId)
      .single();

    if (!account) return res.status(404).json({ success: false, message: "Conta não encontrada." });

    // Calcula displayId
    const { count, error: countErr } = await supabase
      .from("spotteds")
      .select("*", { count: "exact", head: true })
      .eq("instagram_account_id", accountId)
      .lte("created_at", dbRecord.created_at);

    if (countErr) throw countErr;
    const displayId = count || 1000;

    // Busca template do card
    const templateBuffer = await cityAssetsService.getTextCardTemplate(account.text_card_template_path);
    const hasUserImage = !!dbRecord.image_url;
    const { fileName, postId } = await generateSpottedImage(dbRecord.content, displayId, hasUserImage, templateBuffer);

    let instagramMediaId: string | undefined = undefined;

    // Publica se a conta estiver conectada
    if (account.connection_status === 'ok' && account.access_token_encrypted) {
      try {
        const accessToken = decrypt(account.access_token_encrypted);
        const creds = { accessToken, igUserId: account.ig_user_id };

        const [cardUrl, baseImageUrl] = await Promise.all([
          storageService.uploadCard(fileName),
          cityAssetsService.getSignedBaseImageUrl(account.base_image_path)
        ]);

        if (!cardUrl || !baseImageUrl) {
          throw new Error("Falha ao preparar imagens para o Instagram.");
        }

        const instagramCaption = `[${postId}] - ${dbRecord.content}\n\n#spotted #unicamp\n\n@${account.username}`;

        if (hasUserImage) {
          instagramMediaId = await instagramService.postCarouselWithUserImage(
            cardUrl, dbRecord.image_url!, baseImageUrl, instagramCaption, creds
          );
        } else {
          instagramMediaId = await instagramService.postCarousel(
            cardUrl, baseImageUrl, instagramCaption, creds
          );
        }
      } catch (igError: any) {
        console.error("Erro ao postar no Instagram:", igError);
        if (igError.isAuthError) {
          // Marca a conta como precisando de reauth
          await adminRepository.updateConnection(accountId, {
            needs_reauth: true,
            connection_status: 'error',
            last_error: igError.message
          });
        }
        return res.status(500).json({ success: false, message: `Erro Instagram: ${igError.message}` });
      }
    }

    // Atualiza status do spotted
    await spottedRepository.updateStatus(id, "PUBLISHED", instagramMediaId);

    // Marca quem revisou
    await supabase.from("spotteds").update({
      reviewed_by: req.admin!.adminId,
      reviewed_at: new Date().toISOString()
    }).eq("id", id);

    res.json({ success: true, message: "Post aprovado com sucesso.", postId, instagramMediaId });
  } catch (error: any) {
    console.error("Erro ao aprovar post:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/admin/reject/:id
router.post("/reject/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    
    // Verifica acesso
    const dbRecord = await spottedRepository.findById(id);
    if (!dbRecord) return res.status(404).json({ success: false, message: "Post não encontrado." });
    
    const accountId = dbRecord.instagram_account_id;
    if (accountId && !req.admin!.is_super && !req.admin!.accountIds.includes(accountId)) {
      return res.status(403).json({ success: false, message: "Sem permissão." });
    }

    // STATUS ATUALIZADO: agora usa REJECTED
    await spottedRepository.updateStatus(id, "REJECTED");

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

    const { data: account } = await supabase.from("instagram_accounts").select("text_card_template_path").eq("id", accountId).single();
    const templatePath = account ? account.text_card_template_path : null;
    
    const templateBuffer = await cityAssetsService.getTextCardTemplate(templatePath);
    
    // Para preview, não vamos escrever em disco (fileName), vamos apenas retornar o buffer/base64.
    // Como generateSpottedImage salva em disco, precisamos de uma versão que retorne buffer.
    // Mas para não mexer tanto no imageService, podemos deixar salvar temporário e ler?
    // Melhor ler o arquivo salvo.
    const displayId = 9999; // ID fake
    const { fileName } = await generateSpottedImage(content, displayId, false, templateBuffer);
    
    const filePath = require("path").join(process.cwd(), "public", "posts", fileName);
    const fs = require("fs");
    if (fs.existsSync(filePath)) {
      const buffer = fs.readFileSync(filePath);
      const base64 = buffer.toString("base64");
      // Limpar o arquivo temporário
      fs.unlinkSync(filePath);
      return res.json({ success: true, imageBase64: `data:image/jpeg;base64,${base64}` });
    } else {
      return res.status(500).json({ success: false, message: "Falha ao gerar preview." });
    }
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;