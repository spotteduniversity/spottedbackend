/**
 * adminAccountsRoutes.ts
 *
 * CRUD de contas do Instagram (cada conta = uma cidade).
 * Montadas em /api/admin/accounts
 *
 * Regras:
 *   - Leitura: super-admin vê todas; admin comum só as contas vinculadas.
 *   - Criar/editar/arquivar: qualquer admin autenticado, respeitando o escopo.
 *   - Nunca há DELETE: contas têm posts e histórico de publicação.
 */

import { Router, type Request, type Response } from "express";
import { requireAdmin, requireAccountAccess } from "../middleware/adminAuth";
import { adminRepository } from "../services/adminRepository";
import { supabase } from "../config/supabase";
import { cityAssetsService, assetUpload } from "../services/cityAssetsService";
import { encrypt } from "../services/cryptoService";
import { verifyInstagramCredentials } from "../services/instagramService";

const router = Router();

const SELECT_ACCOUNT =
  "id, username, ig_user_id, display_name, slug, is_active, connection_status, " +
  "needs_reauth, last_error, base_image_path, text_card_template_path, " +
  "text_color, shadow_color, token_expires_at, token_refreshed_at, created_at, updated_at";

// Mesma lista, porém com o token. Só é usada dentro do servidor e sempre
// atravessa publicAccount(), que devolve apenas se existe um token.
const SELECT_ACCOUNT_SECRET =
  "id, username, ig_user_id, display_name, slug, is_active, connection_status, " +
  "needs_reauth, last_error, base_image_path, text_card_template_path, " +
  "text_color, shadow_color, token_expires_at, token_refreshed_at, " +
  "access_token_encrypted, created_at, updated_at";

/** Tira o segredo e expõe somente a existência de um token configurado. */
function publicAccount(row: Record<string, any>) {
  const { access_token_encrypted, ...rest } = row;
  return { ...rest, has_token: Boolean(access_token_encrypted) };
}

/** Resolve o accountId das rotas (`:id` ou `:account_id`) e devolve null se ausente. */
function accountId(req: Request): string | null {
  const raw = req.params.id ?? req.params.account_id;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ?? null;
}

function fail(res: Response, code: number, message: string): void {
  res.status(code).json({ success: false, message });
}

