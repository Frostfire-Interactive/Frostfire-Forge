import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { receiverSource } from "./receiver-source";

// Cluster mode: a map can be split between the nodes of a region, so the map editor's work reaches every node. A
// world's save has each node fetch its new collision and no-pvp bits and take its graveyards and warps, and its
// players there fetch the changed chunks again (peer news "world-saved"). A plain map's save has each node bring its
// copy of the map file up to date from the asset server and read the map again, then shows its players the save
// (peer news "map-saved"). Live tile edits and layer locks reach the admins editing the map on every node (peer news
// "editor-tile-edit" and "editor-layer-lock"). socket/handlers/editors.ts and modules/assetloader.ts cannot be
// imported: these read their source.

const receiver = receiverSource();
const loader = readFileSync(new URL("../modules/assetloader.ts", import.meta.url), "utf8");
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
const fn = (header: string) => fnOf(receiver, header);
const caseOf = (name: string) => cut(receiver, `case "${name}": {`, /\n {8}break;\r?\n {6}\}/);
const newsOf = (name: string) => cut(receiver, `onPeerNews("${name}",`, /\n}\);\r?\n/) + "\n});";
const withNames = (names: string[], code: string): ((given: Record<string, any>) => any) =>
  new Function(`"use strict";\n${transpiler.transformSync(`function make({ ${names.join(", ")} }: any) { ${code} }`)}\nreturn make;`)();

function node() {
  const sent: Record<string, any[]> = { saver: [], admin: [], player: [], away: [], closed: [] };
  const players: Record<string, any> = {
    saver: { id: "saver", isAdmin: true, wt: { id: "saver", readyState: 1 }, location: { map: "w", position: { x: 10, y: 20 } } },
    admin: { id: "admin", isAdmin: true, wt: { id: "admin", readyState: 1 }, location: { map: "w", position: { x: 5, y: 6 } } },
    player: { id: "player", wt: { id: "player", readyState: 1 }, location: { map: "w", position: { x: "7", y: 8 } } },
    away: { id: "away", isAdmin: true, wt: { id: "away", readyState: 1 }, location: { map: "x", position: { x: 0, y: 0 } } },
    closed: { id: "closed", isAdmin: true, wt: { id: "closed", readyState: 3 }, location: { map: "w" } },
  };
  const done: any[] = [];
  const world: any = { properties: { graveyards: ["old"], warps: ["old"] } };
  return {
    sent,
    done,
    players,
    world,
    // as services/mapindex.ts: a name with or without ".json" is the same map
    filterPlayersByMap: (map: string) => Object.values(players).filter((p) => p.location.map === map.replaceAll(".json", "")),
    playerCache: { set: (id: string) => done.push(["cached", id]) },
    sendPacket: (wt: any, packet: any) => sent[wt.id].push(packet),
    packetManager: {
      updateChunks: (data: any) => ({ chunks: data.chunks }),
      mapRebase: (data: any) => ({ rebase: data }),
      editorTileEdit: (data: any) => ({ tiles: data }),
      editorLayerLock: (data: any) => ({ lock: data }),
    },
    getWorldMap: (name: string) => (name === "w" ? world : undefined),
    clearMapCache: (name: string) => done.push(["clearMapCache", name]),
    fishing: { forgetMap: (name: string) => done.push(["forgetMap", name]) },
    refreshWorldMap: async (name: string) => { done.push(["refreshWorldMap", name]); },
    syncMapFromAssetServer: async (name: string) => { done.push(["sync", name]); return true; },
    reloadMap: async (name: string) => { done.push(["reloadMap", name]); },
    editorEditHistory: new Map<string, any[]>([["w.json", [{ senderId: 1, mapName: "w.json", edits: [1] }]], ["x", [{ senderId: 2, mapName: "x", edits: [2] }]]]),
    activeEditorsByMap: new Map<string, Set<any>>([["w", new Set(["admin"])]]),
  };
}
const NAMES = Object.keys(node()).filter((name) => !["sent", "done", "players", "world"].includes(name));

describe("a world saved in the map editor", () => {
  const make = withNames(NAMES, `${fn("async function worldSavedHere(")}\nreturn worldSavedHere;`);
  const chunk = { chunkX: 1, chunkY: 2 };

  test("has this node fetch its new bits, drop its unsaved edits, and its players but the saver fetch the changed chunks", async () => {
    const here = node();
    await make(here)({ world: "w", mapName: "w.json", changed: [chunk] }, "saver");
    expect(here.done).toEqual([["forgetMap", "w"], ["refreshWorldMap", "w"]]);
    expect(here.sent).toEqual({ saver: [], admin: [{ chunks: [chunk] }], player: [{ chunks: [chunk] }], away: [], closed: [{ chunks: [chunk] }] });
    expect([...here.editorEditHistory.keys()]).toEqual(["x"]);
  });

  test("with graveyards or warps, the world takes them and the movement cache of the map is cleared", async () => {
    const here = node();
    await make(here)({ world: "w", mapName: "w", changed: [], graveyards: ["new"] });
    expect(here.world.properties).toEqual({ graveyards: ["new"], warps: ["old"] });
    expect(here.done).toEqual([["clearMapCache", "w"], ["refreshWorldMap", "w"]]);
    expect(Object.values(here.sent).flat()).toEqual([]);
  });

  test("this node does not hold is left alone", async () => {
    const here = node();
    await make(here)({ world: "nope", mapName: "nope", changed: [chunk], warps: ["new"] });
    expect(here.done).toEqual([]);
    expect(Object.values(here.sent).flat()).toEqual([]);
  });
});

