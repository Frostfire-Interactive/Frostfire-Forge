import type { GatherGrid, Point, Rng } from "./types";

/** Tries for one spot before the slot waits and tries again later. */
export const PLACEMENT_TRIES = 24;
/** px of space kept between the pictures of two nodes. */
export const NODE_GAP = 4;

export interface Spot extends Point {
  /** "tx,ty" */
  tile: string;
}

export function apart(a: { x: number; y: number; size: number }, b: { x: number; y: number; size: number }): boolean {
  const need = (a.size + b.size) / 2 + NODE_GAP;
  return Math.abs(a.x - b.x) >= need || Math.abs(a.y - b.y) >= need;
}

export function pickSpot(
  grid: GatherGrid,
  area: { x: number; y: number; radius: number },
  taken: ReadonlySet<string>,
  r: Rng,
  clear?: (x: number, y: number) => boolean,
  tries = PLACEMENT_TRIES,
): Spot | null {
  const r2 = area.radius * area.radius;
  for (let i = 0; i < tries; i++) {
    const angle = r() * Math.PI * 2;
    const dist = Math.sqrt(r()) * area.radius;
    const { tx, ty } = grid.tileOf({ x: area.x + Math.cos(angle) * dist, y: area.y + Math.sin(angle) * dist });
    const tile = `${tx},${ty}`;
    if (taken.has(tile)) continue;
    const at = grid.anchorOfTile(tx, ty);
    const dx = at.x - area.x;
    const dy = at.y - area.y;
    if (dx * dx + dy * dy > r2) continue;
    if (!grid.isWalkable(at.x, at.y)) continue;
    const x = Math.round(at.x);
    const y = Math.round(at.y);
    if (clear && !clear(x, y)) continue;
    return { x, y, tile };
  }
  return null;
}

export function previewSpots(grid: GatherGrid, area: { x: number; y: number; radius: number; size?: number }, count: number, r: Rng): Spot[] {
  const taken = new Set<string>();
  const spots: Spot[] = [];
  const size = area.size ?? 0;
  const clear = (x: number, y: number) => spots.every((s) => apart({ ...s, size }, { x, y, size }));
  for (let i = 0; i < count; i++) {
    const spot = pickSpot(grid, area, taken, r, clear);
    if (!spot) continue;
    taken.add(spot.tile);
    spots.push(spot);
  }
  return spots;
}
