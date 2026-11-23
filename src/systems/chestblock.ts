// Chests are solid: a step that would put the player on a chest's base is blocked (socket/handlers/movement.ts takeStep).

/** A chest's base, from its foot (x, y): 32 px wide and 16 px deep, the bottom of its 44 px icon. */
const BASE_HALF_WIDTH = 16;
const BASE_DEPTH = 16;
/** The player's box as the tile check has it (player.ts checkCollisionSync): x ± 12, from y down to y + 20. */
const PLAYER_HALF_WIDTH = 12;
const PLAYER_DEPTH = 20;

type Point = { x: number; y: number };

function onBase(chest: Point, at: Point): boolean {
    return at.x + PLAYER_HALF_WIDTH > chest.x - BASE_HALF_WIDTH && at.x - PLAYER_HALF_WIDTH < chest.x + BASE_HALF_WIDTH
        && at.y + PLAYER_DEPTH > chest.y - BASE_DEPTH && at.y < chest.y;
}

/** Whether a step from `from` to `to` walks onto a chest. A player already on one (it dropped on them) can walk off. */
export function chestBlocksStep(chests: readonly Point[], from: Point, to: Point): boolean {
    return chests.some((chest) => onBase(chest, to) && !onBase(chest, from));
}
