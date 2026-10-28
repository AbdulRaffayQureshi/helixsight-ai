/// <reference lib="webworker" />
import { createFcgrSession, handleFcgrMessage, type FcgrRequest } from "./fcgr";
const scope = self as unknown as DedicatedWorkerGlobalScope;
const session = createFcgrSession();
scope.onmessage = (e: MessageEvent<FcgrRequest>) => {
  const { response, transfer } = handleFcgrMessage(session, e.data);
  scope.postMessage(response, transfer);
};
export {};
