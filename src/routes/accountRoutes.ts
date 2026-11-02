import { Router, Request, Response } from "express";
import { supabase } from "../config/supabase";

const router = Router();

/** GET /api/account?slug=lavras
 *  Retorna os dados da conta (template, cores, logo) baseado no slug.
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const { slug } = req.query;

    if (!slug || typeof slug !== "string") {
      return res.status(400).json({ success: false, message: "Slug é obrigatório." });
    }

    if (!supabase) throw new Error("Supabase não configurado.");

    const { data: account, error } = await supabase
      .from("instagram_accounts")
      .select("id, username, display_name, template_image_url, text_color, shadow_color, spotted_logo, base_image_url, base_caption, is_active, is_moderated")
      .eq("slug", slug)
      .single();

    if (error || !account) {
      return res.status(404).json({ success: false, message: "Conta (cidade) não encontrada." });
    }

    if (!account.is_active) {
      return res.status(400).json({ success: false, message: "Esta conta está arquivada/inativa." });
    }

    res.json({ success: true, account });
  } catch (error: any) {
    console.error("Erro ao buscar conta por slug:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;