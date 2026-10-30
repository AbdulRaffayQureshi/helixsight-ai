import { useEffect } from "react";
import { useUiStore, type Toast } from "../store/useUiStore";
import { cx, XIcon } from "./ui";

const TONE: Record<Toast["kind"], string> = {
  info: "border-electric/60 text-electric-bright", success: "border-ok/60 text-ok", warning: "border-warn/60 text-warn", error: "border-alert/70 text-alert",
};

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useUiStore((s) => s.dismissToast);
  useEffect(() => {
    const t = setTimeout(() => dismiss(toast.id), toast.kind === "error" ? 9000 : 5000);
    return () => clearTimeout(t);
  }, [toast.id, toast.kind, dismiss]);
  return (
    <div role={toast.kind === "error" ? "alert" : "status"} className={cx("panel pointer-events-auto flex max-w-sm animate-rise items-start gap-2 border px-3 py-2 text-sm", TONE[toast.kind])}>
      <span className="min-w-0 flex-1 break-words text-ink">{toast.message}</span>
      <button type="button" className="btn btn-ghost -mr-1 -mt-0.5 px-1 py-1" aria-label="Dismiss notification" onClick={() => dismiss(toast.id)}>
        <XIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function Toasts() {
  const toasts = useUiStore((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2" aria-live="polite">
      {toasts.map((t) => <ToastItem key={t.id} toast={t} />)}
    </div>
  );
}
