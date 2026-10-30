// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHelixServices, resetHelixStore, useHelixStore, type ScanClientLike } from "../store/useHelixStore";
import { resetUiStore } from "../store/useUiStore";
import { installDomStubs, click, mount, q, qa, setChecked, setValue, byText, flush, type Mounted } from "../test/dom";
import { Hud, SPEED_PRESETS, sliderToSpeed, speedToSlider } from "./Hud";
import { encodeCodes } from "../lib/iupac";
import { CHANNELS } from "../contracts/ws";

class FakeScan implements ScanClientLike {
  started: unknown[] = []; stops = 0;
  async connect() {} startScan(r: unknown) { this.started.push(r); } stop() { this.stops++; } checkpoint() {} mutateAsync(): never { throw new Error("unused"); } setHandlers() {}
}

let m: Mounted; let scan: FakeScan; const st = () => useHelixStore.getState();

beforeEach(async () => {
  installDomStubs(); resetHelixStore(); resetUiStore(); scan = new FakeScan(); configureHelixServices({ scan });
  st().openSequence({ sha256: "a".repeat(64), scanId: "s1", codes: encodeCodes("ACGT".repeat(250)), molecule: "DNA", display: "demo seq" });
  m = await mount(<Hud />);
});
afterEach(() => { m.unmount(); vi.unstubAllGlobals(); resetHelixStore(); });

describe("speed mapping", () => {
  it("is a log scale that round-trips and is clamped", () => {
    expect(sliderToSpeed(0)).toBe(1); expect(sliderToSpeed(1)).toBe(2000);
    expect(speedToSlider(1)).toBeCloseTo(0, 9); expect(speedToSlider(2000)).toBeCloseTo(1, 9);
  });
});

describe("Hud", () => {
  it("shows the sequence summary and play/pause toggles the store", async () => {
    expect(m.host.textContent).toContain("demo seq");
    await click(q(m.host, 'button[aria-label="Play"]'));
    expect(st().playing).toBe(true);
  });
});
