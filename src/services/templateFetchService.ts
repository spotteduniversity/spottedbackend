import { Buffer } from "buffer";

const MAGIC_BYTES: Record<string, number[]> = {
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "image/webp": [0x52, 0x49, 0x46, 0x46],
};

export class TemplateFetchError extends Error {
  constructor(message: string, public readonly code: string, public readonly status?: number) {
    super(message);
    this.name = "TemplateFetchError";
  }
}

function checkMagicBytes(buffer: Buffer): boolean {
  return Object.values(MAGIC_BYTES).some((magic) =>
    magic.every((byte, index) => buffer[index] === byte)
  );
}

export async function fetchTemplateBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);

  if (!res.ok) {
    throw new TemplateFetchError(
      `Falha ao baixar template: HTTP ${res.status}`,
      "FETCH_FAILED",
      res.status
    );
  }

  const contentType = res.headers.get("content-type");
  if (!contentType || !contentType.startsWith("image/")) {
    throw new TemplateFetchError(
      `Content-Type inválido: ${contentType || "ausente"}`,
      "INVALID_CONTENT_TYPE"
    );
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (!checkMagicBytes(buffer)) {
    throw new TemplateFetchError(
      "Arquivo não é uma imagem válida (JPEG/PNG/WebP)",
      "INVALID_MAGIC_BYTES"
    );
  }

  return buffer;
}