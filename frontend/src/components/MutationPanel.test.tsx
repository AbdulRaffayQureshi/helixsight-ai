// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type HelixApi } from "../api/client";
import { ServicesContext, type AppServices } from "../app/AppServices";
import type { Mutation } from "../contracts/history";
import { encodeCodes } from "../lib/iupac";
import { configureHelixServices, resetHelixStore, useHelixStore, type ScanClientLike } from "../store/useHelixStore";
import { resetUiStore, useUiStore } from "../store/useUiStore";
import { byText, click, flush, installDomStubs, mount, q, qa, setValue, waitFor, type Mounted } from "../test/dom";
import { MutationPanel, PathogenicityBar, transitionOf, verdictFor } from "./MutationPanel";

const SHA = "b".repeat(64);
const st = () => useHelixStore.getState();
const mk = (id: string, position: number, p: number | null, alt: "A" | "C" | "G" | "T" = "G"): Mutation => ({
  mutation_id: id, scan_id: "scan1", sha256: SHA, position, ref: "A", alt, delta_tm_c: -1.234, delta_dg_kcal: 0.456, delta_p_promoter: 0.1234, delta_p_cpg: null, delta_p_splice: -0.0123, pathogenicity: p, created_at: `2026-10-20T00:00:0${id.length}Z`,
});

class FakeScan implements ScanClientLike {
  calls: Array<[string, number, string]> = [];
  impl: (id: string, pos: number, alt: string) => Promise<Mutation> = async (_id, pos, alt) => ({ ...mk("m1", pos, 0.62), alt: alt as "G" });
  async connect() {} startScan() {} stop() {} checkpoint() {} mutateAsync(id: string, pos: number, alt: "A" | "C" | "G" | "T") { this.calls.push([id, pos, alt]); return this.impl(id, pos, alt); } setHandlers() {}
}

let m: Mounted; let scan: FakeScan; let api: { deleteMutation: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  installDomStubs(); resetHelixStore(); resetUiStore(); scan = new FakeScan(); api = { deleteMutation: vi.fn().mockResolvedValue(undefined) };
  configureHelixServices({ scan });
  const svc: AppServices = { api: api as unknown as HelixApi, db: null, syncer: null, getModelVersion: () => "m" };
  st().openSequence({ sha256: SHA, scanId: "scan1", codes: encodeCodes("ACGT".repeat(100)), molecule: "DNA", display: "demo" });
  m = await mount(<ServicesContext.Provider value={svc}><MutationPanel /></ServicesContext.Provider>);
});
afterEach(() => { m.unmount(); vi.unstubAllGlobals(); resetHelixStore(); });

describe("MutationPanel", () => {
  it("prompts for a selection and keeps Apply disabled initially", () => {
    expect(m.host.textContent).toContain("Select a base");
    expect(q<HTMLButtonElement>(m.host, "button.btn-laser")!.disabled).toBe(true);
  });
});
