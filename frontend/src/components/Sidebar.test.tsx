import "fake-indexeddb/auto";
import * as React from "react";
(globalThis as any).React = React;

// @vitest-environment happy-dom
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type HelixApi } from "../api/client";
import { ServicesContext, type AppServices } from "../app/AppServices";
import type { HistoryRecord, IngestItem, IngestResponse } from "../contracts/history";
import { putHistoryMany, putSequence } from "../db/repo";
import { deleteHelixDB, openHelixDB, type HelixDB } from "../db/schema";
import { encodeCodes } from "../lib/iupac";
import { resetHelixStore, useHelixStore } from "../store/useHelixStore";
import { resetUiStore, useUiStore } from "../store/useUiStore";
import { byText, click, flush, installDomStubs, mount, q, qa, setValue, waitFor, type Mounted } from "../test/dom";
import { Sidebar } from "./Sidebar";

const st = () => useHelixStore.getState();
const ui = () => useUiStore.getState();
let seq = 0;

function rec(id: string, over: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    scan_id: id, sha256: createHash("sha256").update(`hs1:${id}`).digest("hex"), source: "PASTE", display_name: `seq-${id}`, accession: null, organism: null, molecule: "DNA",
    length: 100, gc_pct: 50, anomaly_count: 0, last_scanned_pos: 0, mutation_count: 0, created_at: "2026-10-20T10:00:00Z", updated_at: "2026-10-20T10:00:00Z", rev: 1, ...over,
  };
}

let api: any; let db: HelixDB; let dbName: string; let sync: ReturnType<typeof vi.fn>; let m: Mounted;

beforeEach(async () => {
  installDomStubs(); resetHelixStore(); resetUiStore(); dbName = `sidebar-${Date.now()}-${seq++}`; db = await openHelixDB(dbName); sync = vi.fn().mockResolvedValue({});
  api = {
    ingestNcbi: vi.fn(), ingestPdb: vi.fn(), ingestPaste: vi.fn(), ingestFiles: vi.fn(),
    getSequenceCodes: vi.fn().mockResolvedValue({ codes: encodeCodes("ACGTACGTAC"), length: 10, molecule: "DNA" }),
    getAnalysisTensor: vi.fn().mockRejectedValue(new ApiError(404, "none", null)),
    getAnalysisMeta: vi.fn(), listMutations: vi.fn().mockResolvedValue([]), listHistory: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    deleteHistory: vi.fn().mockResolvedValue(undefined),
  };
  const svc: AppServices = { api: api as unknown as HelixApi, db, syncer: { sync: sync as any }, getModelVersion: () => "m" };
  m = await mount(<ServicesContext.Provider value={svc}><Sidebar /></ServicesContext.Provider>);
});
afterEach(async () => { m.unmount(); db.close(); await deleteHelixDB(dbName); vi.unstubAllGlobals(); resetHelixStore(); });

const rowsOf = () => qa(m.host, '[role="option"]');

describe("Sidebar History", () => {
  it("shows the empty state initially", async () => {
    await waitFor(() => m.host.textContent!.includes("Nothing scanned yet"));
  });
});
