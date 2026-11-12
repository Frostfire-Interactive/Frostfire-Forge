import { afterAll, describe, expect, test } from "bun:test";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { calculateFileChecksum } from "../modules/checksums";
import { receiverSource } from "./receiver-source";

// A map or world changed on the asset server while the game server runs (a restart of the asset server with new
// files, the Tiled extension, another server's save) is taken in without a restart: the local copy is brought up to
// date, the map read again with its particle and placed NPCs, and the players on it load it again where they stand.
// modules/assetloader.ts and the socket handlers cannot be imported: these read their source.

const receiver = receiverSource();
const loader = fs.readFileSync(new URL("../modules/assetloader.ts", import.meta.url), "utf8");
const gatewayClient = fs.readFileSync(new URL("../modules/gateway-client.ts", import.meta.url), "utf8");
const editors = fs.readFileSync(new URL("../socket/handlers/editors.ts", import.meta.url), "utf8");
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
const withNames = (names: string[], code: string): ((given: Record<string, any>) => any) =>
  new Function(`"use strict";\n${transpiler.transformSync(`function make({ ${names.join(", ")} }: any) { ${code} }`)}\nreturn make;`)();
const quiet = { info: () => {}, warn: () => {}, error: () => {}, success: () => {}, debug: () => {} };

describe("a map's checksum", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "map-checksum-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

  test("is the file read again only when the file changed", () => {
    const file = path.join(dir, "m.json");
    fs.writeFileSync(file, JSON.stringify({ a: 1 }, null, 2));
    fs.utimesSync(file, 1000, 1000);
    expect(calculateFileChecksum(file)).toBe(sha('{"a":1}'));
    // the same size and time: not hashed again (every map is checked every few seconds)
    fs.writeFileSync(file, JSON.stringify({ a: 2 }, null, 2));
    fs.utimesSync(file, 1000, 1000);
    expect(calculateFileChecksum(file)).toBe(sha('{"a":1}'));
    // written again: hashed again
    fs.utimesSync(file, 2000, 2000);
    expect(calculateFileChecksum(file)).toBe(sha('{"a":2}'));
    fs.writeFileSync(file, JSON.stringify({ a: 33 }));
    expect(calculateFileChecksum(file)).toBe(sha('{"a":33}'));
  });
});

describe("the NPCs a map places itself", () => {
  test("of one map are dropped, the others kept in order, and its placed ids freed", () => {
    const list = [{ id: -1, map: "a" }, { id: -1000000005, map: "b" }, { id: -2, map: "b" }, { id: -3, map: "c" }];
    const placed = new Set([-1000000005]);
    const drop = withNames(["mapNpcList", "placedNpcIds"], `${fnOf(loader, "function dropMapNpcs(")}\nreturn dropMapNpcs;`)({ mapNpcList: list, placedNpcIds: placed });
    drop("b.json");
    expect(list).toEqual([{ id: -1, map: "a" }, { id: -3, map: "c" }]);
    expect(placed.size).toBe(0);
    drop("c");
    expect(list).toEqual([{ id: -1, map: "a" }]);
  });

  test("join the NPC cache with the database's NPCs, in place of the map NPCs it held", async () => {
    const list = [{ id: -1, map: "a" }];
    const done: any[] = [];
    const publish = withNames(["npc", "assetCache", "mapNpcList"], `${fnOf(loader, "async function publishMapNpcs(")}\nreturn publishMapNpcs;`)({
      mapNpcList: list,
      npc: { setMapNpcs: (l: any) => done.push(["setMapNpcs", l]), isMapNpc: (n: any) => n.id < 0 },
      assetCache: { get: async () => [{ id: 5 }, { id: -9, map: "gone" }], set: async (key: string, value: any) => done.push(["set", key, value]) },
    });
    await publish();
    expect(done).toEqual([["setMapNpcs", list], ["set", "npcs", [{ id: 5 }, { id: -1, map: "a" }]]]);
  });

  test("of a map read again replace its old ones, and reach the NPC cache", () => {
    const reload = fnOf(loader, "export async function reloadMap(");
    const drop = reload.indexOf("dropMapNpcs(file)");
    expect(drop).toBeGreaterThan(0);
    expect(reload.indexOf("extractAndCompressLayers(newMap)")).toBeGreaterThan(drop);
    expect(reload.indexOf("await publishMapNpcs()")).toBeGreaterThan(reload.indexOf("extractAndCompressLayers(newMap)"));
    expect(fnOf(loader, "export async function addCreatedMap(")).toContain("await publishMapNpcs()");
  });

  test("have particle ids no other map NPC had, however many were dropped", () => {
    expect(loader).not.toContain("-(mapNpcList.length + 1)");
    expect(loader).toContain("id: -(nextMapNpcId++)");
  });

  test("of a map read again: its warps, graveyards and shadow layers are read from the new file", () => {
    const reload = fnOf(loader, "export async function reloadMap(");
    const cleared = reload.indexOf("own.warps = null");
    expect(cleared).toBeGreaterThan(0);
    expect(reload.indexOf("extractAndCompressLayers(newMap)")).toBeGreaterThan(cleared);
    expect(reload).toContain("own.graveyards = null");
    expect(reload).toContain("own.shadowLayerNames = null");
  });

  test("of a world changed on the asset server are read again from its new objects, which the map entry then drops", async () => {
    const done: any[] = [];
    const takeIn = withNames(["dropMapNpcs", "extractAndCompressLayers", "emptyParticleLayers", "publishMapNpcs"], `${fnOf(loader, "export async function takeInWorldChange(").replace("export ", "")}\nreturn takeInWorldChange;`)({
      dropMapNpcs: (name: string) => done.push(["drop", name]),
      extractAndCompressLayers: (map: any) => done.push(["extract", map.name]),
      emptyParticleLayers: (map: any) => done.push(["empty", map.name]),
      publishMapNpcs: async () => done.push(["publish"]),
    });
    await takeIn({ name: "w.json", map: { name: "w.json" } });
    expect(done).toEqual([["drop", "w.json"], ["extract", "w.json"], ["empty", "w.json"], ["publish"]]);
  });
});

