import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BlockTable, blockTableKey } from "../cluster/blocks";
import { MapCatalogue, extentOf, takeInMap } from "../cluster/maps";
import { MemoryStore } from "../cluster/memorystore";
import { addSnapshotMap, readSnapshot, snapshotKey, useSnapshotMaps } from "../cluster/snapshots";
import { receiverSource } from "./receiver-source";

// Cluster mode: a map made in the map editor (CREATE_MAP) while the region runs joins it at once. Every node of the
// region takes the map in (peer news "map-created": a Tiled map fetched from the asset server, a world as at start),
// and each publishes its size, so the coordinator splits it like the maps loaded at start, and keeps its block table.
// socket/handlers/editors.ts and modules/assetloader.ts cannot be imported: these read their source.

const receiver = receiverSource();
const loader = readFileSync(new URL("../modules/assetloader.ts", import.meta.url), "utf8");
const index = readFileSync(new URL("../cluster/index.ts", import.meta.url), "utf8");
const transpiler = new Bun.Transpiler({ loader: "ts" });

function cut(source: string, start: string, until: RegExp): string {
  const at = source.indexOf(start);
  if (at < 0) throw new Error(`Not found in the source: ${start}`);
  const rest = source.slice(at);
  const end = rest.search(until);
  if (end < 0) throw new Error(`No end found for: ${start}`);
  return rest.slice(0, end);
}
const fnOf = (source: string, header: string) => cut(source, header, /\n}\r?\n/) + "\n}";
const newsOf = (name: string) => cut(receiver, `onPeerNews("${name}",`, /\n}\);\r?\n/) + "\n});";
const withNames = (names: string[], code: string): ((given: Record<string, any>) => any) =>
  new Function(`"use strict";\n${transpiler.transformSync(`function make({ ${names.join(", ")} }: any) { ${code} }`)}\nreturn make;`)();

afterEach(() => { useSnapshotMaps(null); });

describe("a map made while the cluster runs, on this node", () => {
  test("has its size published for the coordinator, and its block table kept here", async () => {
    const store = new MemoryStore();
    const blocks = new BlockTable(store);
    await store.set(blockTableKey("fresh"), JSON.stringify({ epoch: 3, owners: { "0,0": { nodeId: "a", epoch: 3, since: 1 } } }));
    const node = { store, blocks, maps: ["main"] };
    await takeInMap(node, extentOf("fresh.json", 9000, 4096));
    expect((await new MapCatalogue(store).all()).map((m) => m.name)).toEqual(["fresh"]);
    expect(blocks.extentOf("fresh")).toEqual({ blocksX: 3, blocksY: 1 });
    expect(node.maps).toEqual(["main", "fresh"]);
    expect(blocks.maps()).toContain("fresh");
  });

  test("taken in twice is listed once", async () => {
    const store = new MemoryStore();
    const node = { store, blocks: new BlockTable(store), maps: ["main"] };
    await takeInMap(node, extentOf("fresh", 100, 100));
    await takeInMap(node, extentOf("fresh", 100, 100));
    expect(node.maps).toEqual(["main", "fresh"]);
  });

  test("is a map a login's snapshot may be read on", async () => {
    const store = new MemoryStore();
    await store.set(snapshotKey("hero"), JSON.stringify({ epoch: 1, at: 5, username: "hero", map: "fresh", x: 10, y: 20, direction: "down", stats: null }));
    useSnapshotMaps([{ name: "main", widthPx: 100, heightPx: 100 }]);
    expect(await readSnapshot(store, "hero")).toBeNull();
    addSnapshotMap({ name: "fresh.json", widthPx: 100, heightPx: 100 });
    expect((await readSnapshot(store, "hero"))?.map).toBe("fresh");
  });

  test("is taken in by the running node only", () => {
    const added = fnOf(index, "export async function clusterMapAdded(");
    expect(added).toContain("takeInMap(");
    expect(added).toContain("addSnapshotMap(");
    expect(added).toMatch(/if \(!node\) return/);
  });
});