describe("a plain map saved in the map editor, shown to the players here", () => {
  const make = withNames(NAMES, `${fn("function showMapSaveHere(")}\nreturn showMapSaveHere;`);
  const chunks = [{ chunkX: 0, chunkY: 0 }];

  test("gives every one of them the new bounds, and all but the saver the saved chunks", () => {
    const here = node();
    make(here)("w.json", { shiftX: 0, shiftY: 0, width: 40, height: 30, chunks }, "saver");
    const bounds = { rebase: { shiftX: 0, shiftY: 0, width: 40, height: 30 } };
    expect(here.sent).toEqual({ saver: [bounds], admin: [bounds, { chunks }], player: [bounds, { chunks }], away: [], closed: [bounds, { chunks }] });
    expect(here.done).toEqual([]);
  });

  test("that grew left or up moves them all with its origin and re-syncs them", () => {
    const here = node();
    make(here)("w", { shiftX: 64, shiftY: 0, width: 42, height: 30, chunks }, "saver");
    expect([here.players.saver, here.players.admin, here.players.player].map((p) => p.location.position)).toEqual([{ x: 74, y: 20 }, { x: 69, y: 6 }, { x: 71, y: 8 }]);
    expect(here.done).toEqual([["cached", "saver"], ["cached", "admin"], ["cached", "player"]]);
    const rebase = { rebase: { shiftX: 64, shiftY: 0, width: 42, height: 30 } };
    expect(here.sent).toEqual({ saver: [rebase], admin: [rebase], player: [rebase], away: [], closed: [rebase] });
  });
});

describe("a plain map saved on another node", () => {
  const make = withNames(NAMES, `${fn("function showMapSaveHere(")}\n${fn("async function mapSavedElsewhere(")}\nreturn mapSavedElsewhere;`);

  test("brings this node's copy up to date and reads it again, drops its unsaved edits, and shows its players the save", async () => {
    const here = node();
    const chunks = [{ chunkX: 3, chunkY: 4 }];
    await make(here)("w.json", { shiftX: 0, shiftY: 0, width: 40, height: 30, chunks });
    expect(here.done).toEqual([["sync", "w.json"], ["reloadMap", "w.json"], ["clearMapCache", "w.json"]]);
    expect([...here.editorEditHistory.keys()]).toEqual(["x"]);
    const bounds = { rebase: { shiftX: 0, shiftY: 0, width: 40, height: 30 } };
    expect(here.sent.saver).toEqual([bounds, { chunks }]);
    expect(here.sent.away).toEqual([]);
  });
});

describe("this node's copy of a map, from the asset server", () => {
  const code = fnOf(loader, "export async function syncMapFromAssetServer(").replace("export ", "").replace('await import("./checksums.ts")', "checksums");
  const make = withNames(["process", "serverFetch", "checksums", "getValidMapPath", "path"], `${code}\nreturn syncMapFromAssetServer;`);
  function asked(answer: { ok?: boolean; status?: number; body: any }, env: Record<string, string> = { ASSET_SERVER_URL: "http://assets" }) {
    const calls: any[] = [];
    const written: any[] = [];
    const sync = make({
      process: { env },
      serverFetch: async (url: string, init: any) => {
        calls.push([url, JSON.parse(init.body).checksums]);
        return { ok: answer.ok ?? true, status: answer.status ?? 200, json: async () => answer.body };
      },
      checksums: {
        calculateAllMapChecksums: () => ({ "w.json": "old" }),
        writeMapContent: (name: string, data: any) => { written.push([name, data]); return true; },
      },
      getValidMapPath: (name: string) => `/maps/${name.endsWith(".json") ? name : `${name}.json`}`,
      path,
    });
    return { sync, calls, written };
  }

  test("is fetched when it differs from the asset server's", async () => {
    const { sync, calls, written } = asked({ body: { success: true, outdatedMaps: [{ name: "a.json", data: { a: 1 } }, { name: "w.json", data: { w: 1 } }] } });
    expect(await sync("w")).toBe(true);
    expect(calls).toEqual([["http://assets/map-checksums", { "w.json": "old" }]]);
    expect(written).toEqual([["w.json", { w: 1 }]]);
  });

  test("is up to date when the asset server has no other copy of it", async () => {
    const { sync, written } = asked({ body: { success: true, outdatedMaps: [{ name: "a.json", data: {} }] } });
    expect(await sync("w.json")).toBe(false);
    expect(written).toEqual([]);
  });

  test("cannot be fetched from an asset server that refuses, or with none", async () => {
    await expect(asked({ ok: false, status: 401, body: {} }).sync("w")).rejects.toThrow("401");
    await expect(asked({ body: { success: false, error: "no" } }).sync("w")).rejects.toThrow("no");
    const none = asked({ body: { success: true, outdatedMaps: [] } }, {});
    expect(await none.sync("w")).toBe(false);
    expect(none.calls).toEqual([]);
  });
});

