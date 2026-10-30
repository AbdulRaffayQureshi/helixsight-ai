import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HistoryRecord, HistorySyncResponse, Mutation } from "../contracts/history";
import { encodeCodes } from "../lib/iupac";
import {
  getMeta,
  listHistory,
  listMutationsByScan,
  loadWorkbench,
  packPlanes,
  putHistoryMany,
  putIngestItems,
  putMutations,
  putSequence,
  putTensors,
  removeScans,
  setMeta,
  splitPlanes,
  tensorKey,
} from "./repo";
import { deleteHelixDB, openHelixDB, type HelixDB } from "./schema";
import { createSyncer, type FetchSync } from "./sync";

let dbName = "";
let db: HelixDB;
let counter = 0;

beforeEach(async () => {
  dbName = `helix-test-${Date.now()}-${counter++}`;
  db = await openHelixDB(dbName);
});

afterEach(async () => {
  db.close();
  await deleteHelixDB(dbName);
});

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function rec(scan_id: string, sha256: string, rev: number, extra: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    scan_id,
    sha256,
    source: "PASTE",
    display_name: `seq-${scan_id}`,
    accession: null,
    organism: null,
    molecule: "DNA",
    length: 100,
    gc_pct: 50,
    anomaly_count: 0,
    last_scanned_pos: 0,
    mutation_count: 0,
    created_at: `2026-10-${String(10 + rev).padStart(2, "0")}T12:00:00Z`,
    updated_at: `2026-10-${String(10 + rev).padStart(2, "0")}T12:00:00Z`,
    rev,
    ...extra,
  };
}

function mut(id: string, scan_id: string, sha256: string, position: number): Mutation {
  return {
    mutation_id: id,
    scan_id,
    sha256,
    position,
    ref: "A",
    alt: "G",
    delta_tm_c: -1.5,
    delta_dg_kcal: 0.4,
    delta_p_promoter: 0.1,
    delta_p_cpg: null,
    delta_p_splice: null,
    pathogenicity: 0.3,
    created_at: "2026-10-20T12:00:00Z",
  };
}

describe("schema", () => {
  it("creates the five stores and their indexes", () => {
    expect(Array.from(db.objectStoreNames).sort()).toEqual(["history", "meta", "mutations", "sequences", "tensors"]);
    const tx = db.transaction(["history", "tensors", "mutations"], "readonly");
    expect(Array.from(tx.objectStore("history").indexNames).sort()).toEqual([
      "by_accession",
      "by_created",
      "by_rev",
      "by_sha",
      "by_source",
    ]);
    expect(Array.from(tx.objectStore("tensors").indexNames)).toEqual(["by_sha"]);
    expect(Array.from(tx.objectStore("mutations").indexNames).sort()).toEqual(["by_scan", "by_sha"]);
  });
});

