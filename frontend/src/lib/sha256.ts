export const HASH_PREFIX = "hs1:" as const;

export class HashUnavailableError extends Error {
  constructor() {
    super("WebCrypto (crypto.subtle) is unavailable: a secure context (https or localhost) is required");
    this.name = "HashUnavailableError";
  }
}

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i] ?? 0];
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new HashUnavailableError();
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

export function sequenceSha256(residues: string): Promise<string> {
  return sha256Hex(HASH_PREFIX + residues);
}
