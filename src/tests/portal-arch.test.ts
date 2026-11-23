import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARCH_DEPTH, ARCH_HALF_WIDTH, BACK_DEPTH, OPENING_HALF_WIDTH, archBlocksStep, archPieces, archesOf } from "../systems/portalarch";
import { portalCentre } from "../systems/dungeons/glue";
import { arrivalSpot, returnPlacement } from "../systems/portalpairs";
import type { DungeonPortalObject } from "../systems/dungeons/types";

// The arch a portal stands in is solid (systems/portalarch.ts). A player's box: x ± 12, from y down to y + 20.
// The same cases are run on the client's copy (Gateway src/modules/portalarch.test.ts).
const portal: DungeonPortalObject = { name: "p", kind: "dungeon", dungeonId: 1, mirror: true, target: null, position: { x: 100, y: 100 }, size: { width: 32, height: 32 }, layer: null };
// centred on x 116, its foot on y 132
const arches = archesOf([portal]);

describe("archPieces", () => {
    test("the footprint is the arch's full width at its foot: two pillars and the back of the opening", () => {
        expect([ARCH_HALF_WIDTH, OPENING_HALF_WIDTH, ARCH_DEPTH, BACK_DEPTH]).toEqual([47, 21, 20, 4]);
        expect(arches).toEqual([{ x: 116, foot: 132 }]);
        expect(archPieces(arches[0]!)).toEqual([
            { left: 69, right: 95, top: 112, bottom: 132 },
            { left: 137, right: 163, top: 112, bottom: 132 },
            { left: 95, right: 137, top: 112, bottom: 116 },
        ]);
    });

    test("an arch is centred as the client draws it (rounded), with its foot on the rectangle's bottom edge", () => {
        expect(archesOf([{ ...portal, size: { width: 33, height: 48 } }])).toEqual([{ x: 117, foot: 148 }]);
        expect(archesOf([])).toEqual([]);
    });
});