describe("a map made on another node", () => {
  const adopt = withNames(["syncMapFromAssetServer", "addCreatedMap", "fs", "path", "mapDir"], `${fnOf(loader, "export async function adoptCreatedMap(").replace("export ", "")}\nreturn adoptCreatedMap;`);
  const fakes = (onDisk: boolean, fetched: boolean) => {
    const done: any[] = [];
    return {
      done,
      syncMapFromAssetServer: async (name: string) => { done.push(["sync", name]); return fetched; },
      addCreatedMap: async (...args: any[]) => { done.push(["add", ...args]); },
      fs: { existsSync: () => onDisk },
      path: { join: (...parts: string[]) => parts.join("/") },
      mapDir: "maps",
    };
  };

  test("a Tiled map is fetched from the asset server, then read like one made here", async () => {
    const here = fakes(false, true);
    await adopt(here)("fresh", "map");
    expect(here.done).toEqual([["sync", "fresh"], ["add", "fresh", "map"]]);
  });

  test("a Tiled map the asset server does not send, and is not here, is refused", async () => {
    const here = fakes(false, false);
    await expect(adopt(here)("fresh", "map")).rejects.toThrow();
    expect(here.done).toEqual([["sync", "fresh"]]);
  });

  test("a world is fetched as at start", async () => {
    const here = fakes(false, false);
    await adopt(here)("big", "world");
    expect(here.done).toEqual([["add", "big", "world"]]);
  });

  test("a Tiled map is read from the file, without data of its own", () => {
    const add = fnOf(loader, "export async function addCreatedMap(");
    expect(add).not.toContain("!data ||");
  });

  const NEWS = ["maps", "adoptCreatedMap", "mapJoinsCluster", "MAP_NAME_RE"];
  const news = (loaded: string[]) => {
    const done: any[] = [];
    let handler: any;
    const given = {
      onPeerNews: (_name: string, h: any) => { handler = h; },
      maps: loaded.map((name) => ({ name: `${name}.json` })),
      adoptCreatedMap: async (...args: any[]) => { done.push(["adopt", ...args]); },
      mapJoinsCluster: async (name: string) => { done.push(["join", name]); },
      MAP_NAME_RE: /^[a-z0-9][a-z0-9_-]{0,47}$/,
    };
    withNames(["onPeerNews", ...NEWS], newsOf("map-created"))(given);
    return { done, run: (data: any) => handler(data, "node-2") };
  };

  test("is taken in here and joins the cluster here", async () => {
    const n = news(["main"]);
    await n.run({ name: "fresh", kind: "world" });
    expect(n.done).toEqual([["adopt", "fresh", "world"], ["join", "fresh"]]);
  });

  test("this node already has is only joined", async () => {
    const n = news(["fresh"]);
    await n.run({ name: "fresh", kind: "map" });
    expect(n.done).toEqual([["join", "fresh"]]);
  });

  test("named badly, or of no kind, is left alone", async () => {
    const n = news([]);
    await n.run({ name: "../x", kind: "map" });
    await n.run({ name: "fresh", kind: "cave" });
    await n.run(null);
    expect(n.done).toEqual([]);
  });
});

test("the map editor's new map joins the cluster here and is told to the region before the admin is moved", () => {
  const create = cut(receiver, 'case "CREATE_MAP": {', /\n {8}break;\r?\n {6}\}/);
  const join = create.indexOf("mapJoinsCluster(request.name)");
  const told = create.indexOf('tellPeers("map-created", { name: request.name, kind: made.kind })');
  expect(join).toBeGreaterThan(create.indexOf("addCreatedMap("));
  expect(told).toBeGreaterThan(0);
  expect(create.indexOf("transitionPlayerToMap(")).toBeGreaterThan(Math.max(join, told));
  const joins = fnOf(receiver, "async function mapJoinsCluster(");
  expect(joins).toContain("clusterMapAdded(");
});
