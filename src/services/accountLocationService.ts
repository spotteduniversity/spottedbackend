import { resolveCity } from "../lib/municipios";

export interface LocationFields {
  city: string | null;
  state: string | null;
  ibge_city_code: number | null;
  lat: number | null;
  lng: number | null;
}

export const EMPTY_LOCATION: LocationFields = {
  city: null,
  state: null,
  ibge_city_code: null,
  lat: null,
  lng: null,
};

export class LocationValidationError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "LocationValidationError";
  }
}

function normalizeOptionalString(value: unknown, fieldLabel: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new LocationValidationError(`${fieldLabel} deve ser texto.`);
  }
  return value.trim();
}

/**
 * Valida e infere os cinco campos de localização no servidor.
 *
 * - Ambos vazios -> zera todos os cinco campos (`EMPTY_LOCATION`).
 * - Apenas um preenchido -> erro de validação (constraint exige os cinco juntos).
 * - Ambos preenchidos -> resolve cidade oficial + IBGE + lat/lng no servidor.
 */
export async function resolveLocationFields(
  cityInput: unknown,
  stateInput: unknown,
): Promise<LocationFields> {
  const city = normalizeOptionalString(cityInput, "Cidade");
  const state = normalizeOptionalString(stateInput, "Estado");

  if (!city && !state) {
    return { ...EMPTY_LOCATION };
  }

  if (!city || !state) {
    throw new LocationValidationError(
      "Informe cidade e estado juntos, ou deixe ambos vazios.",
    );
  }

  const resolved = await resolveCity(city, state);
  if (!resolved) {
    throw new LocationValidationError(
      "Cidade não encontrada para o estado informado",
    );
  }

  return {
    city: resolved.name,
    state: resolved.state,
    ibge_city_code: resolved.ibgeCode,
    lat: resolved.lat,
    lng: resolved.lng,
  };
}
