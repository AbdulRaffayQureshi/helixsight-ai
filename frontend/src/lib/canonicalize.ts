import type { ErrorBody, ErrorCode, Molecule } from "../contracts/ingest";
import { DEFAULT_MAX_BP } from "./constants";
import { sequenceSha256 } from "./sha256";

export interface CanonicalizeOptions {
  label?: string | null;
  nameHint?: string | null;
  maxBp?: number;
}

export interface CanonicalDraft {
  display_name: string;
  description: string | null;
  molecule: Molecule;
  residues: string;
  length: number;
  gc_pct: number;
  a: number;
  c: number;
  g: number;
  t: number;
  ambiguous: number;
}

export interface CanonicalRecord extends CanonicalDraft {
  sha256: string;
}

export class CanonicalizeError extends Error {
  readonly code: ErrorCode;
  readonly detail: Record<string, unknown> | null;
  constructor(code: ErrorCode, message: string, detail: Record<string, unknown> | null = null) {
    super(message);
    this.name = "CanonicalizeError";
    this.code = code;
    this.detail = detail;
  }
  toErrorBody(): ErrorBody {
    return { code: this.code, message: this.message, detail: this.detail };
  }
}

const STRIP_RE = /[ \t\n\r\f\v\u00a0\ufeff0-9*-]+/g;
const NON_ASCII_RE = /[^\x00-\x7f]/;
const BAD_RE = /[^ACGTRYSWKMBDHVN]/u;
const LOWER_RUN_RE = /[a-z]+/g;
const TRIM_RE = /^[ \t\n\r\f\v\u00a0]+|[ \t\n\r\f\v\u00a0]+$/g;

const isStripCode = (c: number): boolean =>
  (c >= 48 && c <= 57) || c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0xfeff || c === 42 || c === 45;

const trimWs = (s: string): string => s.replace(TRIM_RE, "");

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function utf16ToCodePointOffset(text: string, utf16Index: number): number {
  let n = 0;
  for (let i = 0; i < utf16Index && i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

export function codePointToUtf16Offset(text: string, cp: number): number {
  let i = 0;
  for (let n = 0; n < cp && i < text.length; n++) {
    const c = text.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1;
  }
  return i;
}

const upperAscii = (s: string, ascii: boolean): string =>
  ascii ? s.toUpperCase() : s.replace(LOWER_RUN_RE, (m) => m.toUpperCase());

interface RawRecord {
  header: string | null;
  spans: number[];
}

function split(text: string): RawRecord[] {
  const recs: RawRecord[] = [];
  let header: string | null = null;
  let spans: number[] = [];
  let pos = 0;
  for (const line of text.split("\n")) {
    const start = pos;
    pos += line.length + 1;
    if (line.charCodeAt(0) === 62) {
      recs.push({ header, spans });
      header = trimWs(line.slice(1));
      spans = [];
    } else {
      spans.push(start, start + line.length);
    }
  }
  recs.push({ header, spans });
  return recs;
}

function rawOffsetUtf16(text: string, spans: number[], idx: number): number | null {
  let n = 0;
  for (let k = 0; k < spans.length; k += 2) {
    const e = spans[k + 1] ?? 0;
    for (let j = spans[k] ?? 0; j < e; j++) {
      if (isStripCode(text.charCodeAt(j))) continue;
      if (n === idx) return j;
      n++;
    }
  }
  return null;
}

const codePointLength = (s: string): number => utf16ToCodePointOffset(s, s.length);

export function canonicalizeDraft(
  input: string,
  opts: CanonicalizeOptions = {},
): { records: CanonicalDraft[]; warnings: string[] } {
  const maxBp = opts.maxBp ?? DEFAULT_MAX_BP;
  const label = opts.label ?? null;
  const nameHint = opts.nameHint ?? null;
  const text = normalizeNewlines(input);
  const warnings: string[] = [];
  const parsed: { header: string | null; spans: number[]; cleaned: string; ascii: boolean }[] = [];

  for (const { header, spans } of split(text)) {
    const parts: string[] = [];
    for (let k = 0; k < spans.length; k += 2) parts.push(text.slice(spans[k], spans[k + 1]));
    const stripped = parts.join("").replace(STRIP_RE, "");
    const ascii = !NON_ASCII_RE.test(stripped);
    const cleaned = upperAscii(stripped, ascii);
    if (cleaned.length === 0) {
      if (header !== null) warnings.push(`record "${header.split(" ", 1)[0] || "unnamed"}" is empty and was skipped`);
      continue;
    }
    parsed.push({ header, spans, cleaned, ascii });
  }
  if (parsed.length === 0) throw new CanonicalizeError("EMPTY_SEQUENCE", "No nucleotide residues found in the input");

  const records: CanonicalDraft[] = [];
  for (const p of parsed) {
    let cleaned = p.cleaned;
    let molecule: Molecule = "DNA";
    if (cleaned.includes("U") && !cleaned.includes("T")) {
      cleaned = cleaned.replace(/U/g, "T");
      molecule = "RNA";
    }
    const length = p.ascii ? cleaned.length : codePointLength(cleaned);
    if (length > maxBp) {
      throw new CanonicalizeError(
        "SEQUENCE_TOO_LONG",
        `Sequence has ${length.toLocaleString("en-US")} bases; the limit is ${maxBp.toLocaleString("en-US")}`,
        { length, max: maxBp },
      );
    }
    const bad = BAD_RE.exec(cleaned);
    if (bad) {
      const raw16 = rawOffsetUtf16(text, p.spans, bad.index);
      throw new CanonicalizeError("INVALID_IUPAC", `Invalid nucleotide '${bad[0]}' at residue offset ${bad.index}`, {
        offset: bad.index,
        raw_offset: raw16 === null ? null : utf16ToCodePointOffset(text, raw16),
        char: bad[0],
      });
    }
    let a = 0, c = 0, g = 0, t = 0;
    for (let i = 0; i < cleaned.length; i++) {
      switch (cleaned.charCodeAt(i)) {
        case 65: a++; break;
        case 67: c++; break;
        case 71: g++; break;
        case 84: t++; break;
      }
    }
    const acgt = a + c + g + t;
    const header = p.header;
    const sp = header === null ? -1 : header.indexOf(" ");
    const hdrName = header === null ? "" : sp < 0 ? header : header.slice(0, sp);
    const hdrDesc = header === null || sp < 0 ? "" : header.slice(sp + 1);
    let name: string;
    if (header) {
      name = hdrName;
      if (label) name = parsed.length === 1 ? label : `${label}:${hdrName}`;
    } else {
      name = label || nameHint || `pasted-${"\u0000"}`;
    }
    records.push({
      display_name: name,
      description: trimWs(hdrDesc) || null,
      molecule,
      residues: cleaned,
      length,
      gc_pct: acgt ? (100 * (g + c)) / acgt : 0,
      a, c, g, t,
      ambiguous: length - acgt,
    });
  }
  return { records, warnings };
}

export async function canonicalize(
  input: string,
  opts: CanonicalizeOptions = {},
): Promise<{ records: CanonicalRecord[]; warnings: string[] }> {
  const { records: drafts, warnings } = canonicalizeDraft(input, opts);
  const shas = await Promise.all(drafts.map((d) => sequenceSha256(d.residues)));
  const records = drafts.map((d, i): CanonicalRecord => {
    const sha256 = shas[i] ?? "";
    return { ...d, sha256, display_name: d.display_name.replace("pasted-\u0000", `pasted-${sha256.slice(0, 8)}`) };
  });
  return { records, warnings };
}
