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

// The maps a check or a poll found changed are written here and read again by takeInMaps
const takeInCode = fnOf(loader, "async function takeInMaps(").replaceAll('await import("./checksums.ts")', "checksums");

describe("maps changed on the asset server", () => {
  const code = `${takeInCode}\n${fnOf(loader, "export async function checkMapChanges(").replace("export ", "").replaceAll('await import("./checksums.ts")', "checksums")}`;
  const NAMES = ["process", "serverFetch", "checksums", "assetCache", "reloadMap", "addCreatedMap", "log", "path", "mapChangeListeners", "takenInMaps", "checkingMaps", "mapSync"];
  function node(answers: any[], loaded = ["m.json"], env: Record<string, string> = { ASSET_SERVER_URL: "http://assets" }, local: Record<string, string> = {}) {
    const done: any[] = [];
    const heard: any[] = [];
    const takenInMaps = new Map<string, string>();
    const mapSync = { epoch: "", seq: 0 };
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
        calculateMapChecksum: (name: string) => local[name] ?? "",
      },
      assetCache: { get: async (key: string) => (key === "maps" ? loaded.map((name) => ({ name })) : null) },
      reloadMap: async (name: string) => { done.push(["reload", name]); },
      addCreatedMap: async (name: string, kind: string) => { done.push(["add", name, kind]); },
      log: quiet,
      path,
      mapChangeListeners: [(changes: any) => { heard.push(changes); }],
      takenInMaps,
      checkingMaps: false,
      mapSync,
    });
    return { check, done, heard, mapSync };
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

  test("one whose copy here already hashes like the asset server's is not written or read again", async () => {
    const n = node([outdated(["m.json", "same"])], ["m.json"], undefined, { "m.json": "same" });
    expect(await n.check()).toEqual([]);
    expect(n.done.length).toBe(1);
  });

  test("the check remembers where this server stands in the asset server's list of changed maps", async () => {
    const n = node([{ body: { success: true, outdatedMaps: [], changes: { epoch: "e1", seq: 4 } } }]);
    await n.check();
    expect(n.mapSync).toEqual({ epoch: "e1", seq: 4 });
  });

  test("an asset server with no list of changed maps leaves this server without a place in one", async () => {
    const n = node([{ body: { success: true, outdatedMaps: [] } }]);
    await n.check();
    expect(n.mapSync).toEqual({ epoch: "", seq: 0 });
  });

  test("are checked at registration with the gateway the same way", () => {
    const sync = cut(gatewayClient, "private async syncMapChecksums(", /\n  }\r?\n/);
    expect(sync).toContain("checkMapChanges(");
    expect(sync).not.toContain("writeMapContent");
  });
});