describe("maps changed on the asset server", () => {
  const code = fnOf(loader, "export async function checkMapChanges(").replace("export ", "").replace('await import("./checksums.ts")', "checksums");
  const NAMES = ["process", "serverFetch", "checksums", "assetCache", "reloadMap", "addCreatedMap", "log", "path", "mapChangeListeners", "takenInMaps", "checkingMaps"];
  function node(answers: any[], loaded = ["m.json"], env: Record<string, string> = { ASSET_SERVER_URL: "http://assets" }) {
    const done: any[] = [];
    const heard: any[] = [];
    const takenInMaps = new Map<string, string>();
    const check = withNames(NAMES, `${code}\nreturn checkMapChanges;`)({
      process: { env },
      serverFetch: async (url: string, init: any) => {
        done.push(["fetch", url, JSON.parse(init.body).checksums]);
        const answer = answers.shift();
        if (answer instanceof Error) throw answer;
        return { ok: answer.ok ?? true, status: answer.status ?? 200, json: async () => answer.body };
      },
      checksums: {
        calculateAllMapChecksums: () => ({ "m.json": "local" }),
        writeMapContent: (name: string, data: any) => { done.push(["write", name, data]); return true; },
      },
      assetCache: { get: async (key: string) => (key === "maps" ? loaded.map((name) => ({ name })) : null) },
      reloadMap: async (name: string) => { done.push(["reload", name]); },
      addCreatedMap: async (name: string, kind: string) => { done.push(["add", name, kind]); },
      log: quiet,
      path,
      mapChangeListeners: [(changes: any) => { heard.push(changes); }],
      takenInMaps,
      checkingMaps: false,
    });
    return { check, done, heard };
  }
  const outdated = (...maps: Array<[string, string]>) => ({ body: { success: true, outdatedMaps: maps.map(([name, checksum]) => ({ name, checksum, data: { name } })) } });

  test("are written here and read again, and those that changed are told", async () => {
    const n = node([outdated(["m.json", "c1"])]);
    expect(await n.check()).toEqual([{ name: "m", added: false }]);
    expect(n.done).toEqual([["fetch", "http://assets/map-checksums", { "m.json": "local" }], ["write", "m.json", { name: "m.json" }], ["reload", "m"]]);
    expect(n.heard).toEqual([[{ name: "m", added: false }]]);
  });

  test("one new to this server is taken in like a map made in the editor", async () => {
    const n = node([outdated(["fresh.json", "c1"])]);
    expect(await n.check()).toEqual([{ name: "fresh", added: true }]);
    expect(n.done.slice(1)).toEqual([["write", "fresh.json", { name: "fresh.json" }], ["add", "fresh", "map"]]);
  });

  test("none: nothing is written or told", async () => {
    const n = node([{ body: { success: true, outdatedMaps: [] } }]);
    expect(await n.check()).toEqual([]);
    expect(n.done.length).toBe(1);
    expect(n.heard).toEqual([]);
  });

  test("the same copy of the asset server's again is not read again (a copy that never matches would reload every check)", async () => {
    const n = node([outdated(["m.json", "c1"]), outdated(["m.json", "c1"]), outdated(["m.json", "c2"])]);
    expect(await n.check()).toEqual([{ name: "m", added: false }]);
    expect(await n.check()).toEqual([]);
    expect(await n.check()).toEqual([{ name: "m", added: false }]);
    expect(n.done.filter((d) => d[0] === "reload").length).toBe(2);
  });

  test("with names that are not map files are left alone", async () => {
    const n = node([outdated(["../x.json", "c"], [".hidden.json", "c"], ["notes.txt", "c"])]);
    expect(await n.check()).toEqual([]);
    expect(n.done.filter((d) => d[0] !== "fetch")).toEqual([]);
  });

  test("cannot be checked with an asset server that refuses or cannot be reached, and are not checked with none", async () => {
    await expect(node([{ ok: false, status: 503, body: {} }]).check()).rejects.toThrow("503");
    await expect(node([{ body: { success: false, error: "nope" } }]).check()).rejects.toThrow("nope");
    await expect(node([new Error("down")]).check()).rejects.toThrow("down");
    const none = node([], ["m.json"], {});
    expect(await none.check()).toEqual([]);
    expect(none.done).toEqual([]);
  });

  test("are checked at registration with the gateway the same way", () => {
    const sync = cut(gatewayClient, "private async syncMapChecksums(", /\n  }\r?\n/);
    expect(sync).toContain("checkMapChanges(");
    expect(sync).not.toContain("writeMapContent");
  });
});

