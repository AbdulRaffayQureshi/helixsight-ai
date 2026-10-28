import type { FcgrK, FcgrRequest, FcgrResponse } from "./fcgr";

export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((ev: { data: FcgrResponse }) => void) | null;
  onerror: ((ev: { message?: string }) => void) | null;
}
export type FcgrGrid = Extract<FcgrResponse, { type: "grid" }>;

export class FcgrClient {
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (r: FcgrResponse) => void; reject: (e: Error) => void }>();
  private readonly worker: WorkerLike;

  constructor(worker?: WorkerLike) {
    this.worker = worker ?? (new Worker(new URL("./fcgr.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike);
    this.worker.onmessage = (ev) => {
      const w = this.waiting.get(ev.data.id);
      if (!w) return;
      this.waiting.delete(ev.data.id);
      if (ev.data.type === "error") w.reject(new Error(ev.data.message)); else w.resolve(ev.data);
    };
    this.worker.onerror = (ev) => {
      const err = new Error(ev.message ?? "fcgr worker crashed");
      for (const w of this.waiting.values()) w.reject(err);
      this.waiting.clear();
    };
  }

  private call(build: (id: number) => FcgrRequest, transfer: Transferable[] = []): Promise<FcgrResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage(build(id), transfer);
    });
  }

  async init(k: FcgrK, codes: Uint8Array): Promise<void> { await this.call((id) => ({ type: "init", id, k, codes }), [codes.buffer]); }
  advance(upTo: number): Promise<FcgrGrid> { return this.call((id) => ({ type: "advance", id, upTo })) as Promise<FcgrGrid>; }
  seek(pos: number): Promise<FcgrGrid> { return this.call((id) => ({ type: "seek", id, pos })) as Promise<FcgrGrid>; }
  window(from: number, to: number): Promise<FcgrGrid> { return this.call((id) => ({ type: "window", id, from, to })) as Promise<FcgrGrid>; }
  async spectrum(k?: number, from?: number, to?: number): Promise<Uint32Array> {
    const r = (await this.call((id) => ({ type: "spectrum", id, ...(k !== undefined ? { k } : {}), ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) }))) as Extract<FcgrResponse, { type: "spectrum" }>;
    return r.spectrum;
  }
  dispose(): void { this.worker.postMessage({ type: "dispose", id: 0 } satisfies FcgrRequest); this.worker.terminate(); }
}
