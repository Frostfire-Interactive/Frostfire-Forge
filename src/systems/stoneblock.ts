// A summoning stone is solid (socket/handlers/movement.ts takeStep tests each step against it as a wall). A stone's
// position is its foot: x its middle, y the ground line it stands on; the client draws its art at (x - 32, y - 93). On
// the ground it stands STONE_HALF_WIDTH each side of its middle and STONE_DEPTH deep, STONE_LIFT above its foot (a player's feet
// are 16 px below their y, so one walking up to it stops with their feet on its foot line), so a player is stopped at
// its base from any side, and its summon spot ({ x, y: y + 8 }, in front of it) is clear.
// The client tests its own walk with an exact copy of this (Gateway core/stoneblock.ts); keep the two the same.

import type { SummoningStoneObject } from "./mapobjects";

/** Half the stone's base width, from its middle. */
export const STONE_HALF_WIDTH = 28;
/** How far back from its foot the stone stands on the ground. */
export const STONE_DEPTH = 16;
/** How far above its foot the footprint ends, so a player can walk up to the stone's foot line. */
export const STONE_LIFT = 16;
/** The player's box as the tile check has it (player.ts checkCollisionSync): x ± 12, from y down to y + 20. */
const PLAYER_HALF_WIDTH = 12;
const PLAYER_DEPTH = 20;
/** A longer step is tested at points this far apart, so it cannot pass through a stone in one go. */
const SWEEP_PX = 8;

type Point = { x: number; y: number };
/** Where a stone stands: its middle, and its foot (the ground line it stands on). */
export type StoneAt = { x: number; foot: number };

/** Where a map's stones stand. */
export function stonesAt(stones: readonly Pick<SummoningStoneObject, "position">[]): StoneAt[] {
    return stones.map((s) => ({ x: s.position.x, foot: s.position.y }));
}

function onStone(stone: StoneAt, at: Point): boolean {
    return at.x + PLAYER_HALF_WIDTH > stone.x - STONE_HALF_WIDTH && at.x - PLAYER_HALF_WIDTH < stone.x + STONE_HALF_WIDTH
        && at.y + PLAYER_DEPTH > stone.foot - STONE_LIFT - STONE_DEPTH && at.y < stone.foot - STONE_LIFT;
}

/**
 * Whether a step from `from` to `to` walks onto a stone. A stone the player already stands on (a warp put them there)
 * does not block them, so they can walk off it. With no `from`, any spot on a stone is blocked.
 */
export function stoneBlocksStep(stones: readonly StoneAt[], from: Point | null, to: Point): boolean {
    if (stones.length === 0) return false;
    const n = from ? Math.max(1, Math.ceil(Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) / SWEEP_PX)) : 1;
    for (const stone of stones) {
        if (from && onStone(stone, from)) continue;
        for (let i = 1; i <= n; i++) {
            const at = from ? { x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n } : to;
            if (onStone(stone, at)) return true;
        }
    }
    return false;
}