// GET /api/admin/accounts
router.get("/", requireAdmin, async (req: Request, res: Response) => {
  try {
    if (!supabase) throw new Error("Supabase não configurado.");

    const admin = req.admin!;
    let query = supabase
      .from("instagram_accounts")
      .select(SELECT_ACCOUNT_SECRET)
      .order("display_name", { ascending: true });

    if (!admin.is_super) {
      const ids = await adminRepository.getAccountIds(admin.adminId, false);
      if (ids.length === 0) return res.json({ success: true, accounts: [] });
      query = query.in("id", ids);
    }

    if (req.query.include_archived !== "true") {
      query = query.eq("is_active", true);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, accounts: (data ?? []).map(publicAccount) });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// POST /api/admin/accounts
// Cria a cidade. A conta nasce sem credencial: o admin cola o token e o IG
// User ID depois, em PUT /:id/credentials.
router.post("/", requireAdmin, async (req: Request, res: Response) => {
  try {
    if (!supabase) throw new Error("Supabase não configurado.");

    const { display_name, username } = req.body;
    if (!display_name?.trim()) {
      return fail(res, 400, "Informe o nome da cidade.");
    }

    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("instagram_accounts")
      .insert({
        display_name: display_name.trim(),
        // Placeholder único: salvar as credenciais sobrescreve com o ig_user_id
        // real que o admin informar. É texto livre no schema, então não
        // precisamos de null para a coluna aceitar.
        ig_user_id: `pending_${crypto.randomUUID()}`,
        username: username?.trim() || `pending_${Date.now()}`,
        // O CHECK da coluna só aceita 'ok' | 'needs_reauth'. Uma conta nova
        // ainda não tem token, então é 'needs_reauth' até o admin colar um.
        connection_status: "needs_reauth",
        needs_reauth: true,
        is_active: true,
        text_color: "#ffffff",
        shadow_color: "rgba(0, 0, 0, 0.65)",
        created_at: now,
        updated_at: now,
      })
      .select(SELECT_ACCOUNT_SECRET)
      .single();

    if (error) throw new Error(error.message);
    res.status(201).json({ success: true, account: publicAccount(data) });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// PATCH /api/admin/accounts/:id
// Edita os campos administrativos. Não mexe em token nem em status de conexão.
router.patch("/:id", requireAdmin, requireAccountAccess, async (req: Request, res: Response) => {
  try {
    if (!supabase) throw new Error("Supabase não configurado.");
    const id = accountId(req)!;

    const allowed = ["display_name", "username", "slug", "text_color", "shadow_color"] as const;
    const patch: Record<string, unknown> = {};
    for (const field of allowed) {
      if (req.body[field] !== undefined) patch[field] = req.body[field];
    }

    if (patch.display_name !== undefined && !String(patch.display_name).trim()) {
      return fail(res, 400, "O nome da cidade não pode ficar vazio.");
    }
    if (patch.username !== undefined) {
      // Regras de usuário do Instagram: até 30 chars, sem @, espaço ou hífen.
      const username = String(patch.username).trim().replace(/^@/, "");
      if (!/^[a-zA-Z0-9._]{1,30}$/.test(username)) {
        return fail(
          res,
          400,
          "O usuário aceita apenas letras, números, ponto e underscore (até 30 caracteres)."
        );
      }
      patch.username = username;
    }
    if (patch.slug !== undefined) {
      const slug = String(patch.slug).trim();
      if (!/^[a-z0-9-]*$/.test(slug)) {
        return fail(res, 400, "O slug aceita apenas letras minúsculas, números e hífen.");
      }
      patch.slug = slug || null;
    }
    if (patch.text_color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(patch.text_color))) {
      return fail(res, 400, "text_color deve ser um hex de 6 dígitos, ex.: #ffffff");
    }
    if (
      patch.shadow_color !== undefined &&
      !/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/.test(
        String(patch.shadow_color)
      )
    ) {
      return fail(res, 400, "shadow_color deve ser rgb()/rgba(), ex.: rgba(0, 0, 0, 0.65)");
    }

    if (Object.keys(patch).length === 0) {
      return fail(res, 400, "Nenhum campo válido para atualizar.");
    }

    patch.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from("instagram_accounts")
      .update(patch)
      .eq("id", id)
      .select(SELECT_ACCOUNT_SECRET)
      .single();

    if (error) throw new Error(error.message);
    res.json({ success: true, account: publicAccount(data) });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// POST /api/admin/accounts/:id/archive
// Arquivar = is_active = false. Não apaga posts, tokens nem histórico.
router.post("/:id/archive", requireAdmin, requireAccountAccess, async (req: Request, res: Response) => {
  try {
    if (!supabase) throw new Error("Supabase não configurado.");
    const id = accountId(req)!;

    const { data, error } = await supabase
      .from("instagram_accounts")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select(SELECT_ACCOUNT_SECRET)
      .single();

    if (error) throw new Error(error.message);
    res.json({ success: true, message: "Conta arquivada.", account: publicAccount(data) });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// POST /api/admin/accounts/:id/unarchive
router.post("/:id/unarchive", requireAdmin, requireAccountAccess, async (req: Request, res: Response) => {
  try {
    if (!supabase) throw new Error("Supabase não configurado.");
    const id = accountId(req)!;

    const { data, error } = await supabase
      .from("instagram_accounts")
      .update({ is_active: true, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select(SELECT_ACCOUNT_SECRET)
      .single();

    if (error) throw new Error(error.message);
    res.json({ success: true, message: "Conta restaurada.", account: publicAccount(data) });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// POST /api/admin/accounts/:id/assets
// Upload de base / template para o bucket privado city-assets.
// Uses a service role no backend, então o bucket não precisa ser público.
router.post(
  "/:id/assets",
  requireAdmin,
  requireAccountAccess,
  assetUpload.single("file"),
  async (req: Request, res: Response) => {
    try {
      const id = accountId(req)!;
      const file = req.file;
      if (!file) return fail(res, 400, "Envie um arquivo de imagem.");

      const kind = req.body.kind as "base" | "template";
      if (kind !== "base" && kind !== "template") {
        return fail(res, 400, "Informe kind=base ou kind=template.");
      }

      if (file.mimetype !== "image/png" && file.mimetype !== "image/jpeg") {
        return fail(res, 415, "Formato aceito: PNG ou JPEG.");
      }

      const contentType = file.mimetype;
      const publicUrl = await cityAssetsService.uploadAsset(
        file.buffer,
        kind === "base" ? "base" : "template",
        id,
        contentType
      );

      const column = kind === "base" ? "base_image_url" : "template_image_url";
      if (!supabase) throw new Error("Supabase não configurado.");

      const { data, error } = await supabase
        .from("instagram_accounts")
        .update({ [column]: publicUrl, updated_at: new Date().toISOString() })
        .eq("id", id)
        .select(SELECT_ACCOUNT_SECRET)
        .single();

      if (error) throw new Error(error.message);

      res.json({ success: true, message: "Arquivo enviado.", account: publicAccount(data) });
    } catch (error: any) {
      fail(res, 500, error.message);
    }
  }
);

// PUT /api/admin/accounts/:id/credentials
// Cadastro manual das credenciais da Meta: access token + IG User ID.
// Não existe OAuth neste projeto. O admin gera um token de longa duração no
// Graph API Explorer e cola aqui junto com o IG User ID, que é o número que
// aparece na URL de toda chamada de publicação (ex.: 17841405822304914).
//
// Validamos o par contra a Meta ANTES de gravar, para não salvar credencial
// quebrada. A resposta também traz o username real, então o formulário não
// depende do admin digitar o @user certo.
//
// O token NUNCA volta na resposta: devolvemos só `has_token`.
router.put("/:id/credentials", requireAdmin, requireAccountAccess, async (req: Request, res: Response) => {
  try {
    if (!supabase) throw new Error("Supabase não configurado.");
    const id = accountId(req)!;

    const accessToken = typeof req.body?.access_token === "string"
      ? req.body.access_token.trim()
      : "";
    if (!accessToken) {
      return fail(res, 400, "Informe o access token da Meta.");
    }
    // Tokens da Meta são alfanuméricos (base64url). Evita gravar lixo e
    // ainda gastar uma chamada à API com um valor obviamente inválido.
    if (!/^[A-Za-z0-9._~|-]{20,4096}$/.test(accessToken)) {
      return fail(res, 400, "O access token parece inválido (caracteres ou tamanho).");
    }

    // O IG User ID é sempre numérico puro. Validar antes evita injetar
    // caminho de URL arbitrário na chamada seguinte à Meta.
    const igUserId = typeof req.body?.ig_user_id === "string"
      ? req.body.ig_user_id.trim()
      : "";
    if (!igUserId) {
      return fail(res, 400, "Informe o IG User ID da conta.");
    }
    if (!/^\d{5,30}$/.test(igUserId)) {
      return fail(res, 400, "O IG User ID deve ser só números (ex.: 17841405822304914).");
    }

    // Valida o par contra a Meta. Se falhar, devolvemos o erro sem gravar nada.
    let username: string;
    try {
      username = await verifyInstagramCredentials(igUserId, accessToken);
    } catch (error: any) {
      return fail(
        res,
        400,
        `A Meta recusou as credenciais: ${String(error?.message || "token inválido").slice(0, 200)}`
      );
    }

    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("instagram_accounts")
      .update({
        access_token_encrypted: encrypt(accessToken),
        ig_user_id: igUserId,
        username,
        connection_status: "ok",
        needs_reauth: false,
        last_error: null,
        token_refreshed_at: now,
        // NULL de propósito: token colado à mão não tem expiração conhecida e
        // não há job de renovação (renovar exigiria o client_secret da Meta).
        // A conta fica publicando com este token até alguém colar outro.
        token_expires_at: null,
        updated_at: now,
      })
      .eq("id", id)
      .select(SELECT_ACCOUNT_SECRET)
      .single();

    if (error) throw new Error(error.message);

    res.json({ success: true, message: "Credenciais salvas.", account: publicAccount(data) });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

export default router;
