import fs from "fs";
import path from "path";
import crypto from "crypto";
const mapDir = path.join('.', 'src', 'assets', 'maps');

function getValidMapPath(mapName: string): string {
  const file = path.basename(mapName.endsWith(".json") ? mapName : `${mapName}.json`);
  const resolved = path.resolve(mapDir, file);
  const resolvedDir = path.resolve(mapDir) + path.sep;

  if (!resolved.startsWith(resolvedDir)) {
    throw new Error(`Path traversal attempt detected: ${file}`);
  }

  return resolved;
}

// Each file's last checksum, by its size and time: the maps are compared with the asset server's at registration
// and after it restarts (modules/assetloader.ts checkMapChanges), and a file not written since is not read and hashed again.
const known = new Map<string, { mtimeMs: number; size: number; checksum: string }>();

export function calculateFileChecksum(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    const hit = known.get(filePath);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.checksum;

    const fileContent = fs.readFileSync(filePath, "utf-8");

    const jsonData = JSON.parse(fileContent);
    const normalizedContent = JSON.stringify(jsonData);
    const checksum = crypto.createHash("sha256").update(normalizedContent).digest("hex");
    known.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, checksum });
    return checksum;
  } catch (error) {
    console.error(`Failed to calculate checksum for ${filePath}:`, error);
    return "";
  }
}

/** Every map file's checksum, worked out on the calling thread (checksums.worker.ts; calculateAllMapChecksums off it). */
export function allMapChecksumsNow(): Record<string, string> {
  const checksums: Record<string, string> = {};

  if (!fs.existsSync(mapDir)) {
    console.warn(`Map directory not found at ${mapDir}`);
    return checksums;
  }

  const mapFiles = fs.readdirSync(mapDir).filter((f) => f.endsWith(".json") && !f.startsWith("."));

  mapFiles.forEach((file) => {
    const filePath = path.join(mapDir, file);
    checksums[file] = calculateFileChecksum(filePath);
  });

  return checksums;
}

/** The checksum of one map's file here, or "" when there is none, worked out on the calling thread. */
export function mapChecksumNow(mapName: string): string {
  try {
    const filePath = getValidMapPath(mapName);
    return fs.existsSync(filePath) ? calculateFileChecksum(filePath) : "";
  } catch {
    return "";
  }
}

// The worker that works the checksums out (checksums.worker.ts), started on first use. It keeps the checksums it has
// worked out, so a file not written since is not read again. It does not keep the process alive.
let worker: Worker | null = null;
let nextId = 0;
const waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

function checksumWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./checksums.worker.ts", import.meta.url));
  (w as Worker & { unref?: () => void }).unref?.();
  w.onmessage = (event: MessageEvent) => {
    const { id, result, error } = event.data as { id: number; result?: unknown; error?: string };
    const call = waiting.get(id);
    if (!call) return;
    waiting.delete(id);
    if (error !== undefined) call.reject(new Error(error));
    else call.resolve(result);
  };
  const fail = (event: any) => {
    if (worker === w) worker = null;
    const error = new Error(`the checksum worker failed: ${event?.message ?? event}`);
    for (const call of waiting.values()) call.reject(error);
    waiting.clear();
    w.terminate();
  };
  w.onerror = fail;
  w.addEventListener("close", () => {
    if (worker === w) worker = null;
    if (waiting.size) fail("it stopped");
  });
  worker = w;
  return w;
}

function inWorker<T>(message: { map?: string }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, { resolve, reject });
    try {
      checksumWorker().postMessage({ id, ...message });
    } catch (error: any) {
      waiting.delete(id);
      reject(error);
    }
  });
}

/**
 * Every map file's checksum, by file name, worked out in a worker: a first pass reads, parses and hashes every map
 * (some 1,800 files), which held the event loop for over a second. Should the worker fail, it is done here instead.
 */
export async function calculateAllMapChecksums(): Promise<Record<string, string>> {
  try {
    return await inWorker<Record<string, string>>({});
  } catch (error) {
    console.error("Map checksums could not be worked out in the worker, so they are here:", error);
    return allMapChecksumsNow();
  }
}

/** The checksum of one map's file here, or "" when there is none (worked out in the worker, as calculateAllMapChecksums). */
export async function calculateMapChecksum(mapName: string): Promise<string> {
  try {
    return await inWorker<string>({ map: mapName });
  } catch {
    return mapChecksumNow(mapName);
  }
}

export function getMapContent(mapName: string): any | null {
  try {
    const filePath = getValidMapPath(mapName);

    if (!fs.existsSync(filePath)) {
      console.warn(`Map file not found: ${filePath}`);
      return null;
    }

    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (error) {
    console.error(`Failed to read map ${mapName}:`, error);
    return null;
  }
}

export function writeMapContent(mapName: string, mapData: any): boolean {
  try {
    const filePath = getValidMapPath(mapName);

    // Write with normalized JSON format to ensure checksums match after writing
    const normalizedContent = JSON.stringify(mapData);
    fs.writeFileSync(filePath, normalizedContent, "utf-8");
    return true;
  } catch (error) {
    console.error(`Failed to write map ${mapName}:`, error);
    return false;
  }
}
