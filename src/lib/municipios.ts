/**
 * Módulo de estados e municípios brasileiros (IBGE + Nominatim/OSM).
 *
 * - `listStates()` retorna as 27 UFs estaticamente.
 * - `listCitiesByState(uf)` consulta a API oficial de Localidades do IBGE com cache em memória.
 * - `resolveCity(city, state)` valida cidade + UF no IBGE e resolve lat/lng via Nominatim.
 */

export interface BrazilianState {
  uf: string;
  name: string;
}

export interface CityOption {
  ibgeCode: number;
  name: string;
  state: string;
}

export interface ResolvedCity {
  ibgeCode: number;
  name: string;
  state: string;
  lat: number;
  lng: number;
}

export const BRAZILIAN_STATES: readonly BrazilianState[] = [
  { uf: "AC", name: "Acre" },
  { uf: "AL", name: "Alagoas" },
  { uf: "AP", name: "Amapá" },
  { uf: "AM", name: "Amazonas" },
  { uf: "BA", name: "Bahia" },
  { uf: "CE", name: "Ceará" },
  { uf: "DF", name: "Distrito Federal" },
  { uf: "ES", name: "Espírito Santo" },
  { uf: "GO", name: "Goiás" },
  { uf: "MA", name: "Maranhão" },
  { uf: "MT", name: "Mato Grosso" },
  { uf: "MS", name: "Mato Grosso do Sul" },
  { uf: "MG", name: "Minas Gerais" },
  { uf: "PA", name: "Pará" },
  { uf: "PB", name: "Paraíba" },
  { uf: "PR", name: "Paraná" },
  { uf: "PE", name: "Pernambuco" },
  { uf: "PI", name: "Piauí" },
  { uf: "RJ", name: "Rio de Janeiro" },
  { uf: "RN", name: "Rio Grande do Norte" },
  { uf: "RS", name: "Rio Grande do Sul" },
  { uf: "RO", name: "Rondônia" },
  { uf: "RR", name: "Roraima" },
  { uf: "SC", name: "Santa Catarina" },
  { uf: "SP", name: "São Paulo" },
  { uf: "SE", name: "Sergipe" },
  { uf: "TO", name: "Tocantins" },
] as const;

const STATE_BY_UF = new Map<string, BrazilianState>(
  BRAZILIAN_STATES.map((item) => [item.uf, item]),
);

const citiesCache = new Map<string, CityOption[]>();
const resolvedCache = new Map<string, ResolvedCity>();

/**
 * Normaliza acentos, caixa, apóstrofos, hífens e espaços duplicados.
 * Ex.: "Santa Bárbara d'Oeste" === "santa barbara d oeste".
 */
export function normalizeCityName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’`´-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeStateUf(value: string): string {
  return value.trim().toUpperCase();
}

export function listStates(): BrazilianState[] {
  return [...BRAZILIAN_STATES];
}

interface IbgeMunicipioRaw {
  id: number;
  nome: string;
}

export async function listCitiesByState(uf: string): Promise<CityOption[]> {
  const normalizedUf = normalizeStateUf(uf);
  const stateInfo = STATE_BY_UF.get(normalizedUf);
  if (!stateInfo) return [];

  const cached = citiesCache.get(normalizedUf);
  if (cached) return cached;

  const url = `https://servicodados.ibge.gov.br/api/v1/localidades/estados/${encodeURIComponent(normalizedUf)}/municipios?orderBy=nome`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Falha ao consultar municípios no IBGE (HTTP ${response.status}).`);
  }

  const raw = (await response.json()) as IbgeMunicipioRaw[];
  const cities: CityOption[] = raw.map((item) => ({
    ibgeCode: Number(item.id),
    name: item.nome,
    state: normalizedUf,
  }));

  citiesCache.set(normalizedUf, cities);
  return cities;
}

interface NominatimResult {
  lat: string;
  lon: string;
  address?: {
    state?: string;
    "ISO3166-2-lvl4"?: string;
    country_code?: string;
  };
}

function matchesNominatimState(
  result: NominatimResult,
  stateInfo: BrazilianState,
): boolean {
  const iso = result.address?.["ISO3166-2-lvl4"]?.toUpperCase();
  if (iso) {
    return iso === `BR-${stateInfo.uf}`;
  }
  const returnedState = result.address?.state;
  if (!returnedState) return false;
  return normalizeCityName(returnedState) === normalizeCityName(stateInfo.name);
}

async function queryNominatim(
  params: URLSearchParams,
  stateInfo: BrazilianState,
): Promise<{ lat: number; lng: number } | null> {
  const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "SpottedCompanyAdmin/1.0 (spottedadmin-geocoder)",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Falha ao consultar coordenadas no Nominatim (HTTP ${response.status}).`);
  }

  const results = (await response.json()) as NominatimResult[];
  const match = results.find((item) => matchesNominatimState(item, stateInfo));
  if (!match) return null;

  const lat = Number(match.lat);
  const lng = Number(match.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return {
    lat: Number(lat.toFixed(6)),
    lng: Number(lng.toFixed(6)),
  };
}

/**
 * Valida cidade + UF contra a lista oficial do IBGE e resolve lat/lng via Nominatim.
 * Nunca busca apenas pelo nome da cidade sem UF.
 */
export async function resolveCity(
  city: string,
  state: string,
): Promise<ResolvedCity | null> {
  const normalizedUf = normalizeStateUf(state);
  const stateInfo = STATE_BY_UF.get(normalizedUf);
  const normalizedInput = normalizeCityName(city);

  if (!stateInfo || !normalizedInput) return null;

  const cacheKey = `${normalizedUf}:${normalizedInput}`;
  const cached = resolvedCache.get(cacheKey);
  if (cached) return cached;

  const cities = await listCitiesByState(normalizedUf);
  const official = cities.find(
    (item) => normalizeCityName(item.name) === normalizedInput,
  );
  if (!official) return null;

  const structuredParams = new URLSearchParams({
    city: official.name,
    state: stateInfo.name,
    country: "Brazil",
    countrycodes: "br",
    format: "jsonv2",
    addressdetails: "1",
    limit: "5",
  });

  let coords = await queryNominatim(structuredParams, stateInfo);

  if (!coords) {
    const fallbackParams = new URLSearchParams({
      q: `${official.name}, ${stateInfo.name}, Brasil`,
      countrycodes: "br",
      format: "jsonv2",
      addressdetails: "1",
      limit: "5",
    });
    coords = await queryNominatim(fallbackParams, stateInfo);
  }

  if (!coords) return null;

  const resolved: ResolvedCity = {
    ibgeCode: official.ibgeCode,
    name: official.name,
    state: normalizedUf,
    lat: coords.lat,
    lng: coords.lng,
  };

  resolvedCache.set(cacheKey, resolved);
  return resolved;
}
