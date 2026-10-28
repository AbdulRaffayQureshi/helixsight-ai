import type {
  AnalysisMeta, Health, HistoryPage, HistoryRecord, HistorySyncResponse, IngestResponse, Mutation, SequencePayload,
} from "../contracts/history";
import {
  isErrorBody, type ErrorBody, type MutationRequest, type NcbiIngestRequest, type PasteIngestRequest, type PdbIngestRequest,
  type ProgressRequest, type SourceKind,
} from "../contracts/ingest";

export class ApiError extends Error {
  readonly status: number;
  readonly body: ErrorBody | null;
  constructor(status: number, message: string, body: ErrorBody | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
  get code(): ErrorBody["code"] | null {
    return this.body?.code ?? null;
  }
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface HistoryQuery {
  limit?: number;
  cursor?: string | null;
  source?: SourceKind;
  q?: string;
}

export interface UploadFile {
  name: string;
  data: Blob | string;
}

export interface AnalysisTensor {
  planes: ArrayBuffer;
  channelIds: number[];
  length: number;
  paramsHash: string;
}

export interface SequenceCodes {
  codes: Uint8Array;
  length: number;
  molecule: string;
}

export class HelixApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ApiClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "").replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? ((...a) => globalThis.fetch(...a));
  }

  private async send(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, { ...init, signal: signal ?? init.signal ?? null });
    } catch (e) {
      if ((e as { name?: string }).name === "AbortError") throw e;
      throw new ApiError(0, `network error: ${(e as Error).message}`, null);
    }
    if (!res.ok) {
      let body: ErrorBody | null = null;
      try {
        const j: unknown = await res.json();
        if (isErrorBody(j)) body = j;
      } catch {}
      throw new ApiError(res.status, body?.message ?? `HTTP ${res.status}`, body);
    }
    return res;
  }

  private async json<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    return (await (await this.send(path, init, signal)).json()) as T;
  }

  private post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.json<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, signal);
  }

  ingestNcbi(req: NcbiIngestRequest, signal?: AbortSignal): Promise<IngestResponse> { return this.post("/api/ingest/ncbi", req, signal); }
  ingestPdb(req: PdbIngestRequest, signal?: AbortSignal): Promise<IngestResponse> { return this.post("/api/ingest/pdb", req, signal); }
  ingestPaste(req: PasteIngestRequest, signal?: AbortSignal): Promise<IngestResponse> { return this.post("/api/ingest/paste", req, signal); }
  ingestFiles(files: ReadonlyArray<File | UploadFile>, signal?: AbortSignal): Promise<IngestResponse> {
    const form = new FormData();
    for (const f of files) {
      if ("data" in f) form.append("files", f.data instanceof Blob ? f.data : new Blob([f.data], { type: "text/plain" }), f.name);
      else form.append("files", f, f.name);
    }
    return this.json("/api/ingest/file", { method: "POST", body: form }, signal);
  }

  listHistory(q: HistoryQuery = {}, signal?: AbortSignal): Promise<HistoryPage> {
    const p = new URLSearchParams();
    if (q.limit !== undefined) p.set("limit", String(q.limit));
    if (q.cursor) p.set("cursor", q.cursor);
    if (q.source) p.set("source", q.source);
    if (q.q) p.set("q", q.q);
    const qs = p.toString();
    return this.json(`/api/history${qs ? `?${qs}` : ""}`, {}, signal);
  }
  historySync(sinceRev: number, signal?: AbortSignal): Promise<HistorySyncResponse> { return this.json(`/api/history/sync?since_rev=${sinceRev}`, {}, signal); }
  getHistory(scanId: string, signal?: AbortSignal): Promise<HistoryRecord> { return this.json(`/api/history/${encodeURIComponent(scanId)}`, {}, signal); }
  async deleteHistory(scanId: string, signal?: AbortSignal): Promise<void> { await this.send(`/api/history/${encodeURIComponent(scanId)}`, { method: "DELETE" }, signal); }
  postProgress(scanId: string, body: ProgressRequest, signal?: AbortSignal): Promise<HistoryRecord> { return this.post(`/api/history/${encodeURIComponent(scanId)}/progress`, body, signal); }
  listMutations(scanId: string, signal?: AbortSignal): Promise<Mutation[]> { return this.json(`/api/history/${encodeURIComponent(scanId)}/mutations`, {}, signal); }
  async deleteMutation(mutationId: string, signal?: AbortSignal): Promise<void> { await this.send(`/api/mutations/${encodeURIComponent(mutationId)}`, { method: "DELETE" }, signal); }

  getSequence(sha256: string, signal?: AbortSignal): Promise<SequencePayload> { return this.json(`/api/sequences/${sha256}`, {}, signal); }
  async getSequenceCodes(sha256: string, signal?: AbortSignal): Promise<SequenceCodes> {
    const res = await this.send(`/api/sequences/${sha256}?format=u8`, {}, signal);
    const codes = new Uint8Array(await res.arrayBuffer());
    const length = Number(res.headers.get("X-HS-Length") ?? codes.length);
    if (length !== codes.length) throw new ApiError(res.status, `sequence payload has ${codes.length} bytes but X-HS-Length says ${length}`, null);
    return { codes, length, molecule: res.headers.get("X-HS-Molecule") ?? "DNA" };
  }
  createMutation(sha256: string, body: MutationRequest, signal?: AbortSignal): Promise<Mutation> { return this.post(`/api/sequences/${sha256}/mutations`, body, signal); }
  getAnalysisMeta(sha256: string, paramsHash?: string, signal?: AbortSignal): Promise<AnalysisMeta> {
    const qs = paramsHash ? `?params_hash=${encodeURIComponent(paramsHash)}` : "";
    return this.json(`/api/analysis/${sha256}/meta${qs}`, {}, signal);
  }
  async getAnalysisTensor(sha256: string, paramsHash?: string, signal?: AbortSignal): Promise<AnalysisTensor> {
    const qs = paramsHash ? `?params_hash=${encodeURIComponent(paramsHash)}` : "";
    const res = await this.send(`/api/analysis/${sha256}${qs}`, {}, signal);
    const planes = await res.arrayBuffer();
    const channelIds = JSON.parse(res.headers.get("X-HS-Channels") ?? "[]") as number[];
    const length = Number(res.headers.get("X-HS-Length") ?? 0);
    if (planes.byteLength !== channelIds.length * length * 4) {
      throw new ApiError(res.status, `analysis tensor is ${planes.byteLength} bytes, expected ${channelIds.length * length * 4}`, null);
    }
    return { planes, channelIds, length, paramsHash: res.headers.get("X-HS-Params-Hash") ?? paramsHash ?? "" };
  }
  health(deep = false, signal?: AbortSignal): Promise<Health> { return this.json(`/api/health${deep ? "?deep=1" : ""}`, {}, signal); }
}
