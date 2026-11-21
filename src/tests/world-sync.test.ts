import { afterAll, expect, test } from "bun:test";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { onLeftChangeMissed, startMapSave } from "../modules/mapsaves";
import { checkWorldChanges, getWorldMap, loadWorldMaps, refreshWorldMap, syncWorldMaps, warpsAndGraveyardsOf } from "../modules/worldmaps";

function writeWorld(dir: string, blocked: [number, number][], warpX: number, id = "synctest"): void {
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
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "collision.bits"), collision.bytes);
  fs.writeFileSync(path.join(dir, "nopvp.bits"), nopvp.bytes);
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    format: "ffworld", formatVersion: 1, id, width: 64, height: 64, tilewidth: 16, tileheight: 16, chunkSize: 64,
    layers: [{ id: 1, name: "Ground", type: "tilelayer", tileIndex: 0, role: "tiles", visible: true }, { id: 2, name: "Warps", type: "objectgroup", visible: true }],
    tilesets: [],
    bitsets: { collision: { file: "collision.bits", hash: collision.hash }, nopvp: { file: "nopvp.bits", hash: nopvp.hash } },
    objects: [{ id: 1, layer: "Warps", name: "W1", type: "warp", x: warpX, y: 32, width: 32, height: 16, properties: [{ name: "map", type: "string", value: "town" }, { name: "x", type: "int", value: 5 }, { name: "y", type: "int", value: 6 }] }],
  }));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "world-sync-"));
const remoteRoot = path.join(root, "remote");
const remote = path.join(remoteRoot, "synctest.world");
const local = path.join(root, "local");
fs.mkdirSync(local, { recursive: true });
const sha256 = (dir: string, file: string) => crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, file))).digest("hex");
// how long the asset server takes to send each file, so that two syncs overlap as they do on a real network
let fileDelayMs = 0;

// The asset server's two world routes, serving every world of `remoteRoot`
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = (await req.json().catch(() => ({}))) as any;
    if (url.pathname === "/world-list") {
      const worlds = fs.readdirSync(remoteRoot).map(entry => {
        const files = Object.fromEntries(["manifest.json", "collision.bits", "nopvp.bits"].map(f => [f, sha256(path.join(remoteRoot, entry), f)]));
        const id = entry.slice(0, -".world".length);
        return { id, name: `${id}.json`, files };
      });
      return Response.json({ success: true, worlds });
    }
    if (url.pathname === "/world-file") {
      if (fileDelayMs) await Bun.sleep(fileDelayMs);
      return new Response(fs.readFileSync(path.join(remoteRoot, `${body.id}.world`, body.file)));
    }
    return new Response("not found", { status: 404 });
  },
});
const env = { internal: process.env.ASSET_SERVER_INTERNAL_URL };
process.env.ASSET_SERVER_INTERNAL_URL = `http://localhost:${server.port}`;
afterAll(() => {
  server.stop(true);
  if (env.internal === undefined) delete process.env.ASSET_SERVER_INTERNAL_URL;
  else process.env.ASSET_SERVER_INTERNAL_URL = env.internal;
  fs.rmSync(root, { recursive: true, force: true });
});

test("a world changed on the asset server is taken in without a restart", async () => {
  writeWorld(remote, [[1, 1]], 100);
  expect(await syncWorldMaps(local)).toEqual(["synctest"]);
  loadWorldMaps(local, new Set());
  const world = getWorldMap("synctest")!;
  world.properties = { name: world.name, warps: null, graveyards: null, version: "0" } as any;
  const collision = world.collision;
  const entry = world.map;
  expect(collision.isSet(1, 1)).toBe(1);

  // Nothing changed: nothing to do, and the local files are not hashed again
  expect(await checkWorldChanges()).toEqual([]);

  // Saved from outside (the Tiled extension): a wall moved and the warp moved
  writeWorld(remote, [[2, 2]], 200);
  const changed = await checkWorldChanges();
  expect(changed.map(w => w.id)).toEqual(["synctest"]);
  // the same bitset object everything holds now reads the new bits
  expect(world.collision).toBe(collision);
  expect(collision.isSet(1, 1)).toBe(0);
  expect(collision.isSet(2, 2)).toBe(1);
  expect(world.properties!.warps).toEqual([{ name: "W1", map: "town", x: 5, y: 6, position: { x: 200, y: 32 }, size: { width: 32, height: 16 }, layer: "Warps" }]);
  expect(world.properties!.version).not.toBe("0");
  // the map entry the maps list holds carries the new objects (the loader reads its particle NPCs again from them)
  expect(world.map).toBe(entry);
  expect(world.map.data.layers.find((l: any) => l.name === "Warps").objects.map((o: any) => o.x)).toEqual([200]);

  expect(await checkWorldChanges()).toEqual([]);
});