// The poll asks the asset server only for the maps changed since the last answer, and takes in only those: with
// thousands of maps, comparing every one at every poll held the event loop for seconds.
describe("the poll for maps changed on the asset server", () => {
  const code = `${takeInCode}\n${fnOf(loader, "export async function pollMapChanges(").replace("export ", "")}`;
  const NAMES = ["process", "serverFetch", "checkMapChanges", "checksums", "assetCache", "reloadMap", "addCreatedMap", "log", "path", "mapChangeListeners", "takenInMaps", "checkingMaps", "mapSync"];
  function node(answers: any[], place = { epoch: "e1", seq: 4 }) {
    const mapSync = { ...place };
    const asked: any[] = [];
    const done: any[] = [];
    const heard: any[] = [];
    let full = 0;
    const reads: string[] = [];
    const poll = withNames(NAMES, `${code}\nreturn pollMapChanges;`)({
      process: { env: { ASSET_SERVER_URL: "http://assets", ASSET_SERVER_AUTH_KEY: "k", SERVER_ID: "s1" } },
      serverFetch: async (url: string, init: any) => {
        asked.push([url, JSON.parse(init.body)]);
        const answer = answers.shift();
        if (answer instanceof Error) throw answer;
        return { ok: answer.ok ?? true, status: answer.status ?? 200, json: async () => answer.body };
      },
      checkMapChanges: async () => { full++; mapSync.epoch = "e2"; mapSync.seq = 1; return [{ name: "all", added: false }]; },
      checksums: {
        calculateAllMapChecksums: () => { throw new Error("every map was checksummed"); },
        writeMapContent: (name: string, data: any) => { done.push(["write", name, data]); return true; },
        calculateMapChecksum: () => "",
      },
      assetCache: { get: async (key: string) => { reads.push(key); return key === "maps" ? [{ name: "m.json" }, { name: "other.json" }] : null; } },
      reloadMap: async (name: string) => { done.push(["reload", name]); },
      addCreatedMap: async (name: string, kind: string) => { done.push(["add", name, kind]); },
      log: quiet,
      path,
      mapChangeListeners: [(changes: any) => { heard.push(changes); }],
      takenInMaps: new Map<string, string>(),
      checkingMaps: false,
      mapSync,
    });
    return { poll, asked, done, heard, mapSync, reads, full: () => full };
  }
  const changed = (seq: number, ...names: string[]) => ({ body: { success: true, epoch: "e1", seq, full: false, maps: names.map((name) => ({ name, checksum: `c-${name}`, data: { name } })) } });

  test("takes in only the maps the asset server lists as changed since its last answer", async () => {
    const n = node([changed(5, "m.json")]);
    expect(await n.poll()).toEqual([{ name: "m", added: false }]);
    expect(n.asked).toEqual([["http://assets/map-changes", { epoch: "e1", since: 4, serverId: "s1", authKey: "k" }]]);
    expect(n.done).toEqual([["write", "m.json", { name: "m.json" }], ["reload", "m"]]);
    expect(n.heard).toEqual([[{ name: "m", added: false }]]);
    expect(n.mapSync).toEqual({ epoch: "e1", seq: 5 });
    expect(n.full()).toBe(0);
  });

  test("with nothing changed, writes and tells nothing", async () => {
    const n = node([changed(4)]);
    expect(await n.poll()).toEqual([]);
    expect(n.done).toEqual([]);
    expect(n.heard).toEqual([]);
    expect(n.mapSync).toEqual({ epoch: "e1", seq: 4 });
  });

  test("with nothing changed, does not read the maps list (with CACHE=redis, every map's data: seconds of parsing every poll)", async () => {
    const n = node([changed(4), changed(4), changed(4)]);
    for (let i = 0; i < 3; i++) await n.poll();
    expect(n.reads).toEqual([]);
  });

  test("compares every map once when the asset server started again or no longer holds the changes since its last answer", async () => {
    const n = node([{ body: { success: true, epoch: "e2", seq: 0, full: true, maps: [] } }]);
    expect(await n.poll()).toEqual([{ name: "all", added: false }]);
    expect(n.full()).toBe(1);
    expect(n.done).toEqual([]);
  });

  test("compares every map, without asking for changes, while it has no place in the asset server's list", async () => {
    const n = node([], { epoch: "", seq: 0 });
    expect(await n.poll()).toEqual([{ name: "all", added: false }]);
    expect(n.asked).toEqual([]);
    expect(n.full()).toBe(1);
  });

  test("throws when the asset server refuses or cannot be reached, and keeps its place", async () => {
    await expect(node([new Error("down")]).poll()).rejects.toThrow("down");
    await expect(node([{ ok: false, status: 503, body: {} }]).poll()).rejects.toThrow("503");
    const n = node([{ body: { success: false, error: "nope" } }]);
    await expect(n.poll()).rejects.toThrow("nope");
    expect(n.mapSync).toEqual({ epoch: "e1", seq: 4 });
    expect(n.full()).toBe(0);
  });

  test("is what the poll runs", () => {
    const poll = cut(receiver, "const seconds = Number(process.env.WORLD_SYNC_INTERVAL", /\n}\r?\n/);
    expect(poll).toContain("await pollMapChanges()");
    expect(poll).not.toContain("checkMapChanges()");
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

  test("is followed on the asset server's connection, maps and worlds alike, and asked for only from an older asset server", () => {
    const sync = cut(receiver, "const seconds = Number(process.env.WORLD_SYNC_INTERVAL ?? 10);", /\n}\r?\n/);
    expect(sync).toContain("followAssetServerMapChanges({");
    expect(sync).toContain("worldsChanged: takeInWorldChanges");
    // the timer is only the fallback for an asset server without /map-events
    expect(sync.indexOf("setInterval(")).toBeGreaterThan(sync.indexOf("legacy: () => {"));
    const worlds = fnOf(receiver, "async function takeInWorldChanges(");
    expect(worlds).toContain("await takeInWorldChange(world)");
    expect(worlds).toContain("await takeInMapChange({ name: world.id, added: false })");
    expect(receiver).toContain("onMapsChanged(async (changes) => {");
  });

  test("the connection the engine follows is /map-events, from this server's place, and takes in what it sends", () => {
    const follow = fnOf(loader, "export function followAssetServerMapChanges(");
    expect(follow).toContain("${assetServerUrl}/map-events");
    expect(follow).toContain("epoch: place.epoch");
    expect(follow).toContain("since: place.seq");
    expect(follow).toContain('redirect: "manual"');
    expect(follow).toContain("return await takeInMaps(maps)");
    expect(follow).toContain("return checkMapChanges(assetServerUrl)");
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
