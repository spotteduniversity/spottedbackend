/**
 * backfillLocations.ts
 *
 * Preenche `city`, `state`, `ibge_city_code`, `lat` e `lng` para contas em
 * `instagram_accounts` que já possuem `city` e `state`, mas ainda estão sem
 * coordenadas ou código IBGE.
 *
 * Execução:
 *   npm run backfill:locations
 */

import dotenv from "dotenv";
dotenv.config();

import { supabase } from "../config/supabase";
import { resolveCity } from "../lib/municipios";

interface AccountLocationRow {
  id: string;
  username: string;
  display_name: string | null;
  city: string | null;
  state: string | null;
  ibge_city_code: number | null;
  lat: number | string | null;
  lng: number | string | null;
}

const NOMINATIM_DELAY_MS = 1100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

async function run(): Promise<void> {
  if (!supabase) {
    console.error("[BACKFILL] SUPABASE_URL ou SUPABASE_SERVICE_KEY não configurados.");
    process.exitCode = 1;
    return;
  }

  console.log("[BACKFILL] Lendo contas de instagram_accounts...");

  const { data, error } = await supabase
    .from("instagram_accounts")
    .select("id, username, display_name, city, state, ibge_city_code, lat, lng")
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[BACKFILL] Falha ao consultar instagram_accounts:", error.message);
    process.exitCode = 1;
    return;
  }

  const rows = (data ?? []) as AccountLocationRow[];
  const candidates: AccountLocationRow[] = [];
  const withoutLocation: AccountLocationRow[] = [];
  const partialMissingCityOrState: AccountLocationRow[] = [];
  let alreadyComplete = 0;

  for (const row of rows) {
    const hasCity = isFilled(row.city);
    const hasState = isFilled(row.state);
    const hasCode = isFilled(row.ibge_city_code);
    const hasLat = isFilled(row.lat);
    const hasLng = isFilled(row.lng);

    if (hasCity && hasState && hasCode && hasLat && hasLng) {
      alreadyComplete += 1;
      continue;
    }

    if (hasCity && hasState) {
      candidates.push(row);
    } else if (!hasCity && !hasState && !hasCode && !hasLat && !hasLng) {
      withoutLocation.push(row);
    } else {
      partialMissingCityOrState.push(row);
    }
  }

  console.log(
    `[BACKFILL] Total: ${rows.length} | Completas: ${alreadyComplete} | Para resolver: ${candidates.length} | Sem cidade/UF: ${withoutLocation.length}`,
  );

  if (partialMissingCityOrState.length > 0) {
    console.warn(
      `[BACKFILL] AVISO: ${partialMissingCityOrState.length} conta(s) possuem estado inconsistente (apenas parte dos campos preenchida):`,
    );
    for (const row of partialMissingCityOrState) {
      console.warn(
        `  - ${row.id} (@${row.username}): city=${row.city ?? "null"}, state=${row.state ?? "null"}`,
      );
    }
  }

  if (candidates.length === 0 && withoutLocation.length > 0) {
    console.warn(
      "[BACKFILL] AVISO: Nenhuma conta com city+state parciais foi encontrada. " +
        "Como a constraint do banco impede gravar apenas city/state sem ibge_city_code/lat/lng, " +
        "as contas abaixo estão com todos os 5 campos nulos e precisam ter Estado e Cidade definidos no painel:",
    );
    for (const row of withoutLocation) {
      console.warn(
        `  - ${row.id} (${row.display_name ?? row.username} / @${row.username})`,
      );
    }
    return;
  }

  const unresolved: Array<{ account: AccountLocationRow; reason: string }> = [];
  const failedUpdates: Array<{ account: AccountLocationRow; error: string }> = [];
  let updatedCount = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const account = candidates[index];
    const label = `${account.display_name ?? account.username} (@${account.username})`;

    if (index > 0) {
      await sleep(NOMINATIM_DELAY_MS);
    }

    let resolved;
    try {
      resolved = await resolveCity(account.city!, account.state!);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao consultar API externa";
      console.error(`[BACKFILL] [ERRO_API] ${label} (${account.city}/${account.state}): ${msg}`);
      unresolved.push({ account, reason: msg });
      continue;
    }

    if (!resolved) {
      console.warn(
        `[BACKFILL] [NAO_RESOLVIDA] ${label}: "${account.city}/${account.state}" não encontrada no IBGE/Nominatim.`,
      );
      unresolved.push({
        account,
        reason: `Cidade "${account.city}/${account.state}" não encontrada`,
      });
      continue;
    }

    const { error: updateError } = await supabase
      .from("instagram_accounts")
      .update({
        city: resolved.name,
        state: resolved.state,
        ibge_city_code: resolved.ibgeCode,
        lat: resolved.lat,
        lng: resolved.lng,
        updated_at: new Date().toISOString(),
      })
      .eq("id", account.id);

    if (updateError) {
      const isConstraint = updateError.code === "23514";
      const reason = isConstraint
        ? `Constraint do banco rejeitou a gravação (${updateError.message})`
        : updateError.message;

      console.error(`[BACKFILL] [ERRO_BANCO] ${label}: ${reason}`);
      failedUpdates.push({ account, error: reason });
      continue;
    }

    updatedCount += 1;
    console.log(
      `[BACKFILL] [OK] ${label} -> ${resolved.name}/${resolved.state} (IBGE ${resolved.ibgeCode}, ${resolved.lat}, ${resolved.lng})`,
    );
  }

  console.log("\n[BACKFILL] Resumo:");
  console.log(`  Atualizadas: ${updatedCount}`);
  console.log(`  Não resolvidas: ${unresolved.length}`);
  console.log(`  Erros ao gravar: ${failedUpdates.length}`);

  if (unresolved.length > 0) {
    console.warn("\n[BACKFILL] Contas não resolvidas:");
    for (const item of unresolved) {
      console.warn(
        `  - ${item.account.id} (@${item.account.username}): ${item.reason}`,
      );
    }
  }

  if (failedUpdates.length > 0) {
    console.error("\n[BACKFILL] Contas com erro de gravação:");
    for (const item of failedUpdates) {
      console.error(
        `  - ${item.account.id} (@${item.account.username}): ${item.error}`,
      );
    }
    process.exitCode = 1;
  }
}

run().catch((err: unknown) => {
  console.error("[BACKFILL] Falha inesperada:", err);
  process.exitCode = 1;
});
