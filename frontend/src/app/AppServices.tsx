import { createContext, useContext } from "react";
import type { HelixApi } from "../api/client";
import type { HelixDB } from "../db/schema";

export interface AppServices {
  api: HelixApi;
  db: HelixDB | null;
  syncer: { sync(): Promise<unknown> } | null;
  getModelVersion(): string;
}

export const ServicesContext = createContext<AppServices | null>(null);
export function useServices(): AppServices {
  const v = useContext(ServicesContext);
  if (!v) throw new Error("useServices() outside <ServicesContext.Provider>");
  return v;
}
