// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelixApi } from "./api/client";
import type { ScanClient } from "./api/wsScan";
import App from "./App";
import type { IngestItem } from "./contracts/history";
import { deleteHelixDB } from "./db/schema";
import { resetHelixStore, useHelixStore } from "./store/useHelixStore";
import { resetUiStore, useUiStore } from "./store/useUiStore";
import { byText, click, installDomStubs, mount, q, waitFor, type Mounted } from "./test/dom";

const ui = () => useUiStore.getState();
let seq = 0; let dbName: string; let m: Mounted; let api: any; let scan: any;

beforeEach(async () => {
  installDomStubs(); resetHelixStore(); resetUiStore(); localStorage.clear(); dbName = `app-${Date.now()}-${seq++}`;
  api = {
    health: vi.fn().mockResolvedValue({ status: "degraded", core_version: "0.1.0", core_available: true, model_version: "none", model_available: false }),
    historySync: vi.fn().mockResolvedValue({ since_rev: 0, latest_rev: 0, upserts: [], deleted: [] }),
    ingestFiles: vi.fn().mockResolvedValue({ contract_version: 1, items: [], warnings: [] } satisfies { contract_version: number; items: IngestItem[]; warnings: string[] }),
  };
  scan = { close: vi.fn(), setHandlers: vi.fn(), helloAck: null };
  m = await mount(<App api={api as unknown as HelixApi} scan={scan as unknown as ScanClient} events={null} dbName={dbName} />);
  await waitFor(() => !!q(m.host, "header"));
});
afterEach(async () => { m.unmount(); await deleteHelixDB(dbName); vi.unstubAllGlobals(); resetHelixStore(); });

describe("App shell", () => {
  it("boots: header, split pane, HUD controls", async () => {
    expect(m.host.textContent).toContain("HelixSight");
    expect(q(m.host, 'aside[aria-label="Sequences"]')).not.toBeNull();
  });
});
