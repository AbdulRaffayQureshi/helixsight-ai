import { create } from "zustand";
export type SidebarTab = "history" | "ingest";
export type IngestLane = "ncbi" | "pdb" | "paste" | "file";
export type ToastKind = "info" | "success" | "warning" | "error";
export interface Toast { id: number; kind: ToastKind; message: string; }
export interface UiState {
  sidebarTab: SidebarTab; ingestLane: IngestLane; pasteDraft: string; pendingFiles: File[];
  sidebarOpen: boolean; historyVersion: number; toasts: Toast[];
  setSidebarTab(t: SidebarTab): void; setIngestLane(l: IngestLane): void; setPasteDraft(t: string): void;
  setPendingFiles(f: File[]): void; setSidebarOpen(o: boolean): void; bumpHistory(): void;
  toast(kind: ToastKind, message: string): number; dismissToast(id: number): void;
}

let nextToastId = 1;
export const useUiStore = create<UiState>()((set) => ({
  sidebarTab: "history", ingestLane: "ncbi", pasteDraft: "", pendingFiles: [], sidebarOpen: false, historyVersion: 0, toasts: [],
  setSidebarTab: (sidebarTab) => set({ sidebarTab }),
  setIngestLane: (ingestLane) => set({ ingestLane }),
  setPasteDraft: (pasteDraft) => set({ pasteDraft }),
  setPendingFiles: (pendingFiles) => set({ pendingFiles }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  bumpHistory: () => set((s) => ({ historyVersion: s.historyVersion + 1 })),
  toast(kind, message) {
    const id = nextToastId++;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, message }] }));
    return id;
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
export function resetUiStore(): void {
  useUiStore.setState({ sidebarTab: "history", ingestLane: "ncbi", pasteDraft: "", pendingFiles: [], sidebarOpen: false, historyVersion: 0, toasts: [] });
}