test("a world saved here is not taken in again when the asset server tells of the save after the save fetched it", async () => {
  const world = getWorldMap("synctest")!;
  writeWorld(remote, [[3, 3]], 300);
  fileDelayMs = 20;
  try {
    const endSave = startMapSave("synctest");
    const save = refreshWorldMap("synctest").finally(() => endSave(true));
    const check = checkWorldChanges();
    expect(await check).toEqual([]);
    await save;
  } finally {
    fileDelayMs = 0;
  }
  expect(world.collision.isSet(3, 3)).toBe(1);
  expect(await checkWorldChanges()).toEqual([]);
});

test("a world saved here is not taken in again when the asset server tells of the save before the save fetched it", async () => {
  const world = getWorldMap("synctest")!;
  writeWorld(remote, [[4, 4]], 400);
  fileDelayMs = 20;
  try {
    const endSave = startMapSave("synctest");
    const check = checkWorldChanges();
    const save = refreshWorldMap("synctest").finally(() => endSave(true));
    expect(await check).toEqual([]);
    await save;
  } finally {
    fileDelayMs = 0;
  }
  // the save puts the new bits in place, though the check fetched the files
  expect(world.collision.isSet(4, 4)).toBe(1);
  expect(world.collision.isSet(3, 3)).toBe(0);
  expect(await checkWorldChanges()).toEqual([]);

  // once the save has ended, a change from outside is taken in again
  writeWorld(remote, [[5, 5]], 500);
  expect((await checkWorldChanges()).map(w => w.id)).toEqual(["synctest"]);
  expect(world.collision.isSet(5, 5)).toBe(1);
});

test("another world changed elsewhere, whose files a save here fetched with its own, is taken in by the next check", async () => {
  const other = path.join(remoteRoot, "othertest.world");
  writeWorld(other, [[1, 1]], 100, "othertest");
  await syncWorldMaps(local);
  loadWorldMaps(local, new Set());
  writeWorld(other, [[6, 6]], 600, "othertest");
  writeWorld(remote, [[7, 7]], 700);
  const endSave = startMapSave("synctest");
  await refreshWorldMap("synctest").finally(() => endSave(true));
  expect(getWorldMap("synctest")!.collision.isSet(7, 7)).toBe(1);
  expect((await checkWorldChanges()).map(w => w.id)).toEqual(["othertest"]);
  expect(getWorldMap("othertest")!.collision.isSet(6, 6)).toBe(1);
  expect(await checkWorldChanges()).toEqual([]);
});

test("a change left to a save of a world that ended without saving is taken in by the next check", async () => {
  const world = getWorldMap("synctest")!;
  writeWorld(remote, [[8, 8]], 800);
  const missed: string[] = [];
  const stop = onLeftChangeMissed((name) => { missed.push(name); });
  try {
    const end = startMapSave("synctest");
    expect(await checkWorldChanges()).toEqual([]);
    expect(world.collision.isSet(8, 8)).toBe(0);
    end(false);
  } finally {
    stop();
  }
  expect(missed).toEqual(["synctest"]);
  expect((await checkWorldChanges()).map(w => w.id)).toEqual(["synctest"]);
  expect(world.collision.isSet(8, 8)).toBe(1);
  expect(await checkWorldChanges()).toEqual([]);
});

test("warps and graveyards of a manifest, by type or by layer, as the loader reads them", () => {
  const manifest = {
    objects: [
      { id: 1, layer: "Graveyard", name: "G1", x: 10.7, y: 20.2 },
      { id: 2, layer: "Stuff", name: "W1", type: "warp", x: 1, y: 2, width: 3, height: 4, properties: [{ name: "map", value: "a" }, { name: "x", value: 1 }, { name: "y", value: 2 }] },
      { id: 3, layer: "Warps", name: "broken" },
    ],
  };
  const { warps, graveyards } = warpsAndGraveyardsOf(manifest);
  expect(graveyards).toEqual([{ name: "G1", position: { x: 10, y: 20 }, layer: "Graveyard" }]);
  expect(warps!.map(w => w.name)).toEqual(["W1"]);
  expect(warpsAndGraveyardsOf({ objects: [] })).toEqual({ warps: null, graveyards: null });
});