describe("live editing", () => {
  test("a tile edit reaches the admins editing the map here but its sender", () => {
    const here = node();
    const relay = { senderId: 9, mapName: "w.json", edits: [{ x: 1 }] };
    withNames(NAMES, `${fn("function tileEditsHere(")}\nreturn tileEditsHere;`)(here)("w", relay, "saver");
    expect(here.sent).toEqual({ saver: [], admin: [{ tiles: relay }], player: [], away: [], closed: [] });
  });

  test("a layer lock reaches the admins editing the map here but its sender", () => {
    const here = node();
    const relay = { mapName: "w", layerName: "ground", locked: true };
    withNames(NAMES, `${fn("function layerLockHere(")}\nreturn layerLockHere;`)(here)("w", relay, "saver");
    expect(here.sent).toEqual({ saver: [], admin: [{ lock: relay }], player: [], away: [], closed: [] });
  });
});

describe("news from another node", () => {
  function heard(here = node()) {
    const news: Record<string, (data: any) => unknown> = {};
    const calls: any[] = [];
    const given: Record<string, any> = {
      ...here,
      onPeerNews: (name: string, run: any) => { news[name] = run; },
      worldSavedHere: async (...args: any[]) => { calls.push(["world", ...args]); },
      mapSavedElsewhere: async (...args: any[]) => { calls.push(["map", ...args]); },
      tileEditsHere: (...args: any[]) => calls.push(["tiles", ...args]),
      layerLockHere: (...args: any[]) => calls.push(["lock", ...args]),
    };
    for (const name of ["world-saved", "map-saved", "editor-tile-edit", "editor-layer-lock"]) withNames(Object.keys(given), newsOf(name))(given);
    return { news, calls, here };
  }

  test("of a save is carried out here", async () => {
    const { news, calls } = heard();
    const chunks = [{ chunkX: 1, chunkY: 1 }];
    await news["world-saved"]({ world: "w", mapName: "w.json", changed: chunks, graveyards: ["g"], warps: [] });
    await news["world-saved"]({ world: "w", changed: [] });
    await news["map-saved"]({ mapName: "m.json", view: { shiftX: 32, width: 10, height: 9, chunks } });
    expect(calls).toEqual([
      ["world", { world: "w", mapName: "w.json", changed: chunks, graveyards: ["g"], warps: undefined }],
      ["world", { world: "w", mapName: "w", changed: [], graveyards: undefined, warps: undefined }],
      ["map", "m.json", { shiftX: 32, shiftY: 0, width: 10, height: 9, chunks }],
    ]);
  });

  test("of a save that names no map, or no chunks, is not", async () => {
    const { news, calls } = heard();
    await news["world-saved"]({ changed: [] });
    await news["world-saved"]({ world: "w" });
    await news["world-saved"](null);
    await news["map-saved"]({ view: { chunks: [] } });
    await news["map-saved"]({ mapName: "m" });
    await news["map-saved"]({ mapName: "m", view: {} });
    await news["map-saved"](null);
    expect(calls).toEqual([]);
  });

  test("of a live edit reaches the admins here, and is kept for a later editor while one is open on the map", async () => {
    const { news, calls, here } = heard();
    await news["editor-tile-edit"]({ map: "w", mapName: "w.json", senderId: 9, edits: [{ x: 1 }] });
    await news["editor-tile-edit"]({ map: "x", mapName: "x", senderId: 9, edits: [{ x: 2 }] });
    await news["editor-layer-lock"]({ map: "w", mapName: "w", layerName: "ground", locked: true });
    expect(calls).toEqual([
      ["tiles", "w", { senderId: 9, mapName: "w.json", edits: [{ x: 1 }] }],
      ["tiles", "x", { senderId: 9, mapName: "x", edits: [{ x: 2 }] }],
      ["lock", "w", { mapName: "w", layerName: "ground", locked: true }],
    ]);
    // "w" has an editor open here: the edit is kept, with no sender of this node; "x" has none: nothing is kept
    expect(here.editorEditHistory.get("w.json")).toEqual([{ senderId: 1, mapName: "w.json", edits: [1] }, { senderId: -1, mapName: "w.json", edits: [{ x: 1 }] }]);
    expect(here.editorEditHistory.get("x")).toEqual([{ senderId: 2, mapName: "x", edits: [2] }]);
  });

  test("of a live edit that names no map, or holds no edits, is not", async () => {
    const { news, calls } = heard();
    await news["editor-tile-edit"]({ mapName: "w", edits: [] });
    await news["editor-tile-edit"]({ map: "w", edits: "no" });
    await news["editor-tile-edit"](null);
    await news["editor-layer-lock"]({ layerName: "ground", locked: true });
    await news["editor-layer-lock"]({ map: "w", locked: true });
    await news["editor-layer-lock"](null);
    expect(calls).toEqual([]);
  });
});

