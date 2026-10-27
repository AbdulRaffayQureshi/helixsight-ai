import type { HistorySyncResponse } from "../contracts/history";
import { clearHistoryState, getMeta, openTx, removeScansInTx } from "./repo";
import type { HelixDB } from "./schema";

export type FetchSync = (sinceRev: number, signal?: AbortSignal) => Promise<HistorySyncResponse>;

export class SyncHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SyncHttpError";
    this.status = status;
  }
}

export function httpFetchSync(baseUrl = ""): FetchSync {
  return async (sinceRev, signal) => {
    const res = await fetch(`${baseUrl}/api/history/sync?since_rev=${sinceRev}`, { signal });
    if (!res.ok) throw new SyncHttpError(res.status, `history sync failed: HTTP ${res.status}`);
    return (await res.json()) as HistorySyncResponse;
  };
}

export interface SyncResult {
  upserts: number;
  deleted: number;
  latestRev: number;
  reset: boolean;
}

async function apply(db: HelixDB, resp: HistorySyncResponse): Promise<{ upserts: number; deleted: number }> {
  const tx = openTx(db);
  const work = (async () => {
    for (const rec of resp.upserts) await tx.objectStore("history").put(rec);
    const deleted = await removeScansInTx(tx, resp.deleted);
    await tx.objectStore("meta").put({ key: "last_rev", value: resp.latest_rev });
    return deleted;
  })();
  const [deleted] = await Promise.all([work, tx.done]);
  return { upserts: resp.upserts.length, deleted };
}

export function createSyncer(db: HelixDB, fetchSync: FetchSync): { sync: (signal?: AbortSignal) => Promise<SyncResult> } {
  let inflight: Promise<SyncResult> | null = null;

  async function run(signal?: AbortSignal): Promise<SyncResult> {
    const since = (await getMeta(db, "last_rev")) ?? 0;
    let resp = await fetchSync(since, signal);
    let reset = false;
    if (resp.latest_rev < since) {
      reset = true;
      const tx = openTx(db);
      await Promise.all([clearHistoryState(tx), tx.done]);
      resp = await fetchSync(0, signal);
    }
    const { upserts, deleted } = await apply(db, resp);
    return { upserts, deleted, latestRev: resp.latest_rev, reset };
  }

  return {
    sync(signal?: AbortSignal): Promise<SyncResult> {
      if (!inflight) {
        inflight = run(signal).finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },
  };
}
