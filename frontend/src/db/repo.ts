import type { IDBPTransaction } from "idb";
import type { AnomalyRegion, HistoryRecord, IngestItem, Mutation } from "../contracts/history";
import type { Molecule, SourceKind } from "../contracts/ingest";
import { N_CHANNELS } from "../contracts/ws";
import { encodeCodes } from "../lib/iupac";
import type { HelixDB, HelixDBSchema, MetaKey, SequenceRow, TensorRow } from "./schema";

export type FullTx = IDBPTransaction<HelixDBSchema, ["history", "sequences", "tensors", "mutations", "meta"], "readwrite">;
const ALL_STORES: ["history", "sequences", "tensors", "mutations", "meta"] = ["history", "sequences", "tensors", "mutations", "meta"];

export const tensorKey = (sha256: string, modelVersion: string, paramsHash: string): string =>
  `${sha256}|${modelVersion}|${paramsHash}`;

interface MetaValues {
  last_rev: number;
  model_version: string;
}

export async function getMeta<K extends MetaKey>(db: HelixDB, key: K): Promise<MetaValues[K] | undefined> {
  const row = await db.get("meta", key);
  return row?.value as MetaValues[K] | undefined;
}

export async function setMeta<K extends MetaKey>(db: HelixDB, key: K, value: MetaValues[K]): Promise<void> {
  await db.put("meta", { key, value } as { key: "last_rev"; value: number } | { key: "model_version"; value: string });
}

export async function putHistoryMany(db: HelixDB, records: readonly HistoryRecord[]): Promise<void> {
  if (records.length === 0) return;
  const tx = db.transaction("history", "readwrite");
  await Promise.all([...records.map((r) => tx.store.put(r)), tx.done]);
}

export const putHistory = (db: HelixDB, record: HistoryRecord): Promise<void> => putHistoryMany(db, [record]);
export const putIngestItems = (db: HelixDB, items: readonly IngestItem[]): Promise<void> =>
  putHistoryMany(db, items.map((i) => i.record));
export const getHistory = (db: HelixDB, scanId: string): Promise<HistoryRecord | undefined> => db.get("history", scanId);

export interface ListHistoryOptions {
  limit?: number;
  offset?: number;
  source?: SourceKind;
  q?: string;
}

export async function listHistory(db: HelixDB, opts: ListHistoryOptions = {}): Promise<HistoryRecord[]> {
  const { limit = 50, offset = 0, source, q } = opts;
  const needle = q?.trim().toLowerCase();
  const out: HistoryRecord[] = [];
  let skipped = 0;
  let cur = await db.transaction("history").store.index("by_created").openCursor(null, "prev");
  while (cur) {
    const r = cur.value;
    const ok =
      (!source || r.source === source) &&
      (!needle ||
        r.display_name.toLowerCase().includes(needle) ||
        (r.accession ?? "").toLowerCase().includes(needle) ||
        (r.organism ?? "").toLowerCase().includes(needle));
    if (ok) {
      if (skipped < offset) skipped++;
      else {
        out.push(r);
        if (out.length >= limit) break;
      }
    }
    cur = await cur.continue();
  }
  return out;
}

export async function removeScansInTx(tx: FullTx, scanIds: readonly string[]): Promise<number> {
  const touched = new Set<string>();
  let removed = 0;
  for (const id of scanIds) {
    const row = await tx.objectStore("history").get(id);
    if (!row) continue;
    await tx.objectStore("history").delete(id);
    removed++;
    touched.add(row.sha256);
    for (const k of await tx.objectStore("mutations").index("by_scan").getAllKeys(id)) {
      await tx.objectStore("mutations").delete(k);
    }
  }
  for (const sha of touched) {
    if ((await tx.objectStore("history").index("by_sha").count(sha)) > 0) continue;
    await tx.objectStore("sequences").delete(sha);
    for (const k of await tx.objectStore("tensors").index("by_sha").getAllKeys(sha)) {
      await tx.objectStore("tensors").delete(k);
    }
  }
  return removed;
}

export async function removeScans(db: HelixDB, scanIds: readonly string[]): Promise<number> {
  const tx = db.transaction(ALL_STORES, "readwrite");
  const [removed] = await Promise.all([removeScansInTx(tx, scanIds), tx.done]);
  return removed;
}

export async function clearHistoryState(tx: FullTx): Promise<void> {
  await Promise.all([
    tx.objectStore("history").clear(),
    tx.objectStore("mutations").clear(),
    tx.objectStore("meta").delete("last_rev"),
  ]);
}

export function openTx(db: HelixDB): FullTx {
  return db.transaction(ALL_STORES, "readwrite");
}

export interface PutSequenceInput {
  sha256: string;
  molecule: Molecule;
  display: string;
  residues?: string;
  codes?: Uint8Array;
}

export async function putSequence(db: HelixDB, input: PutSequenceInput): Promise<SequenceRow> {
  const codes = input.codes ?? (input.residues !== undefined ? encodeCodes(input.residues) : undefined);
  if (!codes) throw new TypeError("putSequence needs residues or codes");
  const buf =
    codes.byteOffset === 0 && codes.byteLength === codes.buffer.byteLength
      ? (codes.buffer as ArrayBuffer)
      : (codes.slice().buffer as ArrayBuffer);
  const row: SequenceRow = {
    sha256: input.sha256,
    molecule: input.molecule,
    length: codes.length,
    codes: buf,
    display: input.display,
  };
  await db.put("sequences", row);
  return row;
}

