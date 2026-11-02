import { Request, Response } from "express";
import multer from "multer";
import { generateSpottedImage, loadFont, resolveTheme } from "../services/imageService";
import { spottedRepository, SpottedRecord } from "../services/spottedRepository";
import { storageService } from "../services/storageService";
import { imageCompressionService } from "../services/imageCompressionService";
import { optionalAuth } from "../middleware/auth";
import { supabase } from "../config/supabase";
import { fetchTemplateBuffer, TemplateFetchError } from "../services/templateFetchService";
import { publishSpotted } from "../services/spottedPublishingService";
import path from "path";

const BANNED_WORDS = [
  "estupro", "estuprar", "estuprador",
  "molestado", "molestar", "molestador", "geladinho",
  "abuso", "abusar", "abusador",
  "assedio", "assediador",
  "pedofilia", "pedofilo",
  "suicidio", "automutilacao", "se matar",
  "assassinato", "assassino",
  "matar", "espancar",
  "porno", "pornografia",
  "nudes", "nudez",
  "prostituicao", "puta", "vadia",
  "buceta", "caralho", "rola",
  "racismo", "racista",
  "nazismo", "fascismo",
  "viado", "bicha", "sapatao",
  "trafico", "traficante",
  "cocaina", "heroina",
  "vender drogas",
  "virilha", "saco"
];

function containsBannedWords(message: string): boolean {
  // Normalize string to remove accents/diacritics
  const normalizedMessage = message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return BANNED_WORDS.some(word => normalizedMessage.includes(word));
}

// Configuração do multer para aceitar imagem em memória
export const spottedUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Formato inválido. Envie JPEG ou PNG.'));
    }
  }
});

export const sendSpotted = [optionalAuth, async (req: Request, res: Response) => {
  try {
    const { message, fingerprint, instagram_account_id, slug } = req.body;
    // No FormData, booleans vêm como strings "true" ou "false"
    const wants_coin = req.body.wants_coin === 'true' || req.body.wants_coin === true;
    
    // user_id é opcional: preenchido se o usuário estiver logado
    const userId: string | null = req.user?.userId || null;

    // Se não tiver instagram_account_id, tentar buscar por slug
    let accountId = instagram_account_id;
    if (!accountId && slug && supabase) {
      const { data: account } = await supabase
        .from("instagram_accounts")
        .select("id")
        .eq("slug", slug)
        .single();
      if (account) accountId = account.id;
    }

    if (!accountId) {
      return res.status(400).json({ success: false, message: "instagram_account_id ou slug é obrigatório." });
    }

    if (wants_coin && !userId) {
      return res.status(401).json({
        success: false,
        message: "Para acumular SpottedCoins você precisa estar logado.",
      });
    }

    if (!message || typeof message !== "string") {
      return res.status(400).json({ success: false, message: "Mensagem inválida." });
    }

    if (containsBannedWords(message)) {
      return res.status(400).json({ success: false, message: "Sua mensagem contém palavras inapropriadas e não pode ser enviada." });
    }

    const safeMessage = message.substring(0, 350).replace(/<[^>]*>?/gm, "");

    let ipAddress =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";

    if (ipAddress === "::1") ipAddress = "127.0.0.1";
    if (ipAddress.startsWith("::ffff:")) ipAddress = ipAddress.replace("::ffff:", "");

    const userAgent = req.headers["user-agent"] || null;

    if (!supabase) throw new Error("Supabase não configurado.");
    const { data: account } = (await supabase
      .from("instagram_accounts")
      .select("*")
      .eq("id", accountId)
      .single()) || {};

    if (!account) {
      return res.status(404).json({ success: false, message: "Conta (cidade) não encontrada." });
    }

    // Contas sem moderação não aceitam imagem enviada pelo usuário.
    if (req.file && account.is_moderated === false) {
      return res.status(400).json({
        success: false,
        message: "Esta cidade não aceita imagens.",
      });
    }

    // Processamento da Imagem (se houver)
    let finalImageUrl: string | null = null;
    let hasUserImage = false;

    if (req.file) {
      const validation = imageCompressionService.validateImage(req.file.buffer);
      if (!validation.valid) {
        return res.status(400).json({ success: false, message: validation.error });
      }

      // Gera um nome único para o arquivo
      const uniqueName = `user_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
      
      // Comprime e redimensiona
      await imageCompressionService.compressAndResize(req.file.buffer, uniqueName);
      
      // Upload pro Supabase
      const uploadedUrl = await storageService.uploadUserImage(uniqueName);
      
      if (uploadedUrl) {
        finalImageUrl = uploadedUrl;
        hasUserImage = true;
      } else {
        return res.status(500).json({ success: false, message: "Falha ao enviar a imagem." });
      }
    }

    if (!account.template_image_url) {
      return res.status(400).json({ success: false, message: "Template do card não configurado para esta cidade." });
    }

    const theme = resolveTheme(account);
    // Baixa template da URL pública
    let templateBuffer: Buffer;
    try {
      templateBuffer = await fetchTemplateBuffer(account.template_image_url!);
    } catch (e) {
      if (e instanceof TemplateFetchError) {
        console.error("[SEND_SPOTTED] Template fetch failed:", { code: e.code, status: e.status, message: e.message });
        return res.status(500).json({ success: false, message: "Template da conta inválido, reenvie a imagem base" });
      }
      throw e;
    }

    // Preview gerado SEM número real (número real só é atribuído na aprovação)
    const [, dbRecord] = await Promise.all([
      loadFont(),
      spottedRepository.create({
        content: safeMessage,
        ip_address: ipAddress,
        instagram_account_id: accountId,
        user_agent: userAgent || undefined,
        fingerprint: fingerprint || undefined,
        status: "PENDING",
        user_id: userId || undefined,
        wants_coin: userId ? wants_coin : false,
        image_url: finalImageUrl || undefined,
      }),
    ]);

    // Preview usa placeholder "—" — número real só na aprovação
    const { fileName, postId } = await generateSpottedImage(safeMessage, 0, hasUserImage, templateBuffer, theme);

    let status = dbRecord?.status || "PENDING";

    // Contas sem moderação publicam na hora. Qualquer falha mantém PENDING
    // para o admin conseguir aprovar/reenviar depois.
    if (dbRecord?.id && account.is_moderated === false) {
      try {
        const outcome = await publishSpotted(dbRecord.id, { reviewedBy: null });
        status = "PUBLISHED";
        console.log("[SEND_SPOTTED] Publicação automática concluída:", {
          postId: outcome.postId,
          instagramMediaId: outcome.instagramMediaId,
        });
      } catch (error: any) {
        console.error("[SEND_SPOTTED] Publicação automática falhou; post mantido PENDING:", {
          postId: dbRecord.id,
          message: error?.message,
        });
      }
    }

    res.status(200).json({
      success: true,
      messageId: postId,
      dbId: dbRecord?.id || null,
      imageUrl: `http://localhost:3001/posts/${fileName}`,
      status,
      autoPublished: status === "PUBLISHED",
    });

  } catch (error: any) {
    console.error("Erro ao processar spotted:", error);
    // Erros do multer (ex: formato invalido)
    if (error.message && error.message.includes("Formato inválido")) {
      return res.status(400).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: "Erro interno no servidor." });
  }
}] as any;

