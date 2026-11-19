// Works out the maps' checksums off the main thread (modules/checksums.ts): a first pass reads, parses and hashes
// every map file (some 1,800 on Mystika, about 90 MB), which held the event loop for over a second. The checksums
// held here by file size and time (checksums.ts calculateFileChecksum) stay for this worker's life.
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
