import { openDB, deleteDB, type DBSchema, type IDBPDatabase } from "idb";
import type { AnomalyRegion, HistoryRecord, Mutation } from "../contracts/history";
import type { Molecule } from "../contracts/ingest";
import { DB_NAME, DB_VERSION } from "../lib/constants";

export interface SequenceRow {
  sha256: string;
  molecule: Molecule;
  length: number;
  codes: ArrayBuffer;
  display: string;
}

export interface TensorRow {
  key: string;
  sha256: string;
  model_version: string;
  params_hash: string;
  channel_ids: number[];
  length: number;
  planes: ArrayBuffer;
  anomaly_regions: AnomalyRegion[];
  created_at: string;
}

export type MetaRow = { key: "last_rev"; value: number } | { key: "model_version"; value: string };
export type MetaKey = MetaRow["key"];

export interface HelixDBSchema extends DBSchema {
  history: {
    key: string;
    value: HistoryRecord;
    indexes: { by_created: string; by_sha: string; by_source: string; by_accession: string; by_rev: number };
  };
  sequences: { key: string; value: SequenceRow };
  tensors: { key: string; value: TensorRow; indexes: { by_sha: string } };
  mutations: { key: string; value: Mutation; indexes: { by_sha: string; by_scan: string } };
  meta: { key: string; value: MetaRow };
}

export type HelixDB = IDBPDatabase<HelixDBSchema>;
export const STORE_NAMES = ["history", "sequences", "tensors", "mutations", "meta"] as const;

export async function openHelixDB(name: string = DB_NAME): Promise<HelixDB> {
  return openDB<HelixDBSchema>(name, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const history = db.createObjectStore("history", { keyPath: "scan_id" });
        history.createIndex("by_created", "created_at");
        history.createIndex("by_sha", "sha256");
        history.createIndex("by_source", "source");
        history.createIndex("by_accession", "accession");
        history.createIndex("by_rev", "rev");

        db.createObjectStore("sequences", { keyPath: "sha256" });
        db.createObjectStore("tensors", { keyPath: "key" }).createIndex("by_sha", "sha256");

        const mutations = db.createObjectStore("mutations", { keyPath: "mutation_id" });
        mutations.createIndex("by_sha", "sha256");
        mutations.createIndex("by_scan", "scan_id");

        db.createObjectStore("meta", { keyPath: "key" });
      }
    },
    blocked() {
      console.warn("[helixsight] IndexedDB upgrade blocked by another tab; close other HelixSight tabs");
    },
    terminated() {
      console.error("[helixsight] IndexedDB connection terminated by the browser");
    },
  });
}

export function deleteHelixDB(name: string = DB_NAME): Promise<void> {
  return deleteDB(name);
}
