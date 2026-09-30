import { scrapeAlmoco, scrapeJantar, MenuItem } from "./bandecoScraper";
import { generateBandecoImage } from "./bandecoImageGenerator";
import { storageService } from "./storageService";
import { instagramService, IgCredentials } from "./instagramService";
import { supabase } from "../config/supabase";
import { decrypt } from "./cryptoService";

interface BandecoData {
  type: "ALMOÇO" | "JANTAR";
  date: string;
  dayOfWeek: string;
  padrao: MenuItem;
  vegano: MenuItem;
}

/**
 * Resolve as credenciais da conta que recebe os stories do bandeco.
 * Usa BANDECO_ACCOUNT_ID se definido; senão, a primeira conta conectada.
 * Retorna null quando não há conta conectada.
 */
async function resolveCredentials(): Promise<IgCredentials | null> {
  if (!supabase) return null;

  let query = supabase
    .from("instagram_accounts")
    .select("id, ig_user_id, access_token_encrypted")
    .eq("connection_status", "ok")
    .not("access_token_encrypted", "is", null);

  if (process.env.BANDECO_ACCOUNT_ID) {
    query = query.eq("id", process.env.BANDECO_ACCOUNT_ID);
  }

  const { data, error } = await query.limit(1).maybeSingle();
  if (error || !data) return null;

  return { accessToken: decrypt(data.access_token_encrypted), igUserId: data.ig_user_id };
}

async function processBandeco(type: "ALMOÇO" | "JANTAR", scrapedData: BandecoData): Promise<{ success: boolean; imageUrl?: string; instagramMediaId?: string; error?: string }> {
  try {
    console.log(`🔄 Iniciando fluxo completo do ${type}...`);

    // Passo 1: Gerar imagem (Canvas)
    console.log("🎨 Gerando imagem do cardápio...");
    const imageBuffer = await generateBandecoImage(scrapedData);

    // Passo 2: Upload para Storage (Supabase)
    console.log("☁️ Fazendo upload da imagem para o Storage...");
    const storageType = type === "ALMOÇO" ? "almoco" : "jantar";
    const publicImageUrl = await storageService.uploadBandecoImage(imageBuffer, storageType);

    if (!publicImageUrl) {
      throw new Error("Falha ao obter URL pública da imagem no Storage");
    }

    console.log(`✅ Imagem disponível em: ${publicImageUrl}`);

    // Passo 3: Publicar no Instagram Stories
    const creds = await resolveCredentials();
    if (!creds) {
      console.warn("⚠️ Nenhuma conta do Instagram conectada. Pulando publicação.");
      return { success: true, imageUrl: publicImageUrl };
    }

    console.log("📱 Publicando Story no Instagram...");
    const mediaId = await instagramService.postStory(publicImageUrl, creds);

    return { success: true, imageUrl: publicImageUrl, instagramMediaId: mediaId };
  } catch (error: any) {
    console.error(`❌ Erro no fluxo do ${type}:`, error.message);
    return { success: false, error: error.message };
  }
}

export async function runAlmocoFlow(): Promise<{ success: boolean; imageUrl?: string; instagramMediaId?: string; error?: string; data?: BandecoData }> {
  console.log("🚀 Iniciando fluxo de Almoço...");
  const scraped = await scrapeAlmoco();
  
  const data: BandecoData = {
    type: "ALMOÇO",
    date: scraped.date,
    dayOfWeek: scraped.dayOfWeek,
    padrao: scraped.padrao,
    vegano: scraped.vegano,
  };

  const result = await processBandeco("ALMOÇO", data);
  return { ...result, data };
}

export async function runJantarFlow(): Promise<{ success: boolean; imageUrl?: string; instagramMediaId?: string; error?: string; data?: BandecoData }> {
  console.log("🚀 Iniciando fluxo de Jantar...");
  const scraped = await scrapeJantar();
  
  const data: BandecoData = {
    type: "JANTAR",
    date: scraped.date,
    dayOfWeek: scraped.dayOfWeek,
    padrao: scraped.padrao,
    vegano: scraped.vegano,
  };

  const result = await processBandeco("JANTAR", data);
  return { ...result, data };
}