import { describe, expect, it } from "vitest";
import { DELTA, GEO, Z_DNA } from "../lib/constants";
import {
  GeometryTable, HEAT_LUT, HelixRenderer, MAX_WINDOW_BP, baseAtZ, computeLayout, createLayout, createRenderInput, drawNumber, hitTestBase,
  morphAt, phaseAt, projectX, stepRise, stepTwist, type RenderInput, type Sample,
} from "./helixMath";

const TAU = 2 * Math.PI;
const S = (): Sample => ({ z: 0, th: 0, s: 0 });

describe("geometry constants", () => {
  it("DELTA yields the spec groove widths", () => {
    expect(DELTA).toBeCloseTo(2.2176, 4);
  });
});

describe("morph driven by z_propensity > 0.5", () => {
  const o = { blend: 0, auto: true, zThreshold: 0.5 };
  it("is B-form up to the threshold", () => {
    expect(morphAt(0, o)).toBe(0);
    expect(morphAt(1, o)).toBe(1);
  });
});

describe("GeometryTable", () => {
  it("B-DNA: 10 bp per 2*pi", () => {
    const t = new GeometryTable(100);
    t.extend(null, 100);
    expect(t.cumZ[10]).toBeCloseTo(3.4, 9);
  });
});

describe("phaseAt / baseAtZ", () => {
  const t = new GeometryTable(200);
  t.extend(Float32Array.from({ length: 200 }, (_, i) => (i > 90 && i < 110 ? 1 : 0)), 150);
  it("interpolates inside the built range", () => {
    const a = phaseAt(t, 10.5, S());
    expect(a.z).toBeCloseTo(10.5 * 0.34, 9);
  });
});

describe("layout, projection and hit-testing", () => {
  const L = 300;
  const t = new GeometryTable(L);
  t.extend(null, L);
  const lay = createLayout();
  computeLayout(lay, 900, 300, 40, t, 120.4);

  it("projects the head to the canvas centre", () => {
    expect(projectX(lay, phaseAt(t, 120.4, S()).z)).toBeCloseTo(lay.cx, 9);
  });
});

describe("drawNumber", () => {
  const capture = () => {
    const out: string[] = [];
    return { ctx: { fillText: (s: string) => out.push(s) } as unknown as CanvasRenderingContext2D, text: () => out.join("") };
  };
  it("renders digits without building strings", () => {
    for (const [v, d, want] of [[12.34, 2, "12.34"], [0, 0, "0"], [NaN, 2, "--"]] as const) {
      const c = capture();
      drawNumber(c.ctx, v, 0, 0, d);
      expect(c.text()).toBe(want);
    }
  });
});

describe("HelixRenderer", () => {
  class MockCtx {
    calls = new Map<string, number>();
    texts: string[] = [];
    fillStyle = ""; strokeStyle = ""; lineWidth = 0; globalAlpha = 1; font = ""; lineCap = ""; lineJoin = ""; textAlign = "";
    private bump(n: string) { this.calls.set(n, (this.calls.get(n) ?? 0) + 1); }
    setTransform() { this.bump("setTransform"); }
    fillRect() { this.bump("fillRect"); }
    beginPath() { this.bump("beginPath"); }
    moveTo() { this.bump("moveTo"); }
    lineTo() { this.bump("lineTo"); }
    closePath() { this.bump("closePath"); }
    stroke() { this.bump("stroke"); }
    fill() { this.bump("fill"); }
    arc() { this.bump("arc"); }
    setLineDash(d: number[]) { this.bump("setLineDash"); this.lastDash = d; }
    lastDash: number[] | null = null;
    fillText(s: string) { this.bump("fillText"); this.texts.push(s); }
  }

  function scene(L = 400): { inp: RenderInput; table: GeometryTable } {
    const codes = Uint8Array.from({ length: L }, (_, i) => (i % 53 === 7 ? 4 : (i * 5 + (i >> 2)) & 3));
    const table = new GeometryTable(L);
    const inp = createRenderInput();
    Object.assign(inp, {
      width: 900, height: 300, dpr: 1, codes, length: L, headPos: 200.3, windowBp: 40, filledUpTo: L, table,
      attention: Float32Array.from({ length: L }, (_, i) => (i % 7) / 7), zProp: Float32Array.from({ length: L }, (_, i) => (i > 205 && i < 225 ? 0.9 : 0.1)),
      tm: Float32Array.from({ length: L }, (_, i) => 50 + (i % 20)), heatMin: 50, heatMax: 70,
      regions: [{ start: 190, end: 215, score: 0.9, kind: "composition_shift" }], mutations: [{ position: 205 }] as never,
      selectedBase: 200, hoveredBase: 201,
    });
    return { inp, table };
  }

  it("draws rungs, strands, bonds, halos and labels", () => {
    const { inp } = scene();
    const r = new HelixRenderer();
    const ctx = new MockCtx();
    r.render(ctx as unknown as CanvasRenderingContext2D, inp);
    expect(r.rungCount).toBeGreaterThanOrEqual(41);
  });
});
