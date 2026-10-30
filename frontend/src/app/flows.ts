import { ApiError, type HelixApi } from "../api/client";
import type { AnomalyRegion, HistoryRecord, IngestItem, Mutation } from "../contracts/history";
import { loadWorkbench, putIngestItems, putMutations, putSequence, putTensors, removeScans, splitPlanes } from "../db/repo";
import type { HelixDB } from "../db/schema";
import { openFromWorkbench, useHelixStore, type HelixState } from "../store/useHelixStore";
import { useUiStore } from "../store/useUiStore";

export interface FlowServices { api: HelixApi; db: HelixDB | null; getModelVersion(): string; }

export async function openHistoryItem(svc: FlowServices, rec: HistoryRecord): Promise<void> {
  const { db, api } = svc;
  if (db) {
    const w = await loadWorkbench(db, rec.sha256, { scanId: rec.scan_id });
    if (w) { openFromWorkbench(w, rec.scan_id, rec.last_scanned_pos); return; }
  }
  const { codes } = await api.getSequenceCodes(rec.sha256);
  let planes: (Float32Array | null)[] | undefined;
  let regions: AnomalyRegion[] = [];
  try {
    const t = await api.getAnalysisTensor(rec.sha256);
    const meta = await api.getAnalysisMeta(rec.sha256, t.paramsHash);
    planes = splitPlanes(t.planes, t.channelIds, t.length);
    regions = meta.regions;
    if (db) {
      await putTensors(db, {
        sha256: rec.sha256, modelVersion: meta.model_version, paramsHash: t.paramsHash, channelIds: t.channelIds, length: t.length,
        planes: t.planes, anomalyRegions: regions,
      });
    }
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 404) throw e;
  }
  let mutations: Mutation[] = [];
  try { mutations = await api.listMutations(rec.scan_id); } catch {}
  if (db) {
    await putSequence(db, { sha256: rec.sha256, molecule: rec.molecule, display: rec.display_name, codes });
    await putMutations(db, mutations);
  }
  useHelixStore.getState().openSequence({
    sha256: rec.sha256, scanId: rec.scan_id, codes, molecule: rec.molecule, display: rec.display_name,
    ...(planes ? { planes, regions } : {}), mutations, headPos: rec.last_scanned_pos,
  });
}

export async function openIngestItem(svc: FlowServices, item: IngestItem): Promise<void> {
  if (svc.db) await putIngestItems(svc.db, [item]);
  useUiStore.getState().bumpHistory();
  await openHistoryItem(svc, item.record);
}

export async function deleteHistoryItem(svc: FlowServices, rec: HistoryRecord): Promise<void> {
  await svc.api.deleteHistory(rec.scan_id);
  if (svc.db) await removeScans(svc.db, [rec.scan_id]);
  if (useHelixStore.getState().active?.scanId === rec.scan_id) useHelixStore.getState().closeSequence();
  useUiStore.getState().bumpHistory();
}

export async function persistCompletedScan(svc: FlowServices, s: Pick<HelixState, "active" | "paramsHash" | "channelIds" | "planes" | "regions">): Promise<void> {
  const { db } = svc;
  if (!db || !s.active || !s.paramsHash || s.channelIds.length === 0) return;
  await putSequence(db, { sha256: s.active.sha256, molecule: s.active.molecule, display: s.active.display, codes: s.active.codes });
  await putTensors(db, {
    sha256: s.active.sha256, modelVersion: svc.getModelVersion(), paramsHash: s.paramsHash, channelIds: s.channelIds, length: s.active.length,
    planes: s.planes, anomalyRegions: s.regions,
  });
  useUiStore.getState().bumpHistory();
}
