import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (file: string) => readFileSync(join(import.meta.dir, "..", "socket", file), "utf8");
const body = (text: string, start: string) => {
    const at = text.indexOf(start);
    expect(at).toBeGreaterThan(-1);
    return text.slice(at, text.indexOf("\n}\n", at));
};

test("a teleport portal to a place on this map that another node owns goes through transitionPlayerToMap, which hands the player off", () => {
    const teleport = body(source("dungeons.ts"), "async function teleportPlayer(");
    expect(teleport).toMatch(/\|\|\s*ownedByAnotherNode\(spot\.map, spot\.x, spot\.y\)\)\s*\{\s*await transitionPlayerToMap\(/);
});

test("ownedByAnotherNode asks the cluster who owns the place, as a warp does", () => {
    const owned = body(source("receiver.ts"), "export function ownedByAnotherNode(");
    expect(owned).toContain("warpTarget(handoffCtx, map, x, y) !== null");
});
