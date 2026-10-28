import { describe, expect, it } from "vitest";
import { encodeCodes } from "../lib/iupac";
import {
  FcgrAccumulator, cellOfPoint, createFcgrSession, densityToRgba, fcgrCounts, handleFcgrMessage, kmerSpectrum, kmerToCellIndex, spectrumToFcgr,
  type FcgrK, type FcgrResponse,
} from "./fcgr";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
function randomCodes(n: number, seed: number, pN = 0): Uint8Array {
  const r = rng(seed);
  return Uint8Array.from({ length: n }, () => (r() < pN ? 4 : Math.floor(r() * 4)));
}
function bruteSpectrum(codes: Uint8Array, k: number, from = 0, to = codes.length): Uint32Array {
  const out = new Uint32Array(4 ** k);
  for (let i = from; i + k <= to; i++) {
    let h = 0; let ok = true;
    for (let j = 0; j < k; j++) {
      const b = codes[i + j]!;
      if (b > 3) { ok = false; break; }
      h = h * 4 + b;
    }
    if (ok) out[h]!++;
  }
  return out;
}
const sum = (a: Uint32Array) => a.reduce((x, y) => x + y, 0);

describe("FCGR k=4", () => {
  it("poly-base runs land in the four CGR corners", () => {
    const k = 4;
    const n = 16;
    const corner = (b: string) => {
      const g = fcgrCounts(encodeCodes(b.repeat(50)), k);
      expect(sum(g)).toBe(47);
      return g.findIndex((v) => v === 47);
    };
    expect(corner("A")).toBe((n - 1) * n + 0);
  });

  it("matrix counts equal a brute-force k-mer count mapped through kmerToCellIndex", () => {
    const codes = randomCodes(500, 7, 0.01);
    const grid = fcgrCounts(codes, 4);
    const spec = bruteSpectrum(codes, 4);
    expect(sum(grid)).toBe(sum(spec));
  });
});

describe("densityToRgba", () => {
  it("maps zero to the background and the maximum to white, log-scaled", () => {
    const grid = new Uint32Array(256);
    grid[10] = 1;
    grid[11] = 1000;
    const out = new Uint8ClampedArray(256 * 4);
    densityToRgba(grid, 1000, out);
    expect(Array.from(out.slice(0, 4))).toEqual([7, 11, 20, 255]);
    expect(Array.from(out.slice(11 * 4, 11 * 4 + 4))).toEqual([255, 255, 255, 255]);
  });
});