describe("history", () => {
  it("lists newest first with source/q filters, offset and limit", async () => {
    await putHistoryMany(db, [
      rec("s1", SHA_A, 1, { display_name: "alpha" }),
      rec("s2", SHA_B, 2, { source: "NCBI", accession: "NM_004006.3", organism: "Homo sapiens", display_name: "dystrophin" }),
      rec("s3", SHA_A, 3, { source: "FILE", display_name: "gamma" }),
    ]);
    expect((await listHistory(db)).map((r) => r.scan_id)).toEqual(["s3", "s2", "s1"]);
    expect((await listHistory(db, { source: "NCBI" })).map((r) => r.scan_id)).toEqual(["s2"]);
    expect((await listHistory(db, { q: "nm_004" })).map((r) => r.scan_id)).toEqual(["s2"]);
    expect((await listHistory(db, { q: "HOMO" })).map((r) => r.scan_id)).toEqual(["s2"]);
    expect((await listHistory(db, { limit: 1, offset: 1 })).map((r) => r.scan_id)).toEqual(["s2"]);
  });

  it("putIngestItems stores the optimistic records", async () => {
    await putIngestItems(db, [
      { sha256: SHA_A, cache_status: "MISS_STORED", has_analysis_cache: false, record: rec("s9", SHA_A, 9) },
    ]);
    expect((await listHistory(db))[0]?.scan_id).toBe("s9");
  });

  it("removeScans cascades to mutations and drops orphaned sequences/tensors only", async () => {
    await putHistoryMany(db, [rec("s1", SHA_A, 1), rec("s2", SHA_A, 2), rec("s3", SHA_B, 3)]);
    for (const sha of [SHA_A, SHA_B]) {
      await putSequence(db, { sha256: sha, molecule: "DNA", display: "x", residues: "ACGT" });
      await putTensors(db, { sha256: sha, modelVersion: "m", paramsHash: "p", channelIds: [0], length: 4, planes: [new Float32Array(4)] });
    }
    await putMutations(db, [mut("m1", "s1", SHA_A, 1), mut("m2", "s2", SHA_A, 2), mut("m3", "s3", SHA_B, 3)]);
    expect(await removeScans(db, ["s1"])).toBe(1);
    expect(await loadWorkbench(db, SHA_A)).not.toBeNull();
    expect(await listMutationsByScan(db, "s1")).toHaveLength(0);
    expect(await removeScans(db, ["s3", "unknown"])).toBe(1);
    expect(await loadWorkbench(db, SHA_B)).toBeNull();
    expect(await db.getAllFromIndex("tensors", "by_sha", SHA_B)).toHaveLength(0);
    expect(await listMutationsByScan(db, "s3")).toHaveLength(0);
  });
});

describe("planes", () => {
  it("splitPlanes returns zero-copy views over ONE buffer, indexed by channel id", () => {
    const buf = new Float32Array([1, 2, 3, 4, 5, 6]).buffer;
    const planes = splitPlanes(buf, [2, 12], 3);
    expect(planes).toHaveLength(13);
    expect(planes[2]).toEqual(new Float32Array([1, 2, 3]));
    expect(planes[12]).toEqual(new Float32Array([4, 5, 6]));
    expect(planes[0]).toBeNull();
    expect(planes[2]!.buffer).toBe(buf);
    expect(planes[12]!.buffer).toBe(buf);
    expect(planes[12]!.byteOffset).toBe(12);
    expect(() => splitPlanes(buf, [2, 12], 4)).toThrow(RangeError);
  });

  it("packPlanes/splitPlanes round-trip keeps NaN and fills missing channels with NaN", () => {
    const ch0 = new Float32Array([1, NaN, 3]);
    const buf = packPlanes([ch0, undefined, new Float32Array([7, 8, 9])], [0, 1, 2], 3);
    const planes = splitPlanes(buf, [0, 1, 2], 3);
    expect(Number.isNaN(planes[0]![1])).toBe(true);
    expect(Array.from(planes[1]!).every(Number.isNaN)).toBe(true);
    expect(Array.from(planes[2]!)).toEqual([7, 8, 9]);
    expect(() => packPlanes([new Float32Array(2)], [0], 3)).toThrow(RangeError);
  });
});