test("the map editor's saves and live edits are told to the region", () => {
  const save = caseOf("SAVE_MAP");
  expect(save).toContain(`void tellPeers("world-saved", save);`);
  expect(save).toContain("await worldSavedHere(save, wt.data.id);");
  expect(save).toContain("showMapSaveHere(saveData.mapName, view, wt.data.id);");
  expect(save).toContain(`void tellPeers("map-saved", { mapName: saveData.mapName, view });`);
  expect(save).not.toContain("filterPlayersByMap(");
  expect(save).not.toContain("refreshWorldMap(");

  const tiles = caseOf("EDITOR_TILE_EDIT");
  expect(tiles).toContain("tileEditsHere(currentPlayer.location.map, relay, wt.data.id);");
  expect(tiles).toContain(`void tellPeers("editor-tile-edit", { map: currentPlayer.location.map, ...relay });`);
  expect(tiles).not.toContain("filterPlayersByMap(");

  const lock = caseOf("EDITOR_LAYER_LOCK");
  expect(lock).toContain("layerLockHere(currentPlayer.location.map, relay, wt.data.id);");
  expect(lock).toContain(`void tellPeers("editor-layer-lock", { map: currentPlayer.location.map, ...relay });`);
  expect(lock).not.toContain("filterPlayersByMap(");
});

describe("/reloadmap", () => {
  // Each node of the region reads the map again from its own copy, and its players on it load it again (peer news
  // "map-reloaded").
  function reloading(read: any = { compressed: "new", data: { layers: ["new"] } }) {
    const sent: any[] = [];
    const maps: any[] = [{ name: "m.json", compressed: "old", data: { layers: ["old"] } }];
    const given = {
      maps,
      reloadMap: async (name: string) => { sent.push(["reloadMap", name]); return read; },
      takeInMapChange: async (change: any) => { sent.push(["takeIn", change]); },
    };
    const reloadMapHere = withNames(Object.keys(given), `${fn("async function reloadMapHere(")}\nreturn reloadMapHere;`)(given);
    return { reloadMapHere, sent, maps };
  }

  test("reads the map again here, and this node's players on it load it again", async () => {
    const { reloadMapHere, sent, maps } = reloading();
    expect(await reloadMapHere("m")).toBe(true);
    expect(maps[0]).toEqual({ name: "m.json", compressed: "new", data: { layers: ["new"] } });
    // takeInMapChange forgets the map's caches here and has its players load it again (asset-server-changes.test.ts)
    expect(sent).toEqual([["reloadMap", "m"], ["takeIn", { name: "m", added: false }]]);
  });

  test("of a map this node does not hold, or one that could not be read, does nothing here", async () => {
    const none = reloading();
    expect(await none.reloadMapHere("nope")).toBe(false);
    expect(none.sent).toEqual([]);
    const unread = reloading(null);
    expect(await unread.reloadMapHere("m")).toBe(false);
    expect(unread.sent).toEqual([["reloadMap", "m"]]);
    expect(unread.maps[0].compressed).toBe("old");
  });

  test("is told to the region, and one from another node is carried out here", async () => {
    const command = cut(receiver, 'case "RELOADMAP": {', /\n {12}break;\r?\n {10}\}/);
    expect(command).toContain("await reloadMapHere(mapName)");
    expect(command).toContain(`void tellPeers("map-reloaded", { map: mapName });`);
    expect(command).not.toContain("filterPlayersByMap(");

    let news: (data: any) => unknown = () => {};
    const reloaded: string[] = [];
    withNames(["onPeerNews", "reloadMapHere"], newsOf("map-reloaded"))({
      onPeerNews: (name: string, run: any) => { if (name === "map-reloaded") news = run; },
      reloadMapHere: async (name: string) => { reloaded.push(name); return true; },
    });
    await news({ map: "m" });
    await news({ map: "" });
    await news({});
    await news(null);
    expect(reloaded).toEqual(["m"]);
  });
});
