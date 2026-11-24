import { expect, test } from "bun:test";
import { arrivalChunks, teleportsNear } from "../systems/portalpreload";

// Nearing a teleport portal, the map round where it leads is sent ahead (PRELOAD_MAP_CHUNKS), as a warp's is: on the
// far side the ground is there at once. Dungeon portals are not.

const portal = (over: any) => ({
  name: "P", kind: "teleport", dungeonId: null, mirror: true, target: { map: "cave", x: 640, y: 320 },
  position: { x: 1000, y: 1000 }, size: { width: 64, height: 96 }, layer: null, ...over,
});

test("a teleport portal within 100 pixels of its edge is near; further off it is not", () => {
  const p = portal({});
  expect(teleportsNear([p as any], "town", { x: 1032, y: 1150 }).map((s) => s.map)).toEqual(["cave"]);
  expect(teleportsNear([p as any], "town", { x: 1032, y: 1200 })).toEqual([]);
});

test("a dungeon portal, or a teleport leading nowhere, is not preloaded", () => {
  const dungeon = portal({ kind: "dungeon", dungeonId: 3, target: null });
  const nowhere = portal({ target: null });
  expect(teleportsNear([dungeon, nowhere] as any, "town", { x: 1032, y: 1050 })).toEqual([]);
});

test("the chunks round the arrival point, inside the map", () => {
  // 32px tiles: chunks of 32 tiles (1024px); a 100 x 100 tile map has 4 x 4 chunks
  const chunks = arrivalChunks({ width: 100, height: 100, tilewidth: 32 }, 640, 320);
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks).toContainEqual({ x: 0, y: 0 });
  expect(chunks.every((c) => c.x >= 0 && c.y >= 0 && c.x < 4 && c.y < 4)).toBe(true);
});