describe("loadWorkbench", () => {
  const L = 1000;

  async function seed(length: number, nMut = 3) {
    const codes = new Uint8Array(length);
    for (let i = 0; i < length; i++) codes[i] = (i * 7 + (i >> 3)) & 3;
    await putSequence(db, { sha256: SHA_A, molecule: "DNA", display: "demo", codes });
    const byChannel = Array.from({ length: 13 }, (_, c) => Float32Array.from({ length }, (_, i) => c + i / length));
    const tensors = await putTensors(db, {
      sha256: SHA_A,
      modelVersion: "stub+1",
      paramsHash: "h1",
      channelIds: Array.from({ length: 13 }, (_, i) => i),
      length,
      planes: byChannel,
      anomalyRegions: [{ start: 10, end: 90, score: 0.9, kind: "composition_shift" }],
    });
    await putHistoryMany(db, [rec("s1", SHA_A, 1), rec("s2", SHA_A, 2)]);
    await putMutations(db, [
      ...Array.from({ length: nMut }, (_, i) => mut(`m${i}`, "s1", SHA_A, i)),
      mut("other", "s2", SHA_A, 99),
    ]);
    return { codes, byChannel, tensors };
  }

  it("returns sequence, zero-copy planes, regions and mutations in one transaction", async () => {
    const { codes, byChannel } = await seed(L);
    const w = (await loadWorkbench(db, SHA_A, { scanId: "s1", modelVersion: "stub+1", paramsHash: "h1" }))!;
    expect(w.length).toBe(L);
    expect(w.molecule).toBe("DNA");
    expect(w.display).toBe("demo");
    expect(Array.from(w.codes)).toEqual(Array.from(codes));
    expect(w.tensors!.planes).toHaveLength(13);
    expect(Array.from(w.tensors!.planes[5]!)).toEqual(Array.from(byChannel[5]!));
    expect(w.tensors!.planes[0]!.buffer).toBe(w.tensors!.planes[12]!.buffer);
    expect(w.tensors!.regions).toEqual([{ start: 10, end: 90, score: 0.9, kind: "composition_shift" }]);
    expect(w.mutations.map((m) => m.mutation_id).sort()).toEqual(["m0", "m1", "m2"]);
    expect(w.warnings).toEqual([]);
    expect((await loadWorkbench(db, SHA_A))!.mutations).toHaveLength(4);
    expect((await loadWorkbench(db, SHA_A))!.tensors!.key).toBe(tensorKey(SHA_A, "stub+1", "h1"));
  });

  it("returns null for an unknown sequence, null tensors without analysis, and warns on corrupt tensors", async () => {
    expect(await loadWorkbench(db, SHA_B)).toBeNull();
    await putSequence(db, { sha256: SHA_B, molecule: "RNA", display: "r", residues: "ACGU" });
    const w = (await loadWorkbench(db, SHA_B))!;
    expect(w.tensors).toBeNull();
    expect(Array.from(w.codes)).toEqual(Array.from(encodeCodes("ACGT")));
    await db.put("tensors", {
      key: tensorKey(SHA_B, "m", "p"),
      sha256: SHA_B,
      model_version: "m",
      params_hash: "p",
      channel_ids: [0, 1],
      length: 4,
      planes: new ArrayBuffer(8),
      anomaly_regions: [],
      created_at: "2026-10-20T00:00:00Z",
    });
    const bad = (await loadWorkbench(db, SHA_B, { modelVersion: "m", paramsHash: "p" }))!;
    expect(bad.tensors).toBeNull();
    expect(bad.warnings[0]).toMatch(/corrupt tensor/);
  });

  it("meta round-trip", async () => {
    expect(await getMeta(db, "last_rev")).toBeUndefined();
    await setMeta(db, "last_rev", 42);
    await setMeta(db, "model_version", "stub+1");
    expect(await getMeta(db, "last_rev")).toBe(42);
    expect(await getMeta(db, "model_version")).toBe("stub+1");
  });

  it("opens a 50 kb sequence with 13 channels and 20 mutations in < 5 ms (median)", async () => {
    await seed(50_000, 20);
    const opts = { scanId: "s1", modelVersion: "stub+1", paramsHash: "h1" };
    for (let i = 0; i < 10; i++) await loadWorkbench(db, SHA_A, opts);
    const ms: number[] = [];
    for (let i = 0; i < 60; i++) {
      const t0 = performance.now();
      const w = await loadWorkbench(db, SHA_A, opts);
      ms.push(performance.now() - t0);
      expect(w!.length).toBe(50_000);
    }
    ms.sort((a, b) => a - b);
    const median = ms[Math.floor(ms.length / 2)]!;
    const p95 = ms[Math.floor(ms.length * 0.95)]!;
    console.log(
      `loadWorkbench 50kb x 13ch + 20 mutations: median ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${ms[ms.length - 1]!.toFixed(2)} ms`,
    );
    expect(median).toBeLessThan(25);
  });
});

