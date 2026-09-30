#!/usr/bin/env node
/**
 * migrate-assets.ts
 *
 * Script de migração para re-processar base_image_url e template_image_url
 * de todas as contas do Instagram via sharp, padronizando para JPEG 1080x1350.
 *
 * Uso:
 *   npx ts-node scripts/migrate-assets.ts          # executa migração real
 *   npx ts-node scripts/migrate-assets.ts --dry-run # simula sem alterar nada
 */

import { config } from "dotenv";
config({ path: ".env" });

import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { fetchTemplateBuffer, TemplateFetchError } from "../src/services/templateFetchService";
import { cityAssetsService } from "../src/services/cityAssetsService";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios no .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const DRY_RUN = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose");

const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1350;
const JPEG_QUALITY = 88;

async function processImageBuffer(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .rotate()
    .flatten({ background: "#fff" })
    .resize(OUTPUT_WIDTH, OUTPUT_HEIGHT, { fit: "cover", position: "centre" })
    .toColorspace("srgb")
    .jpeg({ quality: JPEG_QUALITY, progressive: false, mozjpeg: true })
    .toBuffer();
}

async function fetchAndProcess(url: string, label: string): Promise<Buffer | null> {
  try {
    const buffer = await fetchTemplateBuffer(url);
    if (VERBOSE) console.log(`  [${label}] Baixado ${buffer.length} bytes, processando...`);
    return await processImageBuffer(buffer);
  } catch (e) {
    if (e instanceof TemplateFetchError) {
      console.warn(`  [${label}] ⚠️  Falha no download/validação: ${e.code} - ${e.message}`);
    } else {
      console.warn(`  [${label}] ⚠️  Erro inesperado: ${e instanceof Error ? e.message : String(e)}`);
    }
    return null;
  }
}

async function main() {
  console.log(`🚀 Iniciando migração de assets ${DRY_RUN ? "(DRY-RUN)" : ""}`);
  console.log("");

  // Busca todas as contas que têm base_image_url ou template_image_url
  const { data: accounts, error } = await supabase
    .from("instagram_accounts")
    .select("id, username, base_image_url, template_image_url")
    .or("base_image_url.not.is.null,template_image_url.not.is.null");

  if (error) {
    console.error("❌ Erro ao buscar contas:", error.message);
    process.exit(1);
  }

  if (!accounts || accounts.length === 0) {
    console.log("ℹ️  Nenhuma conta com assets para migrar.");
    return;
  }

  console.log(`📋 Encontradas ${accounts.length} conta(s) com assets.`);

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const account of accounts) {
    console.log(`\n🔄 Processando: ${account.username} (${account.id})`);

    const updates: Record<string, string> = {};
    const baseUrl = account.base_image_url;
    const templateUrl = account.template_image_url;

    if (baseUrl) {
      if (VERBOSE) console.log(`  [base] URL: ${baseUrl}`);
      const processedBuffer = await fetchAndProcess(baseUrl, "base");
      if (processedBuffer) {
        if (!DRY_RUN) {
          const publicUrl = await cityAssetsService.uploadAsset(
            processedBuffer,
            "base",
            account.id,
            "image/jpeg"
          );
          updates.base_image_url = publicUrl;
          if (VERBOSE) console.log(`  [base] ✅ Upload realizado: ${publicUrl}`);
        } else {
          console.log(`  [base] ✅ [DRY-RUN] Seria processado e enviado como base.jpg`);
        }
        processed++;
      } else {
        console.log(`  [base] ⏭️  Pulado (falha no download/processamento)`);
        skipped++;
      }
    }

    if (templateUrl) {
      if (VERBOSE) console.log(`  [template] URL: ${templateUrl}`);
      const processedBuffer = await fetchAndProcess(templateUrl, "template");
      if (processedBuffer) {
        if (!DRY_RUN) {
          const publicUrl = await cityAssetsService.uploadAsset(
            processedBuffer,
            "template",
            account.id,
            "image/jpeg"
          );
          updates.template_image_url = publicUrl;
          if (VERBOSE) console.log(`  [template] ✅ Upload realizado: ${publicUrl}`);
        } else {
          console.log(`  [template] ✅ [DRY-RUN] Seria processado e enviado como template.jpg`);
        }
        processed++;
      } else {
        console.log(`  [template] ⏭️  Pulado (falha no download/processamento)`);
        skipped++;
      }
    }

    if (Object.keys(updates).length > 0 && !DRY_RUN) {
      const { error: updateError } = await supabase
        .from("instagram_accounts")
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq("id", account.id);

      if (updateError) {
        console.error(`  ❌ Erro ao atualizar conta: ${updateError.message}`);
        errors++;
      } else {
        console.log(`  💾 Conta atualizada no banco.`);
      }
    }
  }

  console.log("\n" + "=".repeat(50));
  console.log(`📊 Resumo ${DRY_RUN ? "(DRY-RUN)" : ""}:`);
  console.log(`   Assets processados: ${processed}`);
  console.log(`   Assets pulados:     ${skipped}`);
  console.log(`   Erros de banco:     ${errors}`);
  console.log("=".repeat(50));

  if (DRY_RUN) {
    console.log("\n💡 Execute sem --dry-run para aplicar as alterações.");
  }
}

main().catch((e) => {
  console.error("❌ Erro fatal:", e);
  process.exit(1);
});