export function packPlanes(
  byChannel: ReadonlyArray<Float32Array | null | undefined>,
  channelIds: readonly number[],
  length: number,
): ArrayBuffer {
  const out = new Float32Array(channelIds.length * length);
  channelIds.forEach((id, i) => {
    const src = byChannel[id];
    if (!src) out.fill(NaN, i * length, (i + 1) * length);
    else if (src.length !== length) throw new RangeError(`channel ${id} has ${src.length} values, expected ${length}`);
    else out.set(src, i * length);
  });
  return out.buffer;
}

export function splitPlanes(buffer: ArrayBuffer, channelIds: readonly number[], length: number): (Float32Array | null)[] {
  if (buffer.byteLength !== channelIds.length * length * 4) {
    throw new RangeError(`tensor buffer is ${buffer.byteLength} bytes, expected ${channelIds.length * length * 4}`);
  }
  const size = Math.max(N_CHANNELS, ...channelIds.map((c) => c + 1));
  const planes: (Float32Array | null)[] = new Array<Float32Array | null>(size).fill(null);
  channelIds.forEach((id, i) => {
    planes[id] = new Float32Array(buffer, i * length * 4, length);
  });
  return planes;
}

export interface PutTensorsInput {
  sha256: string;
  modelVersion: string;
  paramsHash: string;
  channelIds: readonly number[];
  length: number;
  planes: ArrayBuffer | ReadonlyArray<Float32Array | null | undefined>;
  anomalyRegions?: readonly AnomalyRegion[];
}

export async function putTensors(db: HelixDB, input: PutTensorsInput): Promise<TensorRow> {
  const planes =
    input.planes instanceof ArrayBuffer ? input.planes : packPlanes(input.planes, input.channelIds, input.length);
  if (planes.byteLength !== input.channelIds.length * input.length * 4) {
    throw new RangeError("planes buffer has the wrong size");
  }
  const row: TensorRow = {
    key: tensorKey(input.sha256, input.modelVersion, input.paramsHash),
    sha256: input.sha256,
    model_version: input.modelVersion,
    params_hash: input.paramsHash,
    channel_ids: [...input.channelIds],
    length: input.length,
    planes,
    anomaly_regions: [...(input.anomalyRegions ?? [])],
    created_at: new Date().toISOString(),
  };
  await db.put("tensors", row);
  return row;
}

export async function putMutations(db: HelixDB, muts: readonly Mutation[]): Promise<void> {
  if (muts.length === 0) return;
  const tx = db.transaction("mutations", "readwrite");
  await Promise.all([...muts.map((m) => tx.store.put(m)), tx.done]);
}

export const putMutation = (db: HelixDB, m: Mutation): Promise<void> => putMutations(db, [m]);
export const deleteMutation = (db: HelixDB, id: string): Promise<void> => db.delete("mutations", id);
export const listMutationsByScan = (db: HelixDB, scanId: string): Promise<Mutation[]> =>
  db.getAllFromIndex("mutations", "by_scan", scanId);

export interface LoadedTensors {
  key: string;
  modelVersion: string;
  paramsHash: string;
  channelIds: number[];
  planes: (Float32Array | null)[];
  regions: AnomalyRegion[];
}

export interface LoadedWorkbench {
  sha256: string;
  molecule: Molecule;
  length: number;
  display: string;
  codes: Uint8Array;
  tensors: LoadedTensors | null;
  mutations: Mutation[];
  warnings: string[];
  elapsedMs: number;
}

export interface LoadWorkbenchOptions {
  scanId?: string;
  modelVersion?: string;
  paramsHash?: string;
}

export async function loadWorkbench(
  db: HelixDB,
  sha256: string,
  opts: LoadWorkbenchOptions = {},
): Promise<LoadedWorkbench | null> {
  const t0 = performance.now();
  const tx = db.transaction(["sequences", "tensors", "mutations"], "readonly");
  const tensors = tx.objectStore("tensors");
  const mutations = tx.objectStore("mutations");
  const [seq, tensorRow, muts] = await Promise.all([
    tx.objectStore("sequences").get(sha256),
    opts.modelVersion !== undefined && opts.paramsHash !== undefined
      ? tensors.get(tensorKey(sha256, opts.modelVersion, opts.paramsHash))
      : tensors.index("by_sha").get(sha256),
    opts.scanId !== undefined ? mutations.index("by_scan").getAll(opts.scanId) : mutations.index("by_sha").getAll(sha256),
    tx.done,
  ]).then(([s, t, m]) => [s, t, m] as const);
  if (!seq) return null;

  const warnings: string[] = [];
  if (seq.codes.byteLength !== seq.length) {
    warnings.push(`stored codes are ${seq.codes.byteLength} bytes but length is ${seq.length}`);
  }
  let loaded: LoadedTensors | null = null;
  if (tensorRow) {
    try {
      loaded = {
        key: tensorRow.key,
        modelVersion: tensorRow.model_version,
        paramsHash: tensorRow.params_hash,
        channelIds: tensorRow.channel_ids,
        planes: splitPlanes(tensorRow.planes, tensorRow.channel_ids, tensorRow.length),
        regions: tensorRow.anomaly_regions,
      };
    } catch (e) {
      warnings.push(`ignoring corrupt tensor ${tensorRow.key}: ${(e as Error).message}`);
    }
  }
  return {
    sha256: seq.sha256,
    molecule: seq.molecule,
    length: seq.length,
    display: seq.display,
    codes: new Uint8Array(seq.codes),
    tensors: loaded,
    mutations: muts,
    warnings,
    elapsedMs: performance.now() - t0,
  };
}
