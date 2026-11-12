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

export function calculateAllMapChecksums(): Record<string, string> {
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

/** The checksum of one map's file here, or "" when there is none. */
export function calculateMapChecksum(mapName: string): string {
  try {
    const filePath = getValidMapPath(mapName);
    return fs.existsSync(filePath) ? calculateFileChecksum(filePath) : "";
  } catch {
    return "";
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
