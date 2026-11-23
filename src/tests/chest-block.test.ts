import { describe, expect, test } from "bun:test";
import { chestBlocksStep } from "../systems/chestblock";

// A player's box: x ± 12, from y down to y + 20 (player.ts checkCollisionSync). A chest's foot is (x, y).
const chest = { x: 100, y: 100 };

describe("chestBlocksStep", () => {
    test("a step onto a chest's base is blocked", () => {
        expect(chestBlocksStep([chest], { x: 100, y: 120 }, { x: 100, y: 95 })).toBe(true);
        expect(chestBlocksStep([chest], { x: 60, y: 90 }, { x: 80, y: 90 })).toBe(true);
    });

    test("a step clear of the base, or behind its lid, is not", () => {
        expect(chestBlocksStep([chest], { x: 100, y: 140 }, { x: 100, y: 130 })).toBe(false);
        expect(chestBlocksStep([chest], { x: 100, y: 40 }, { x: 100, y: 50 })).toBe(false);
        expect(chestBlocksStep([chest], { x: 40, y: 90 }, { x: 50, y: 90 })).toBe(false);
        expect(chestBlocksStep([], { x: 100, y: 120 }, { x: 100, y: 95 })).toBe(false);
    });

    test("a player already on a chest can walk off it", () => {
        expect(chestBlocksStep([chest], { x: 100, y: 95 }, { x: 100, y: 110 })).toBe(false);
    });
});