describe("a map changed under this node's players", () => {
  test("has its caches here forgotten and its players load it again", async () => {
    const done: any[] = [];
    const history = new Map([["m", []], ["x", []]]);
    const take = withNames(["clearMapCache", "fishing", "forgetMapGeometry", "editorEditHistory", "mapPropertiesCache", "clusterMapAdded", "refreshPlayersOnMap", "log"], `${fnOf(receiver, "export async function takeInMapChange(").replace("export ", "")}\nreturn takeInMapChange;`)({
      clearMapCache: (name: string) => done.push(["clearMapCache", name]),
      fishing: { forgetMap: (name: string) => done.push(["fishing", name]) },
      forgetMapGeometry: (name: string) => done.push(["geometry", name]),
      editorEditHistory: history,
      mapPropertiesCache: [{ name: "n.json", width: 10, height: 20, tileWidth: 32, tileHeight: 16 }],
      clusterMapAdded: async (...args: any[]) => done.push(["cluster", ...args]),
      refreshPlayersOnMap: async (name: string) => done.push(["refresh", name]),
      log: quiet,
    });
    await take({ name: "m", added: false });
    expect(done).toEqual([["clearMapCache", "m"], ["fishing", "m"], ["geometry", "m"], ["refresh", "m"]]);
    expect([...history.keys()]).toEqual(["x"]);
    done.length = 0;
    // a new one joins the region's maps (cluster mode)
    await take({ name: "n", added: true });
    expect(done).toContainEqual(["cluster", "n", 320, 320]);
    expect(done.at(-1)).toEqual(["refresh", "n"]);
  });

  test("players load it again where they stand; one changing node, or without a connection, is left", async () => {
    const moved: any[] = [];
    const queues = { spawn: new Map(), despawn: new Map() };
    const onMap = [
      { id: "a", wt: { id: "a" }, location: { map: "m", position: { x: 10, y: 20, direction: "up" } } },
      { id: "b", location: { map: "m", position: { x: 1, y: 1 } } },
      { id: "c", wt: { id: "c" }, handoff: {}, location: { map: "m", position: { x: 1, y: 1 } } },
      { id: "d", wt: { id: "d" }, location: { map: "m" } },
    ];
    const refresh = withNames(["filterPlayersByMap", "transitionPlayerToMap", "CELLS_ON", "inHandoff", "spawnBatchQueue", "despawnBatchQueue", "log"], `${fnOf(receiver, "export async function refreshPlayersOnMap(").replace("export ", "")}\nreturn refreshPlayersOnMap;`)({
      filterPlayersByMap: (name: string) => (name === "m" ? onMap : []),
      transitionPlayerToMap: async (p: any, map: string, pos: any, wt: any, s: any, d: any) => moved.push([p.id, map, pos, wt.id, s === queues.spawn, d === queues.despawn]),
      CELLS_ON: true,
      inHandoff: (p: any) => !!p.handoff,
      spawnBatchQueue: queues.spawn,
      despawnBatchQueue: queues.despawn,
      log: quiet,
    });
    await refresh("m");
    expect(moved).toEqual([
      ["a", "m", { x: 10, y: 20, direction: "up" }, "a", true, true],
      ["d", "m", { x: 0, y: 0, direction: "down" }, "d", true, true],
    ]);
  });

  test("is looked for every few seconds, maps and worlds alike, and at registration", () => {
    const poll = cut(receiver, "const seconds = Number(process.env.WORLD_SYNC_INTERVAL ?? 10);", /\n}\r?\n/);
    expect(poll).toContain("await checkMapChanges()");
    expect(poll).toContain("await takeInWorldChange(world)");
    expect(poll).toContain("await takeInMapChange({ name: world.id, added: false })");
    expect(receiver).toContain("onMapsChanged(async (changes) => {");
  });

  test("by /reloadmap is taken in the same way", () => {
    const reload = fnOf(receiver, "async function reloadMapHere(");
    expect(reload).toContain("await takeInMapChange({ name: mapName, added: false })");
    expect(reload).not.toContain("packetManager.loadMap(");
  });
});

test("the map editor's save leaves this node's copy of the map the asset server's", () => {
  const save = cut(editors, "await saveMapChunks(saveData.mapName", /sendPacket\(wt, packetManager\.notify\(\{\r?\n\s+message: `Map saved successfully! \$\{saveData\.chunks/);
  const synced = save.indexOf("await syncMapFromAssetServer(saveData.mapName)");
  expect(synced).toBeGreaterThan(0);
  expect(save.indexOf("await reloadMap(saveData.mapName)")).toBeGreaterThan(synced);
});
