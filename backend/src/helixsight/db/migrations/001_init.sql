CREATE TABLE IF NOT EXISTS schema_meta (key VARCHAR PRIMARY KEY, value VARCHAR NOT NULL);
CREATE SEQUENCE IF NOT EXISTS rev_seq START 1;

CREATE TABLE IF NOT EXISTS sequences (
  sha256          VARCHAR PRIMARY KEY CHECK (length(sha256) = 64),
  residues        VARCHAR NOT NULL,
  molecule        VARCHAR NOT NULL CHECK (molecule IN ('DNA', 'RNA')),
  length          UINTEGER NOT NULL CHECK (length > 0),
  gc_pct          FLOAT NOT NULL DEFAULT 0,
  a_count         UINTEGER NOT NULL DEFAULT 0,
  c_count         UINTEGER NOT NULL DEFAULT 0,
  g_count         UINTEGER NOT NULL DEFAULT 0,
  t_count         UINTEGER NOT NULL DEFAULT 0,
  ambiguous_count UINTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS source_records (
  record_id    VARCHAR PRIMARY KEY,
  sha256       VARCHAR NOT NULL,
  source       VARCHAR NOT NULL CHECK (source IN ('NCBI', 'PDB', 'PASTE', 'FILE')),
  accession    VARCHAR,
  entity_id    INTEGER,
  display_name VARCHAR NOT NULL,
  description  VARCHAR,
  organism     VARCHAR,
  meta_json    JSON,
  fetched_at   TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_records_sha ON source_records (sha256);

CREATE TABLE IF NOT EXISTS accession_index (
  source         VARCHAR NOT NULL CHECK (source IN ('NCBI', 'PDB')),
  accession_key  VARCHAR NOT NULL,
  sha256         VARCHAR NOT NULL,
  resolved_acc   VARCHAR,
  fetched_at     TIMESTAMP NOT NULL,
  ttl_expires_at TIMESTAMP,
  PRIMARY KEY (source, accession_key)
);

CREATE TABLE IF NOT EXISTS analysis_cache (
  analysis_id     VARCHAR PRIMARY KEY,
  sha256          VARCHAR NOT NULL,
  model_version   VARCHAR NOT NULL,
  core_version    VARCHAR NOT NULL,
  params_hash     VARCHAR NOT NULL,
  params_json     JSON NOT NULL,
  length          UINTEGER NOT NULL,
  channel_ids     VARCHAR NOT NULL,
  n_channels      USMALLINT NOT NULL,
  chunk_positions UINTEGER NOT NULL,
  n_chunks        UINTEGER NOT NULL,
  codec           VARCHAR NOT NULL CHECK (codec IN ('raw', 'zstd')),
  anomaly_count   INTEGER NOT NULL DEFAULT 0,
  summary_json    JSON,
  overview_bins   UINTEGER NOT NULL DEFAULT 0,
  overview        BLOB,
  created_at      TIMESTAMP NOT NULL,
  UNIQUE (sha256, model_version, core_version, params_hash)
);

CREATE TABLE IF NOT EXISTS analysis_chunks (
  analysis_id VARCHAR NOT NULL,
  chunk_idx   UINTEGER NOT NULL,
  start_pos   UINTEGER NOT NULL,
  count       UINTEGER NOT NULL,
  payload     BLOB NOT NULL,
  PRIMARY KEY (analysis_id, chunk_idx)
);

CREATE TABLE IF NOT EXISTS analysis_history (
  scan_id          VARCHAR PRIMARY KEY,
  sha256           VARCHAR NOT NULL,
  record_id        VARCHAR,
  analysis_id      VARCHAR,
  source           VARCHAR NOT NULL CHECK (source IN ('NCBI', 'PDB', 'PASTE', 'FILE')),
  display_name     VARCHAR NOT NULL,
  accession        VARCHAR,
  length           UINTEGER NOT NULL,
  gc_pct           FLOAT NOT NULL,
  anomaly_count    INTEGER NOT NULL DEFAULT 0,
  last_scanned_pos UINTEGER NOT NULL DEFAULT 0,
  mutation_count   INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMP NOT NULL,
  updated_at       TIMESTAMP NOT NULL,
  deleted          BOOLEAN NOT NULL DEFAULT FALSE,
  rev              BIGINT NOT NULL DEFAULT nextval('rev_seq')
);
CREATE INDEX IF NOT EXISTS idx_history_sha ON analysis_history (sha256);
CREATE INDEX IF NOT EXISTS idx_history_created ON analysis_history (created_at);

CREATE TABLE IF NOT EXISTS mutations (
  mutation_id      VARCHAR PRIMARY KEY,
  scan_id          VARCHAR NOT NULL,
  sha256           VARCHAR NOT NULL,
  position         UINTEGER NOT NULL,
  ref_base         VARCHAR NOT NULL CHECK (ref_base IN ('A', 'C', 'G', 'T', 'N')),
  alt_base         VARCHAR NOT NULL CHECK (alt_base IN ('A', 'C', 'G', 'T')),
  delta_tm_c       FLOAT,
  delta_dg_kcal    FLOAT,
  delta_p_promoter FLOAT,
  delta_p_cpg      FLOAT,
  delta_p_splice   FLOAT,
  pathogenicity    FLOAT CHECK (pathogenicity IS NULL OR (pathogenicity >= 0 AND pathogenicity <= 1)),
  created_at       TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mutations_scan ON mutations (scan_id);

CREATE TABLE IF NOT EXISTS watch_files (
  path        VARCHAR PRIMARY KEY,
  size_bytes  UBIGINT NOT NULL,
  mtime_ns    UBIGINT NOT NULL,
  status      VARCHAR NOT NULL CHECK (status IN ('ingested', 'failed')),
  error       VARCHAR,
  ingested_at TIMESTAMP NOT NULL
);

CREATE OR REPLACE VIEW v_history_record AS
SELECT h.scan_id, h.sha256, h.source, h.display_name, h.accession, r.organism, s.molecule,
       h.length, h.gc_pct, h.anomaly_count, h.last_scanned_pos, h.mutation_count,
       h.created_at, h.updated_at, h.rev, h.deleted
FROM analysis_history h
JOIN sequences s ON s.sha256 = h.sha256
LEFT JOIN source_records r ON r.record_id = h.record_id;

INSERT OR IGNORE INTO schema_meta VALUES ('contract_version', '1');
