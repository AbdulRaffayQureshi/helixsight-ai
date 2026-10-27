export const CONTRACT_VERSION = 1 as const;
export type SourceKind = "NCBI" | "PDB" | "PASTE" | "FILE";
export type Molecule = "DNA" | "RNA";
export type CacheStatus = "HIT_ACCESSION" | "HIT_SHA" | "MISS_STORED";
export type Base4 = "A" | "C" | "G" | "T";
export const SOURCE_KINDS: readonly SourceKind[] = ["NCBI", "PDB", "PASTE", "FILE"];

export const ERROR_CODES = [
  "INVALID_ACCESSION",
  "NCBI_NOT_FOUND",
  "NCBI_RATE_LIMITED",
  "UPSTREAM_TIMEOUT",
  "PDB_NOT_FOUND",
  "PDB_NO_NUCLEIC_ACID",
  "INVALID_IUPAC",
  "EMPTY_SEQUENCE",
  "SEQUENCE_TOO_LONG",
  "UNKNOWN_SEQUENCE",
  "CORE_UNAVAILABLE",
  "MODEL_UNAVAILABLE",
  "PROTOCOL_ERROR",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  detail?: Record<string, unknown> | null;
}

export interface InvalidIupacDetail {
  offset: number;
  raw_offset: number | null;
  char: string;
}

export interface SequenceTooLongDetail {
  length: number;
  max: number;
}

export function isErrorBody(x: unknown): x is ErrorBody {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.code === "string" && (ERROR_CODES as readonly string[]).includes(o.code) && typeof o.message === "string";
}

export interface NcbiIngestRequest {
  accession: string;
  db?: "nuccore";
  force_refresh?: boolean;
}

export interface PdbIngestRequest {
  pdb_id: string;
  entity_id?: number | null;
  all_nucleic_acid?: boolean;
  force_refresh?: boolean;
}

export interface PasteIngestRequest {
  text: string;
  label?: string | null;
}

export interface ProgressRequest {
  last_scanned_pos: number;
}

export interface MutationRequest {
  request_id: string;
  scan_id: string;
  position: number;
  alt: Base4;
}

export const ACCESSION_PATTERN = /^[A-Za-z]{1,4}_?[0-9]+(\.[0-9]+)?$/;
export const MAX_ACCESSION_LENGTH = 32;
export const PDB_ID_PATTERN = /^[0-9][A-Za-z0-9]{3}$/;
export const MAX_PASTE_CHARS = 20_000_000;
export const MAX_LABEL_CHARS = 120;

export function isValidAccession(s: string): boolean {
  return s.length <= MAX_ACCESSION_LENGTH && ACCESSION_PATTERN.test(s);
}

export function isValidPdbId(s: string): boolean {
  return PDB_ID_PATTERN.test(s);
}
