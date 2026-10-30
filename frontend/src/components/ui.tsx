import { useId, type ReactNode } from "react";
import type { SourceKind } from "../contracts/ingest";
import { SOURCE_COLORS } from "../lib/constants";

export const cx = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(" ");
export function formatBp(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} Mbp`;
  return `${n.toLocaleString("en-US")} bp`;
}
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso); if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now"; if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`; if (s < 7 * 86_400) return `${Math.round(s / 86_400)} d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

export function SourceBadge({ source }: { source: SourceKind }) {
  const c = SOURCE_COLORS[source];
  return <span className="rounded border px-1.5 py-px font-mono text-[10px] font-semibold leading-4" style={{ color: c, borderColor: `${c}66`, background: `${c}14` }}>{source}</span>;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx("h-4 w-4 animate-spin text-electric", className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div>
      <label className="label" htmlFor={id}>{label}</label>
      {children(id)}
      {hint ? <p className="mt-1 text-xs text-ink-dim">{hint}</p> : null}
      {error ? <p className="mt-1 text-xs text-alert" role="alert">{error}</p> : null}
    </div>
  );
}

type IconProps = { className?: string; open?: boolean };
const svgProps = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
export const PlayIcon = ({ className = "h-4 w-4" }: IconProps) => <svg {...svgProps} className={className}><path d="M7 4.5v15l12-7.5z" fill="currentColor" /></svg>;
export const PauseIcon = ({ className = "h-4 w-4" }: IconProps) => <svg {...svgProps} className={className}><path d="M8 5v14M16 5v14" /></svg>;
export const ScanIcon = ({ className = "h-4 w-4" }: IconProps) => <svg {...svgProps} className={className}><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16" /></svg>;
export const StopIcon = ({ className = "h-4 w-4" }: IconProps) => <svg {...svgProps} className={className}><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" /></svg>;
export const SearchIcon = ({ className = "h-4 w-4" }: IconProps) => <svg {...svgProps} className={className}><circle cx="11" cy="11" r="6" /><path d="m20 20-4-4" /></svg>;
export const TrashIcon = ({ className = "h-4 w-4" }: IconProps) => <svg {...svgProps} className={className}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3" /></svg>;
export const RefreshIcon = ({ className = "h-4 w-4" }: IconProps) => <svg {...svgProps} className={className}><path d="M20 11a8 8 0 0 0-14-4M4 4v4h4M4 13a8 8 0 0 0 14 4M20 20v-4h-4" /></svg>;
export const MenuIcon = ({ className = "h-5 w-5" }: IconProps) => <svg {...svgProps} className={className}><path d="M4 6h16M4 12h16M4 18h16" /></svg>;
export const XIcon = ({ className = "h-4 w-4" }: IconProps) => <svg {...svgProps} className={className}><path d="M6 6l12 12M18 6 6 18" /></svg>;
export const ChevronIcon = ({ className = "h-4 w-4", open = false }: IconProps) => <svg {...svgProps} className={cx(className, "transition-transform", open && "rotate-180")}><path d="m6 9 6 6 6-6" /></svg>;
