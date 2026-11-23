import lootChest from "./lootChest";
import type { MapChestObject } from "./dungeons/types";

const MINUTE_MS = 60_000;

/** Spawns a map's placed chests; `here` gates each by position (cluster ownership). Copies pass resets: false. */
export function spawnPlacedChests(map: string, chests: MapChestObject[], opts: { resets: boolean; here?: (x: number, y: number) => boolean }): string[] {
  const now = Date.now();
  const ids: string[] = [];
  for (const c of chests) {
    if (opts.here && !opts.here(c.position.x, c.position.y)) continue;
    const resetMs = opts.resets ? c.resetMinutes * MINUTE_MS : null;
    ids.push(lootChest.spawn(map, c.position.x, c.position.y, c.lootTableId, undefined, "map", {
      name: c.name, resetMs, resetAt: resetMs === null ? null : now + resetMs,
    }));
  }
  return ids;
}

export function despawnPlacedChests(map: string): string[] {
  const gone: string[] = [];
  for (const c of [...lootChest.all()]) {
    if (c.map === map && c.placed !== null && lootChest.despawn(c.id)) gone.push(c.id);
  }
  return gone;
}

export function dueResets(now: number): string[] {
  const due: string[] = [];
  for (const c of lootChest.all()) {
    if (c.placed === null || c.resetAt === null || !(c.resetMs > 0) || c.resetAt > now) continue;
    lootChest.reset(c.id);
    while (c.resetAt <= now) c.resetAt += c.resetMs;
    due.push(c.id);
  }
  return due;
}

const unchanged = (c: any, want: MapChestObject, resetMs: number | null) =>
  c.lootTableId === want.lootTableId && c.x === want.position.x && c.y === want.position.y && c.resetMs === resetMs;

/** Brings a map's placed chests to the given list by name: unchanged ones stay as they are, changed and removed ones go, new and changed ones spawn. */
export function syncPlacedChests(map: string, chests: MapChestObject[], opts: { resets: boolean; here?: (x: number, y: number) => boolean }): { removed: string[]; added: string[] } {
  const existing = [...lootChest.all()].filter((c) => c.map === map && c.placed !== null);
  const removed: string[] = [];
  const toSpawn: MapChestObject[] = [];
  const left = new Set(existing);
  for (const want of chests) {
    const resetMs = opts.resets ? want.resetMinutes * MINUTE_MS : null;
    const kept = [...left].find((c) => c.placed === want.name && unchanged(c, want, resetMs));
    // A chest this node no longer owns goes even when unchanged; the spawn below leaves it to its owner
    if (kept && (!opts.here || opts.here(want.position.x, want.position.y))) { left.delete(kept); continue; }
    toSpawn.push(want);
  }
  for (const c of left) if (lootChest.despawn(c.id)) removed.push(c.id);
  return { removed, added: spawnPlacedChests(map, toSpawn, opts) };
}
