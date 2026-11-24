import { teleportDestination } from "./dungeons/peek";
import type { DungeonPortalObject, PortalSpot } from "./dungeons/types";

/** How near (pixels, from the portal's edge) a player comes before where a teleport portal leads is sent ahead. */
export const PORTAL_PRELOAD_DISTANCE = 100;

/** Where the teleport portals near `at` lead (dungeon portals, and teleports leading nowhere, left out). */
export function teleportsNear(portals: DungeonPortalObject[] | null, map: string, at: { x: number; y: number }): PortalSpot[] {
  const out: PortalSpot[] = [];
  for (const p of portals ?? []) {
    if (p.kind !== "teleport" || !p.target) continue;
    const dx = Math.max(p.position.x - at.x, 0, at.x - (p.position.x + p.size.width));
    const dy = Math.max(p.position.y - at.y, 0, at.y - (p.position.y + p.size.height));
    if (dx * dx + dy * dy < PORTAL_PRELOAD_DISTANCE * PORTAL_PRELOAD_DISTANCE) out.push(teleportDestination(map, p.target));
  }
  return out;
}

const CHUNK_SIZE_CONFIG: { [key: number]: number } = { 16: 64, 32: 32, 64: 16 };

/** Chunk size (tiles) for a map's tile width, as the client splits it. */
export const chunkSizeFor = (tilewidth: number): number => CHUNK_SIZE_CONFIG[tilewidth] || 32;

/** The chunks a 1920 x 1080 view (and a chunk round it) needs round the arrival point (pixels), inside the map. */
export function arrivalChunks(data: { width?: number; height?: number; tilewidth?: number }, x: number, y: number): Array<{ x: number; y: number }> {
  const tilewidth = data.tilewidth || 32;
  const size = chunkSizeFor(tilewidth);
  const chunkPx = size * tilewidth;
  const chunksX = Math.ceil((data.width || 0) / size);
  const chunksY = Math.ceil((data.height || 0) / size);
  const cx = Math.max(0, Math.min(Math.floor(x / chunkPx), Math.max(0, chunksX - 1)));
  const cy = Math.max(0, Math.min(Math.floor(y / chunkPx), Math.max(0, chunksY - 1)));
  const needX = Math.ceil((1920 + chunkPx * 2) / chunkPx / 2);
  const needY = Math.ceil((1080 + chunkPx * 2) / chunkPx / 2);
  const out: Array<{ x: number; y: number }> = [];
  for (let dy = -needY; dy <= needY; dy++) {
    for (let dx = -needX; dx <= needX; dx++) {
      const X = cx + dx, Y = cy + dy;
      if (X >= 0 && Y >= 0 && X < chunksX && Y < chunksY) out.push({ x: X, y: Y });
    }
  }
  return out;
}
