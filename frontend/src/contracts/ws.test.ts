import { describe, expect, it } from "vitest";
import {
  CHANNEL,
  CHANNELS,
  FLAG,
  FRAME_HEADER_BYTES,
  FRAME_TYPE,
  FrameError,
  decodeFrame,
  frameChannel,
  hasNaN,
  isFinalFrame,
  isFromCache,
} from "./ws";

const TELEMETRY_HEX = "4853010103000000e80300000300000002000700000000000000c03f0000c07f000000c00000803e0000003f0000403f";
const OVERVIEW_HEX = "4853010200000000050000000200000002000000000000000000803f000000400000404000008040";
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));

describe("decodeFrame (parity with framing.py)", () => {
  it("decodes a telemetry frame with flags, NaN and channel-major planes", () => {
    const u8 = bytes(TELEMETRY_HEX);
    const f = decodeFrame(u8.buffer);
    expect(f).toMatchObject({ frameType: FRAME_TYPE.TELEMETRY_CHUNK, streamSeq: 3, startPos: 1000, count: 3, channelCount: 2 });
    expect(isFinalFrame(f) && isFromCache(f) && hasNaN(f)).toBe(true);
    expect(f.flags).toBe(FLAG.FINAL | FLAG.FROM_CACHE | FLAG.HAS_NAN);
    expect(Array.from(frameChannel(f, 1))).toEqual([0.25, 0.5, 0.75]);
    const ch0 = frameChannel(f, 0);
    expect([ch0[0], ch0[2]]).toEqual([1.5, -2]);
    expect(Number.isNaN(ch0[1])).toBe(true);
    expect(f.planes.buffer).toBe(u8.buffer);
    expect(f.planes.byteOffset).toBe(FRAME_HEADER_BYTES);
  });

  it("decodes an overview frame (startPos = bin size)", () => {
    const f = decodeFrame(bytes(OVERVIEW_HEX).buffer);
    expect(f).toMatchObject({ frameType: FRAME_TYPE.OVERVIEW, streamSeq: 0, startPos: 5, count: 2, channelCount: 2, flags: 0 });
    expect(Array.from(f.planes)).toEqual([1, 2, 3, 4]);
  });

  it("accepts typed-array views, copying only when the payload is not 4-byte aligned", () => {
    const raw = bytes(TELEMETRY_HEX);
    const padded = new Uint8Array(raw.length + 4);
    padded.set(raw, 4);
    const aligned = decodeFrame(padded.subarray(4));
    expect(aligned.planes.buffer).toBe(padded.buffer);
    expect(Array.from(frameChannel(aligned, 1))).toEqual([0.25, 0.5, 0.75]);
    const odd = new Uint8Array(raw.length + 1);
    odd.set(raw, 1);
    const unaligned = decodeFrame(odd.subarray(1));
    expect(unaligned.planes.buffer).not.toBe(odd.buffer);
    expect(Array.from(frameChannel(unaligned, 1))).toEqual([0.25, 0.5, 0.75]);
  });

  it("rejects malformed frames", () => {
    const good = bytes(TELEMETRY_HEX);
    expect(() => decodeFrame(good.slice(0, 10).buffer)).toThrow(FrameError);
    expect(() => decodeFrame(good.slice(0, good.length - 4).buffer)).toThrow(/announces/);
    const badMagic = good.slice();
    badMagic[0] = 0;
    expect(() => decodeFrame(badMagic.buffer)).toThrow(/magic/);
    const badVersion = good.slice();
    badVersion[2] = 9;
    expect(() => decodeFrame(badVersion.buffer)).toThrow(/version/);
    const badType = good.slice();
    badType[3] = 7;
    expect(() => decodeFrame(badType.buffer)).toThrow(/type/);
    expect(() => frameChannel(decodeFrame(good.buffer), 2)).toThrow(RangeError);
  });

  it("channel registry is dense, ordered and consistent with CHANNEL ids", () => {
    expect(CHANNELS.map((c) => c.id)).toEqual(Array.from({ length: 13 }, (_, i) => i));
    for (const [name, id] of Object.entries(CHANNEL)) expect(CHANNELS[id]!.name).toBe(name);
  });
});
