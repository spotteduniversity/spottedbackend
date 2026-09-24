import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import fs from "fs";
import path from "path";
import https from "https";
import os from "os";

const FONT_URL = "https://raw.githubusercontent.com/google/fonts/main/ofl/bungee/Bungee-Regular.ttf";
const FONT_DOWNLOAD_TIMEOUT_MS = 5000;
const fontPath = path.join(os.tmpdir(), "Bungee-Regular.ttf");

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

// Fallback silencioso no catch para evitar crash da renderização se a CDN falhar
export const loadFont = (): Promise<void> => {
  if (fontLoaded) return Promise.resolve();
  if (fontLoadPromise) return fontLoadPromise;

  fontLoadPromise = (async () => {
    try {
      if (!fs.existsSync(fontPath)) {
        await downloadFont();
      }

      GlobalFonts.registerFromPath(fontPath, "Bungee");
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

const EMOJI_REGEX = /(?:\p{Emoji_Presentation}|\p{Extended_Pictographic})(?:\uFE0F)?(?:\u200D(?:\p{Emoji_Presentation}|\p{Extended_Pictographic})(?:\uFE0F)?)*/gu;

type Segment = { type: 'text'; value: string } | { type: 'emoji'; value: string };

function splitIntoSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  const regex = new RegExp(EMOJI_REGEX.source, 'gu');
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'emoji', value: match[0] });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return segments;
}

function emojiToTwemojiUrl(emoji: string): string {
  const codePoints = [...emoji]
    .map(cp => cp.codePointAt(0)!)
    .filter(cp => cp !== 0xFE0F)
    .map(cp => cp.toString(16))
    .join('-');
  return `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/${codePoints}.png`;
}

function downloadBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadBuffer(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

const emojiImageCache = new Map<string, any>();

async function getEmojiImage(emoji: string): Promise<any | null> {
  if (emojiImageCache.has(emoji)) return emojiImageCache.get(emoji);
  try {
    const url = emojiToTwemojiUrl(emoji);
    const buffer = await downloadBuffer(url);
    const img = await loadImage(buffer);
    emojiImageCache.set(emoji, img);
    return img;
  } catch (e) {
    console.error(`Falha ao carregar emoji "${emoji}":`, e);
    emojiImageCache.set(emoji, null);
    return null;
  }
}

function measureWidth(ctx: any, text: string, emojiSize: number): number {
  const segments = splitIntoSegments(text);
  let width = 0;
  for (const seg of segments) {
    if (seg.type === 'text') {
      width += ctx.measureText(seg.value).width;
    } else {
      width += emojiSize;
    }
  }
  return width;
}

// Configurações da sombra preta aplicada ao texto branco
const TEXT_SHADOW_COLOR = "rgba(0, 0, 0, 0.65)";
const TEXT_SHADOW_BLUR = 6;
const TEXT_SHADOW_OFFSET_X = 2;
const TEXT_SHADOW_OFFSET_Y = 3;

function applyTextShadow(ctx: any): void {
  ctx.shadowColor = TEXT_SHADOW_COLOR;
  ctx.shadowBlur = TEXT_SHADOW_BLUR;
  ctx.shadowOffsetX = TEXT_SHADOW_OFFSET_X;
  ctx.shadowOffsetY = TEXT_SHADOW_OFFSET_Y;
}

function clearShadow(ctx: any): void {
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

async function drawLineWithEmoji(
  ctx: any,
  line: string,
  centerX: number,
  y: number,
  emojiSize: number
): Promise<void> {
  const segments = splitIntoSegments(line);

  if (segments.every(s => s.type === 'text')) {
    applyTextShadow(ctx);
    ctx.fillText(line, centerX, y);
    clearShadow(ctx);
    return;
  }

  const totalWidth = measureWidth(ctx, line, emojiSize);
  let x = centerX - totalWidth / 2;

  const prevAlign = ctx.textAlign;
  ctx.textAlign = 'left';

  for (const seg of segments) {
    if (seg.type === 'text') {
      applyTextShadow(ctx);
      ctx.fillText(seg.value, x, y);
      clearShadow(ctx);
      x += ctx.measureText(seg.value).width;
    } else {
      const img = await getEmojiImage(seg.value);
      if (img) {
        // Sem sombra no emoji, evita halo estranho no PNG
        ctx.drawImage(img, x, y - emojiSize * 0.5, emojiSize, emojiSize);
      }
      x += emojiSize;
    }
  }

  ctx.textAlign = prevAlign;
}

const WIDTH = 1080;
const HEIGHT = 1350;
const PADDING = 96;
const MAX_WIDTH = WIDTH - (PADDING * 2);

export const generateSpottedImage = async (message: string, displayId: number, hasUserImage: boolean = false, templateBuffer?: Buffer | null): Promise<{ fileName: string; postId: string }> => {
  await loadFont();
  emojiImageCache.clear();

  const postId = displayId.toString();
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  try {
    if (templateBuffer) {
      const baseImage = await loadImage(templateBuffer);
      ctx.drawImage(baseImage, 0, 0, WIDTH, HEIGHT);
    } else {
      const basePath = path.join(process.cwd(), "public", "fim.jpg");
      if (fs.existsSync(basePath)) {
        const baseImage = await loadImage(basePath);
        ctx.drawImage(baseImage, 0, 0, WIDTH, HEIGHT);
      } else {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
      }
    }
  } catch (error) {
    console.error("Erro ao carregar imagem base:", error);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }

  ctx.fillStyle = "#fff";
  ctx.font = '400 32px "Bungee", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Só mostra o ID se a mensagem tiver 270 caracteres ou menos
  if (message.length <= 280) {
    applyTextShadow(ctx);
    ctx.fillText(`[${postId}]`, WIDTH / 2, HEIGHT * 0.350);
    clearShadow(ctx);
  }

  const fontSize = message.length < 80 ? 52 : message.length < 180 ? 46 : 42;
  ctx.font = `400 ${fontSize}px "Bungee", sans-serif`;

  const emojiSize = fontSize * 1.05;
  const lineHeight = fontSize * 1.35;
  const explicitLines = message.split('\n');
  let lines: string[] = [];

  const mw = (text: string) => measureWidth(ctx, text, emojiSize);

  const breakLongWord = (word: string): string[] => {
    const fragments: string[] = [];
    let current = "";
    const segmenter = new Intl.Segmenter('pt-BR', { granularity: 'grapheme' });

    for (const { segment } of segmenter.segment(word)) {
      if (mw(current + segment) >= MAX_WIDTH) {
        fragments.push(current);
        current = segment;
      } else {
        current += segment;
      }
    }
    if (current) fragments.push(current);
    return fragments;
  };

  for (const explicitLine of explicitLines) {
    const words = explicitLine.split(" ").filter(w => w.length > 0);
    if (words.length === 0) {
      lines.push("");
      continue;
    }

    let currentLine = "";

    for (const word of words) {
      if (mw(word) >= MAX_WIDTH) {
        if (currentLine) {
          lines.push(currentLine);
          currentLine = "";
        }
        const fragments = breakLongWord(word);
        for (let i = 0; i < fragments.length - 1; i++) {
          lines.push(fragments[i]);
        }
        currentLine = fragments[fragments.length - 1];
      } else if (!currentLine) {
        currentLine = word;
      } else if (mw(currentLine + " " + word) < MAX_WIDTH) {
        currentLine += " " + word;
      } else {
        lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);
  }

  if (lines.length > 10) {
    lines = lines.slice(0, 10);
    lines[9] += "...";
  }

  const totalTextHeight = lines.length * lineHeight;
  const centerY = HEIGHT / 2;
  const startY = centerY - (totalTextHeight / 2) + (lineHeight / 2);

  for (let index = 0; index < lines.length; index++) {
    await drawLineWithEmoji(ctx, lines[index], WIDTH / 2, startY + (index * lineHeight), emojiSize);
  }

  if (hasUserImage) {
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.font = '400 28px "Bungee", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    applyTextShadow(ctx);
    ctx.fillText("POST COM FOTO  📷  →", WIDTH / 2, HEIGHT * 0.88);
    clearShadow(ctx);
  }

  const fileName = `spotted_${postId}.jpg`;
  const postsDir = path.join(os.tmpdir(), "posts");

  if (!fs.existsSync(postsDir)) {
    fs.mkdirSync(postsDir, { recursive: true });
  }

  const outPath = path.join(postsDir, fileName);
  return new Promise(async (resolve, reject) => {
    try {
      const buffer = await canvas.encode('jpeg', 95);
      fs.writeFile(outPath, buffer, (err) => {
        if (err) return reject(err);
        resolve({ fileName, postId });
      });
    } catch (e) {
      reject(e);
    }
  });
};
