import type { Base4, CacheStatus, Molecule, SourceKind } from "./ingest";

export interface HistoryRecord {
  scan_id: string;
  sha256: string;
  source: SourceKind;
  display_name: string;
  accession: string | null;
  organism: string | null;
  molecule: Molecule;
  length: number;
  gc_pct: number;
  anomaly_count: number;
  last_scanned_pos: number;
  mutation_count: number;
  created_at: string;
  updated_at: string;
  rev: number;
}

export interface IngestItem {
  sha256: string;
  cache_status: CacheStatus;
  record: HistoryRecord;
  has_analysis_cache: boolean;
}

export interface IngestResponse {
  contract_version: number;
  items: IngestItem[];
  warnings: string[];
}

export interface HistoryPage {
  items: HistoryRecord[];
  next_cursor: string | null;
}

export interface HistorySyncResponse {
  since_rev: number;
  latest_rev: number;
  upserts: HistoryRecord[];
  deleted: string[];
}

export interface SequencePayload {
  sha256: string;
  molecule: Molecule;
  length: number;
  residues: string;
}

export interface Mutation {
  mutation_id: string;
  scan_id: string;
  sha256: string;
  position: number;
  ref: Base4 | "N";
  alt: Base4;
  delta_tm_c: number | null;
  delta_dg_kcal: number | null;
  delta_p_promoter: number | null;
  delta_p_cpg: number | null;
  delta_p_splice: number | null;
  pathogenicity: number | null;
  created_at: string;
}

export interface ModelScope {
  trained_on: string;
  warning: string;
}

export type AnomalyKind = "composition_shift" | "possible_hgt" | "low_complexity" | "unknown";

export interface AnomalyRegion {
  start: number;
  end: number;
  score: number;
  kind: AnomalyKind;
}

export interface AnalysisMeta {
  analysis_id: string;
  sha256: string;
  length: number;
  channel_ids: number[];
  params_hash: string;
  model_version: string;
  core_version: string;
  anomaly_count: number;
  regions: AnomalyRegion[];
  overview_bins: number;
}

export interface Health {
  status: "ok" | "degraded";
  core_version: string;
  core_available: boolean;
  model_version: string;
  model_available: boolean;
  watcher?: Record<string, unknown> | null;
  integrity?: Record<string, number> | null;
}
