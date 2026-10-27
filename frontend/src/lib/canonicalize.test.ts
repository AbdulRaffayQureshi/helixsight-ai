import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  CanonicalizeError,
  canonicalize,
  canonicalizeDraft,
  codePointToUtf16Offset,
  utf16ToCodePointOffset,
} from "./canonicalize";
import { decodeCodes, encodeCodes, reverseComplement } from "./iupac";
import { HashUnavailableError, sequenceSha256, sha256Hex } from "./sha256";

interface GoldenRecord {
  display_name: string;
  description: string | null;
  molecule: "DNA" | "RNA";
  residues: string;
  length: number;
  gc_pct: number;
  a: number;
  c: number;
  g: number;
  t: number;
  ambiguous: number;
  sha256: string;
}
interface GoldenCase {
  id: string;
  description: string;
  input: string;
  options: { label: string | null; name_hint: string | null; max_bp: number };
  expect:
    | { ok: true; warnings: string[]; records: GoldenRecord[] }
    | { ok: false; code: string; detail: Record<string, unknown> | null };
}

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../docs/golden_vectors.json", import.meta.url)), "utf8"),
) as {
  version: number;
  hash_prefix: string;
  cases: GoldenCase[];
};

const optsOf = (c: GoldenCase) => ({ label: c.options.label, nameHint: c.options.name_hint, maxBp: c.options.max_bp });

describe("golden vectors (parity with backend sanitizer.py)", () => {
  it("file shape: >= 20 uniquely named cases", () => {
    expect(golden.version).toBe(1);
    expect(golden.hash_prefix).toBe("hs1:");
    expect(golden.cases.length).toBeGreaterThanOrEqual(20);
    expect(new Set(golden.cases.map((c) => c.id)).size).toBe(golden.cases.length);
  });

  for (const c of golden.cases) {
    it(c.id, async () => {
      const exp = c.expect;
      if (exp.ok) {
        const { records, warnings } = await canonicalize(c.input, optsOf(c));
        expect(warnings).toEqual(exp.warnings);
        expect(records).toHaveLength(exp.records.length);
        records.forEach((got, i) => {
          const want = exp.records[i]!;
          expect({
            display_name: got.display_name,
            description: got.description,
            molecule: got.molecule,
            residues: got.residues,
            length: got.length,
            gc_pct: got.gc_pct,
            a: got.a,
            c: got.c,
            g: got.g,
            t: got.t,
            ambiguous: got.ambiguous,
            sha256: got.sha256,
          }).toEqual(want);
          expect(got.sha256).toBe(createHash("sha256").update(golden.hash_prefix + got.residues, "utf8").digest("hex"));
        });
      } else {
        const err = await canonicalize(c.input, optsOf(c)).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(CanonicalizeError);
        const e = err as CanonicalizeError;
        expect(e.code).toBe(exp.code);
        expect(e.detail).toEqual(exp.detail);
        expect(e.toErrorBody().code).toBe(exp.code);
      }
    });
  }
});

describe("offsets", () => {
  it("raw_offset counts code points; codePointToUtf16Offset selects the right <textarea> character", () => {
    const c = golden.cases.find((x) => x.id === "invalid-emoji-header-codepoint-offsets")!;
    const exp = c.expect as unknown as { ok: false; detail: { raw_offset: number } };
    const text = c.input.replace(/\r\n?/g, "\n");
    expect(exp.detail.raw_offset).toBe(12);
    const u16 = codePointToUtf16Offset(text, exp.detail.raw_offset);
    expect(u16).toBe(13);
    expect(text[u16]).toBe("X");
    expect(utf16ToCodePointOffset(text, u16)).toBe(12);
  });

  it("code point helpers handle lone surrogates and bounds", () => {
    expect(utf16ToCodePointOffset("a\ud83e", 2)).toBe(2);
    expect(codePointToUtf16Offset("ab", 99)).toBe(2);
    expect(codePointToUtf16Offset("\ud83e\uddecA", 1)).toBe(2);
  });
});

describe("behaviour beyond the vectors", () => {
  it("CRLF, CR and LF give identical results", async () => {
    const lf = await canonicalize(">a\nACGT\nTTGG\n>b\nGG\n");
    const crlf = await canonicalize(">a\r\nACGT\r\nTTGG\r\n>b\r\nGG\r\n");
    const cr = await canonicalize(">a\rACGT\rTTGG\r>b\rGG\r");
    expect(crlf).toEqual(lf);
    expect(cr).toEqual(lf);
  });

  it("canonicalizeDraft needs no WebCrypto and names header-less records with a placeholder-free draft", () => {
    const { records } = canonicalizeDraft("acgt", { nameHint: "x" });
    expect(records[0]).toMatchObject({ display_name: "x", residues: "ACGT", length: 4 });
    expect("sha256" in records[0]!).toBe(false);
  });

  it("sha256 identity matches node:crypto and ignores source/format", async () => {
    expect(await sequenceSha256("ACGT")).toBe(createHash("sha256").update("hs1:ACGT").digest("hex"));
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    const a = (await canonicalize(">whatever\nggcc nnaatt")).records[0]!;
    const b = (await canonicalize("GGCCNNAATT")).records[0]!;
    expect(a.sha256).toBe(b.sha256);
  });

  it("raises HashUnavailableError without crypto.subtle", async () => {
    vi.stubGlobal("crypto", {});
    try {
      await expect(sha256Hex("x")).rejects.toBeInstanceOf(HashUnavailableError);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("encode/decode codes and reverse complement", () => {
    expect(Array.from(encodeCodes("ACGTacgtUNR"))).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 3, 4, 4]);
    expect(decodeCodes(encodeCodes("ACGTN"))).toBe("ACGTN");
    expect(reverseComplement("AACGTN")).toBe("NACGTT");
    expect(decodeCodes(new Uint8Array(70_000).fill(2)).length).toBe(70_000);
  });

  it("handles a 1 Mbp paste synchronously and quickly", () => {
    const seq = "ACGT".repeat(250_000);
    const t0 = performance.now();
    const { records } = canonicalizeDraft(`>big\n${seq.replace(/(.{70})/g, "$1\n")}`);
    expect(records[0]!.length).toBe(1_000_000);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