describe("archBlocksStep", () => {
    test("walking up into the opening from the front is not blocked, as far as the back of the opening", () => {
        for (const [from, to] of [[138, 132], [132, 126], [126, 120], [120, 116]] as const) {
            expect(archBlocksStep(arches, { x: 116, y: from }, { x: 116, y: to })).toBe(false);
        }
        expect(archBlocksStep(arches, { x: 116, y: 116 }, { x: 116, y: 110 })).toBe(true);
        expect(archBlocksStep(arches, { x: 122, y: 134 }, { x: 116, y: 128 })).toBe(false);
    });

    test("from above, a player stops at the back of the arch, outside the portal's rectangle", () => {
        expect(archBlocksStep(arches, { x: 116, y: 86 }, { x: 116, y: 92 })).toBe(false);
        expect(archBlocksStep(arches, { x: 116, y: 92 }, { x: 116, y: 98 })).toBe(true);
        expect(archBlocksStep(arches, { x: 80, y: 86 }, { x: 80, y: 92 })).toBe(false);
        expect(archBlocksStep(arches, { x: 80, y: 92 }, { x: 80, y: 98 })).toBe(true);
    });

    test("from the sides, a player stops at the pillars; across the front they walk on", () => {
        expect(archBlocksStep(arches, { x: 52, y: 120 }, { x: 58, y: 120 })).toBe(true);
        expect(archBlocksStep(arches, { x: 51, y: 120 }, { x: 57, y: 120 })).toBe(false);
        expect(archBlocksStep(arches, { x: 181, y: 120 }, { x: 175, y: 120 })).toBe(false);
        expect(archBlocksStep(arches, { x: 181, y: 120 }, { x: 174, y: 120 })).toBe(true);
        for (let x = 40; x < 200; x += 6) expect(archBlocksStep(arches, { x, y: 132 }, { x: x + 6, y: 132 })).toBe(false);
    });

    test("off the opening's middle, walking up runs into a pillar", () => {
        expect(archBlocksStep(arches, { x: 130, y: 138 }, { x: 130, y: 132 })).toBe(false);
        expect(archBlocksStep(arches, { x: 130, y: 132 }, { x: 130, y: 126 })).toBe(true);
        expect(archBlocksStep(arches, { x: 125, y: 132 }, { x: 125, y: 126 })).toBe(false);
        expect(archBlocksStep(arches, { x: 102, y: 132 }, { x: 102, y: 126 })).toBe(true);
    });

    test("inside the opening a player cannot walk out through a pillar", () => {
        // the opening leaves 9 px each way of its middle (x 107 to 125)
        expect(archBlocksStep(arches, { x: 116, y: 120 }, { x: 107, y: 120 })).toBe(false);
        expect(archBlocksStep(arches, { x: 110, y: 120 }, { x: 104, y: 120 })).toBe(true);
        expect(archBlocksStep(arches, { x: 122, y: 120 }, { x: 128, y: 120 })).toBe(true);
        expect(archBlocksStep(arches, { x: 116, y: 120 }, { x: 116, y: 126 })).toBe(false);
    });

    test("a step longer than the back is deep cannot pass through it", () => {
        expect(archBlocksStep(arches, { x: 116, y: 88 }, { x: 116, y: 118 })).toBe(true);
        expect(archBlocksStep(arches, { x: 116, y: 146 }, { x: 116, y: 116 })).toBe(false);
    });

    test("a player already on the arch (put there) can walk off it, but not onto another part", () => {
        expect(archBlocksStep(arches, { x: 80, y: 120 }, { x: 74, y: 120 })).toBe(false);
        expect(archBlocksStep(arches, { x: 80, y: 120 }, { x: 86, y: 120 })).toBe(false);
        expect(archBlocksStep(arches, { x: 80, y: 120 }, { x: 80, y: 126 })).toBe(false);
        expect(archBlocksStep(arches, { x: 116, y: 105 }, { x: 116, y: 99 })).toBe(false);
        expect(archBlocksStep(arches, { x: 116, y: 105 }, { x: 116, y: 111 })).toBe(false);
        expect(archBlocksStep(arches, { x: 96, y: 105 }, { x: 102, y: 111 })).toBe(false);
        expect(archBlocksStep(arches, { x: 140, y: 113 }, { x: 140, y: 107 })).toBe(false);
        expect(archBlocksStep(arches, { x: 92, y: 120 }, { x: 116, y: 105 })).toBe(true);
    });

    test("with no step known, a spot on the arch is blocked", () => {
        expect(archBlocksStep(arches, null, { x: 116, y: 110 })).toBe(true);
        expect(archBlocksStep(arches, null, { x: 116, y: 120 })).toBe(false);
        expect(archBlocksStep([], null, { x: 116, y: 110 })).toBe(false);
    });

    test("arriving through a portal never puts a player on an arch", () => {
        const back = arrivalSpot("town", portal);
        expect(archBlocksStep(arches, null, back)).toBe(false);
        // a dungeon's exit stands where the entrance is its arrival spot
        const entrance = { x: 300, y: 300 };
        const placed = returnPlacement(entrance, portal.size);
        if ("error" in placed) throw new Error(placed.error);
        expect(archBlocksStep(archesOf([{ ...portal, position: placed.position }]), null, entrance)).toBe(false);
        // coming back out of a dungeon: the centre of the portal entered, in its opening
        expect(archBlocksStep(arches, null, portalCentre("town", portal))).toBe(false);
    });
});

describe("the movement handler", () => {
    const movement = readFileSync(join(import.meta.dir, "..", "socket", "handlers", "movement.ts"), "utf8").replaceAll("\r", "");
    test("tests each step against the arches of the map's portals, as a wall", () => {
        const start = movement.indexOf("function takeStep(");
        const fn = movement.slice(start, movement.indexOf("\n}\n", start));
        expect(fn).toContain("const archesHere = archesOf(portalsOn(bareMap) ?? []);");
        expect(fn).toContain("archBlocksStep(archesHere, { x: startX, y: startY }, to)");
    });
});
