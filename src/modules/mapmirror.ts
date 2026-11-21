import fs from "fs";
import path from "path";

export function removeUnlistedMaps(mapDir: string, listed: Iterable<string>): string[] {
  const keep = new Set(listed);
  if (keep.size === 0 || !fs.existsSync(mapDir)) return [];

  const removed: string[] = [];
  for (const entry of fs.readdirSync(mapDir, { withFileTypes: true })) {
    // Dot files are the folder's own (.map-checksums-cache.json), not maps.
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.startsWith(".")) continue;
    if (keep.has(entry.name)) continue;
    fs.rmSync(path.join(mapDir, entry.name), { force: true });
    removed.push(entry.name);
  }
  return removed;
}

export function removeUnlistedWorlds(mapDir: string, listedIds: Iterable<string>): string[] {
  if (!fs.existsSync(mapDir)) return [];
  const keep = new Set(listedIds);

  const removed: string[] = [];
  for (const entry of fs.readdirSync(mapDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".world")) continue;
    const id = entry.name.slice(0, -".world".length);
    if (!id || keep.has(id)) continue;
    fs.rmSync(path.join(mapDir, entry.name), { recursive: true, force: true });
    removed.push(id);
  }
  return removed;
}
