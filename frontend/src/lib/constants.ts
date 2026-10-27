export const DEFAULT_MAX_BP = 5_000_000;
export const DB_NAME = "helixsight";
export const DB_VERSION = 1;
export const FRAME_CHUNK_POSITIONS = 256;
export const SEQUENCE_STRIP_WINDOW = 41;
export const SLOW_OPEN_BUDGET_MS = 5;

export const GEO = { RISE: 0.34, PITCH: 3.4, BPT: 10, MAJOR: 2.2, MINOR: 1.2, R: 1.0 } as const;
export const DELTA = (2 * Math.PI * GEO.MINOR) / GEO.PITCH;
export const B_DNA_TWIST_RAD = (2 * Math.PI) / GEO.BPT;
export const Z_DNA = { RISE: 0.37, BPT: 12, R: 0.9 } as const;
export const HBONDS = { A: 2, T: 2, C: 3, G: 3 } as const;
export const BASE_COLORS = { A: "#4ADE80", C: "#60A5FA", G: "#FBBF24", T: "#F87171" } as const;
export const BASE_COLORS_CVD = { A: "#009E73", C: "#0072B2", G: "#F0E442", T: "#D55E00" } as const;
export const SOURCE_COLORS = { NCBI: "#38BDF8", PDB: "#C084FC", PASTE: "#94A3B8", FILE: "#2DD4BF" } as const;
