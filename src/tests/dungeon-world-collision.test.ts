import { afterAll, expect, mock, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { databaseModule } from "./setup";

mock.module("../config/settings.json", () => ({
  default: { creatures: {} },
  creatures: {},
}));

mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));

const { default: player, clearMapCache } = await import("../systems/player");
const { getWorldMap, loadWorldMaps } = await import("../modules/worldmaps");

/** A 64 x 64 world of 16 px tiles named `id`, with the tiles `blocked` solid. */
function writeWorld(dir: string, id: string, blocked: [number, number][]): void {
  const bits = (role: number, tiles: [number, number][]) => {
    const bytes = new Uint8Array(32 + 512);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x42574646, true);
    view.setUint16(4, 1, true);
    view.setUint16(6, 32, true);
    view.setUint16(8, 64, true);
    view.setUint16(10, 1, true);
    view.setUint16(12, 1, true);
    view.setUint16(14, role, true);
    for (const [x, y] of tiles) bytes[32 + ((y * 64 + x) >> 3)]! |= 1 << ((y * 64 + x) & 7);
    const hash = BigInt.asUintN(64, BigInt(Bun.hash.xxHash64(bytes.subarray(32))));
    view.setBigUint64(16, hash, true);
    return { bytes, hash: hash.toString(16).padStart(16, "0") };
  };
  const collision = bits(1, blocked), nopvp = bits(2, []);
  const world = path.join(dir, `${id}.world`);
  fs.mkdirSync(world, { recursive: true });
  fs.writeFileSync(path.join(world, "collision.bits"), collision.bytes);
  fs.writeFileSync(path.join(world, "nopvp.bits"), nopvp.bytes);
  fs.writeFileSync(path.join(world, "manifest.json"), JSON.stringify({
    format: "ffworld", formatVersion: 1, id, width: 64, height: 64, tilewidth: 16, tileheight: 16, chunkSize: 64,
    layers: [{ id: 1, name: "Ground", type: "tilelayer", tileIndex: 0, role: "tiles", visible: true }],
    tilesets: [],
    bitsets: { collision: { file: "collision.bits", hash: collision.hash }, nopvp: { file: "nopvp.bits", hash: nopvp.hash } },
    objects: [],
  }));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dungeon-world-"));
writeWorld(root, "cryptworld", [[2, 2]]);
loadWorldMaps(root, new Set());
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const size = { width: 16, height: 16 } as any;

test("a dungeon copy of a world is that world: its collision, no-pvp zones and properties", () => {
  const world = getWorldMap("cryptworld");
  expect(world).toBeDefined();
  expect(getWorldMap("cryptworld~a")).toBe(world);
  expect(getWorldMap("cryptworld~b.json")).toBe(world);
  expect(getWorldMap("otherworld~a")).toBeUndefined();
});

test("a player in a copy of a world walks into its solid tiles, and nowhere else", () => {
  clearMapCache("cryptworld~a");
  expect((player.checkCollisionSync("cryptworld~a", { x: 2 * 16 + 8, y: 2 * 16 } as any, size) as any).reason).toBe("tile_collision");
  expect((player.checkCollisionSync("cryptworld~a", { x: 10 * 16 + 8, y: 10 * 16 } as any, size) as any).reason).toBe("no_collision");
});

test("the copy's collision is read before any fetch of run lengths, which a world copy has none of", async () => {
  clearMapCache("cryptworld~b");
  await player.preloadMapCollision("cryptworld~b");
  expect((player.checkCollisionSync("cryptworld~b", { x: 2 * 16 + 8, y: 2 * 16 } as any, size) as any).reason).toBe("tile_collision");
});

test("the creatures of a copy of a world find their way on the world's collision", () => {
  const source = fs.readFileSync(path.join(import.meta.dir, "..", "socket", "dungeons.ts"), "utf8");
  const open = source.slice(source.indexOf("export async function openCopyHere("), source.indexOf("await clusterPinMap(key,"));
  expect(open).toContain("const world = getWorldMap(key);");
  expect(open).toContain("creatures.navGrids.useBits(key, world.collision, world.width, world.height, world.tileWidth, world.tileHeight)");
});
