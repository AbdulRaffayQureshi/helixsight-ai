export const IUPAC_NUCLEOTIDES = "ACGTRYSWKMBDHVN" as const;
export const CODE_A = 0;
export const CODE_C = 1;
export const CODE_G = 2;
export const CODE_T = 3;
export const CODE_N = 4;

const ALLOWED = new Uint8Array(128);
for (const ch of IUPAC_NUCLEOTIDES) ALLOWED[ch.charCodeAt(0)] = 1;

export function isIupacCode(charCode: number): boolean {
  return charCode < 128 && ALLOWED[charCode] === 1;
}

export function isIupacString(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (!isIupacCode(s.charCodeAt(i))) return false;
  return true;
}

const CODE_LUT = new Uint8Array(256).fill(CODE_N);
for (const [ch, code] of [["A", CODE_A], ["C", CODE_C], ["G", CODE_G], ["T", CODE_T], ["U", CODE_T]] as const) {
  CODE_LUT[ch.charCodeAt(0)] = code;
  CODE_LUT[ch.toLowerCase().charCodeAt(0)] = code;
}

export function encodeCodes(residues: string): Uint8Array {
  const out = new Uint8Array(residues.length);
  for (let i = 0; i < residues.length; i++) out[i] = CODE_LUT[residues.charCodeAt(i) & 0xff] ?? CODE_N;
  return out;
}

const LETTERS = "ACGTN";
export function decodeCodes(codes: Uint8Array): string {
  const parts: string[] = [];
  const CH = 0x8000;
  for (let i = 0; i < codes.length; i += CH) {
    const slice = codes.subarray(i, Math.min(codes.length, i + CH));
    parts.push(String.fromCharCode(...Array.from(slice, (c) => LETTERS.charCodeAt(c > 4 ? 4 : c))));
  }
  return parts.join("");
}

export function complementCode(code: number): number {
  return code < 4 ? 3 - code : CODE_N;
}

const COMPLEMENT: Record<string, string> = {
  A: "T", T: "A", C: "G", G: "C", R: "Y", Y: "R", K: "M", M: "K", B: "V", V: "B", D: "H", H: "D", S: "S", W: "W", N: "N",
};

export function complementBase(base: string): string {
  return COMPLEMENT[base] ?? "N";
}

export function reverseComplement(seq: string): string {
  let out = "";
  for (let i = seq.length - 1; i >= 0; i--) out += complementBase(seq.charAt(i));
  return out;
}