describe("delta sync", () => {
  function fakeServer() {
    let latest = 0;
    const rows = new Map<string, HistoryRecord>();
    const deleted = new Set<string>();
    const log: number[] = [];
    const tomb = new Map<string, number>();
    const fetchSync: FetchSync = async (since) => {
      log.push(since);
      return {
        since_rev: since,
        latest_rev: latest,
        upserts: [...rows.values()].filter((r) => r.rev > since).sort((a, b) => a.rev - b.rev),
        deleted: [...deleted].filter((id) => (tomb.get(id) ?? 0) > since),
      } satisfies HistorySyncResponse;
    };
    return {
      fetchSync,
      log,
      rows,
      upsert(r: Omit<HistoryRecord, "rev">) {
        latest++;
        rows.set(r.scan_id, { ...r, rev: latest } as HistoryRecord);
        deleted.delete(r.scan_id);
      },
      remove(id: string) {
        latest++;
        rows.delete(id);
        deleted.add(id);
        tomb.set(id, latest);
      },
      get latest() {
        return latest;
      },
      reset() {
        latest = 0;
        rows.clear();
        deleted.clear();
        tomb.clear();
      },
      setLatest(n: number) {
        latest = n;
      },
    };
  }

  const base = (id: string, sha: string): Omit<HistoryRecord, "rev"> => {
    const { rev: _r, ...rest } = rec(id, sha, 1);
    return rest;
  };

  it("applies upserts incrementally, advances the cursor and applies tombstones with orphan cleanup", async () => {
    const srv = fakeServer();
    const syncer = createSyncer(db, srv.fetchSync);
    srv.upsert(base("s1", SHA_A));
    srv.upsert(base("s2", SHA_A));
    expect(await syncer.sync()).toEqual({ upserts: 2, deleted: 0, latestRev: 2, reset: false });
    expect(await getMeta(db, "last_rev")).toBe(2);
    expect(await syncer.sync()).toMatchObject({ upserts: 0, deleted: 0, latestRev: 2 });
    expect(srv.log).toEqual([0, 2]);

    await putSequence(db, { sha256: SHA_A, molecule: "DNA", display: "x", residues: "ACGT" });
    await putMutations(db, [mut("m1", "s1", SHA_A, 1)]);
    srv.remove("s1");
    srv.upsert({ ...base("s2", SHA_A), display_name: "renamed" });
    const r = await syncer.sync();
    expect(r).toMatchObject({ upserts: 1, deleted: 1, latestRev: 4 });
    expect((await listHistory(db)).map((x) => x.display_name)).toEqual(["renamed"]);
    expect(await listMutationsByScan(db, "s1")).toHaveLength(0);
    expect(await loadWorkbench(db, SHA_A)).not.toBeNull();

    srv.remove("s2");
    await syncer.sync();
    expect(await listHistory(db)).toHaveLength(0);
    expect(await loadWorkbench(db, SHA_A)).toBeNull();
  });

  it("is single-flight and leaves the cursor untouched when the request fails", async () => {
    const srv = fakeServer();
    srv.upsert(base("s1", SHA_A));
    let calls = 0;
    const slow: FetchSync = async (since, signal) => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return srv.fetchSync(since, signal);
    };
    const syncer = createSyncer(db, slow);
    const [a, b] = await Promise.all([syncer.sync(), syncer.sync()]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(a.upserts).toBe(1);

    const failing = createSyncer(db, async () => {
      throw new Error("offline");
    });
    await expect(failing.sync()).rejects.toThrow("offline");
    expect(await getMeta(db, "last_rev")).toBe(1);
    expect(await listHistory(db)).toHaveLength(1);
  });

  it("rebuilds from rev 0 when the server's revision counter went backwards", async () => {
    const srv = fakeServer();
    const syncer = createSyncer(db, srv.fetchSync);
    srv.upsert(base("old1", SHA_A));
    srv.upsert(base("old2", SHA_A));
    srv.upsert(base("old3", SHA_A));
    await syncer.sync();
    await putMutations(db, [mut("mx", "old1", SHA_A, 0)]);
    expect(await getMeta(db, "last_rev")).toBe(3);

    srv.reset();
    srv.upsert(base("new1", SHA_B));
    const r = await syncer.sync();
    expect(r).toMatchObject({ reset: true, upserts: 1, latestRev: 1 });
    expect((await listHistory(db)).map((x) => x.scan_id)).toEqual(["new1"]);
    expect(await listMutationsByScan(db, "old1")).toHaveLength(0);
    expect(await getMeta(db, "last_rev")).toBe(1);
  });
});
