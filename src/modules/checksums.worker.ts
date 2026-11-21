import { allMapChecksumsNow, mapChecksumNow } from "./checksums.ts";

declare const self: Worker;

self.onmessage = (event: MessageEvent) => {
  const { id, map } = event.data as { id: number; map?: string };
  try {
    const result = typeof map === "string" ? mapChecksumNow(map) : allMapChecksumsNow();
    self.postMessage({ id, result });
  } catch (error: any) {
    self.postMessage({ id, error: String(error?.message ?? error) });
  }
};
