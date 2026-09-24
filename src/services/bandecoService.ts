import { scrapeAlmoco, scrapeJantar, MenuItem } from "./bandecoScraper";
import { generateBandecoImage } from "./bandecoImageGenerator";
import { storageService } from "./storageService";
import { instagramService } from "./instagramService";

interface BandecoData {
  type: "ALMOÇO" | "JANTAR";
  date: string;
  dayOfWeek: string;
  padrao: MenuItem;
  vegano: MenuItem;
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
    if (!instagramService.isConfigured()) {
      console.warn("⚠️ Instagram não configurado. Pulando publicação.");
      return { success: true, imageUrl: publicImageUrl };
    }

    console.log("📱 Publicando Story no Instagram...");
    const mediaId = await instagramService.postStory(publicImageUrl);

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