/**
 * Upload de logo para a conta/cidade.
 * Recebe o slug no body, busca a conta, faz upload da imagem pro bucket
 * e salva o URL na coluna spotted_logo do banco.
 */
export const uploadLogo = async (req: Request, res: Response) => {
  try {
    const { slug } = req.body;
    if (!slug) {
      return res.status(400).json({ success: false, message: "Slug é obrigatório." });
    }

    // Busca a conta pelo slug
    if (!supabase) throw new Error("Supabase não configurado.");
    const { data: account } = await supabase
      .from("instagram_accounts")
      .select("id")
      .eq("slug", slug)
      .single();

    if (!account) {
      return res.status(404).json({ success: false, message: "Conta (cidade) não encontrada." });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: "Nenhuma imagem enviada." });
    }

    // Validar imagem
    const validation = imageCompressionService.validateImage(req.file.buffer);
    if (!validation.valid) {
      return res.status(400).json({ success: false, message: validation.error });
    }

    // Gerar nome único e comprimir
    const uniqueName = `logo_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
    await imageCompressionService.compressAndResize(req.file.buffer, uniqueName);

    // Upload para Supabase storage
    const uploadedUrl = await storageService.uploadUserImage(uniqueName);

    if (!uploadedUrl) {
      return res.status(500).json({ success: false, message: "Falha ao enviar a imagem para o bucket." });
    }

    // Salvar URL no banco
    if (!supabase) throw new Error("Supabase não configurado.");
    const { error } = await supabase
      .from("instagram_accounts")
      .update({ spotted_logo: uploadedUrl })
      .eq("id", account.id);

    if (error) {
      console.error("Erro ao salvar logo:", error.message);
      return res.status(500).json({ success: false, message: "Falha ao salvar logo no banco." });
    }

    res.json({ success: true, logoUrl: uploadedUrl });
  } catch (error: any) {
    console.error("Erro no upload de logo:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};