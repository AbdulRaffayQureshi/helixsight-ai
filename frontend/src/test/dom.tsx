import "fake-indexeddb/auto";
import * as React from "react";
(globalThis as any).React = React;

import { webcrypto } from "node:crypto";
import { TextEncoder as NodeTextEncoder } from "node:util";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export function installDomStubs(): void {
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("TextEncoder", NodeTextEncoder);
  Element.prototype.scrollIntoView = () => undefined;
}

export interface Mounted { host: HTMLElement; root: Root; unmount(): void; }
export async function mount(ui: ReactElement): Promise<Mounted> {
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host); await act(async () => { root.render(ui); });
  return { host, root, unmount() { act(() => root.unmount()); host.remove(); } };
}

export async function flush(ms = 0): Promise<void> { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); }
export async function waitFor(check: () => boolean | void, timeout = 3000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    let ok = false;
    try { ok = check() !== false; } catch { ok = false; }
    if (ok) return;
    if (Date.now() - t0 > timeout) throw new Error("waitFor timed out");
    await flush(15);
  }
}

export async function click(el: Element | null, init: MouseEventInit = {}): Promise<void> {
  if (!el) throw new Error("click: element not found");
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init })); });
}
export async function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null, value: string): Promise<void> {
  if (!el) throw new Error("setValue: element not found");
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
}
export async function setChecked(el: HTMLInputElement | null, checked: boolean): Promise<void> {
  if (!el) throw new Error("setChecked: element not found");
  if (el.checked !== checked) await click(el);
}

export const q = <T extends Element = HTMLElement>(host: ParentNode, sel: string): T | null => host.querySelector<T>(sel);
export const qa = <T extends Element = HTMLElement>(host: ParentNode, sel: string): T[] => Array.from(host.querySelectorAll<T>(sel));
export const byText = (host: ParentNode, sel: string, text: string | RegExp): HTMLElement | null => qa(host, sel).find((e) => (typeof text === "string" ? e.textContent?.includes(text) : text.test(e.textContent ?? ""))) ?? null;
