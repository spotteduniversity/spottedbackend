import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import { MenuItem } from "./bandecoScraper";

// URL garantida do repositório oficial do Google Fonts para Roboto
const FONT_URL = "https://raw.githubusercontent.com/googlefonts/roboto/main/src/hinted/Roboto-Regular.ttf";
const FONT_DOWNLOAD_TIMEOUT_MS = 5000;
const fontPath = path.join(os.tmpdir(), "Roboto-Regular.ttf");

const BASE_IMAGE_PATH = path.join(process.cwd(), "public", "storiesbase.png");

// Detecta se está rodando em ambiente serverless (Vercel, AWS Lambda, etc)
const IS_SERVERLESS = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME || !!process.env.NOW_REGION;
const OUTPUT_DIR = IS_SERVERLESS ? path.join(os.tmpdir(), "bandeco-test") : path.join(process.cwd(), "public");

let fontLoaded = false;
let fontLoadPromise: Promise<void> | null = null;

const downloadFont = (): Promise<void> => {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(fontPath);

    const request = https.get(FONT_URL, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(fontPath, () => reject(new Error(`Download failed: ${res.statusCode}`)));
        return;
      }
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    });

    request.setTimeout(FONT_DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy(new Error(`Timeout (${FONT_DOWNLOAD_TIMEOUT_MS}ms)`));
    });

    request.on("error", (err) => {
      fs.unlink(fontPath, () => reject(err));
    });
  });
};

// Fallback silencioso no catch idêntico ao imageService
export const loadFont = (): Promise<void> => {
  if (fontLoaded) return Promise.resolve();
  if (fontLoadPromise) return fontLoadPromise;

  fontLoadPromise = (async () => {
    try {
      if (!fs.existsSync(fontPath)) {
        await downloadFont();
      }

      GlobalFonts.registerFromPath(fontPath, "Roboto");
      fontLoaded = true;
    } catch (e) {
      console.error("Erro ao carregar fonte customizada, fallback para fonte do sistema:", e);
      fs.unlink(fontPath, () => {});
    } finally {
      fontLoadPromise = null;
    }
  })();

  return fontLoadPromise;
};

interface BandecoImageData {
  type: "ALMOÇO" | "JANTAR";
  date: string;
  dayOfWeek: string;
  padrao: MenuItem;
  vegano: MenuItem;
}

export async function generateBandecoImage(data: BandecoImageData): Promise<Buffer> {
  await loadFont();

  const canvas = createCanvas(1080, 1920);
  const ctx = canvas.getContext("2d");

  try {
    if (fs.existsSync(BASE_IMAGE_PATH)) {
      const baseImage = await loadImage(BASE_IMAGE_PATH);
      ctx.drawImage(baseImage, 0, 0, 1080, 1920);
    } else {
      console.warn(`Base image not found: ${BASE_IMAGE_PATH}, usando fundo preto de fallback`);
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, 1080, 1920);
    }
  } catch (error) {
    console.error("Erro ao carregar a imagem base:", error);
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, 1080, 1920);
  }

  // Define a cor de todo o texto como branco
  ctx.fillStyle = "#FFFFFF";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  
  // 1. Tipo de Refeição (Caixa superior esquerda)
  ctx.font = 'bold 34px "Roboto", sans-serif';
  ctx.fillText(data.type, 320, 483);
  
  // 2. Data e Dia da Semana (Caixa superior direita)
  ctx.font = 'bold 24px "Roboto", sans-serif';
  ctx.fillText(`${data.date} - ${data.dayOfWeek}`, 790, 483);

  // 3. Cardápio Padrão
  drawSection(ctx, data.padrao, 730, 980); 
  
  // 4. Cardápio Vegano
  drawSection(ctx, data.vegano, 1300, 1550);

  // 5. Refresco (Caixa inferior)
  ctx.fillStyle = "#FFFFFF";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = 'bold 32px "Roboto", sans-serif';
  
  const textoRefresco = data.padrao.refresco 
    ? `REFRESCO: ${data.padrao.refresco.toUpperCase()}` 
    : "REFRESCO: NÃO INFORMADO";
    
  ctx.fillText(textoRefresco, 540, 1750);

  const buffer = await canvas.encode("png");

  // Salva cópia local para testes/debug apenas em desenvolvimento local
  if (!IS_SERVERLESS) {
    try {
      if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      }
      const fileName = `teste_${data.type.toLowerCase().replace("ç", "c")}.png`;
      const outPath = path.join(OUTPUT_DIR, fileName);
      fs.writeFileSync(outPath, buffer);
      console.log(`💾 Imagem de teste salva em: ${outPath}`);
    } catch (saveError) {
      console.warn("Não foi possível salvar imagem de teste local:", saveError);
    }
  }

  return buffer;
}

function drawSection(
  ctx: any,
  menu: MenuItem,
  mainDishY: number,
  columnsY: number
): void {
  // Configuração para o Prato Principal
  ctx.fillStyle = "#FFFFFF";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = 'bold 44px "Roboto", sans-serif';

  const pratoLines = wrapText(ctx, menu.pratoPrincipal, 840);
  let y = mainDishY;
  for (const line of pratoLines) {
    ctx.fillText(line, 120, y);
    y += 50; 
  }

  // Configuração para as Colunas Inferiores (Guarnição, Salada, Sobremesa)
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = 'bold 28px "Roboto", sans-serif'; 

  drawColumnText(ctx, menu.guarnicao, 230, columnsY, 260);
  drawColumnText(ctx, menu.salada, 540, columnsY, 260);
  drawColumnText(ctx, menu.sobremesa, 850, columnsY, 260);
}

function drawColumnText(ctx: any, text: string, x: number, y: number, maxWidth: number) {
  const lines = wrapText(ctx, text, maxWidth);
  const lineHeight = 36;
  
  // Centraliza o bloco de texto verticalmente se houver quebra de linha
  let startY = y - ((lines.length - 1) * lineHeight) / 2;

  for (const line of lines) {
    ctx.fillText(line, x, startY);
    startY += lineHeight;
  }
}

function wrapText(ctx: any, text: string, maxWidth: number): string[] {
  if (!text) return [""];
  
  const words = text.split(" ");
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const metrics = ctx.measureText(testLine);
    
    if (metrics.width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines;
}
