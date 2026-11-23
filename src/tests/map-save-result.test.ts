import { describe, expect, test } from "bun:test";
import { cleanChests, cleanPortals } from "../systems/mapobjects";
import { receiverSource } from "./receiver-source";

// The SAVE_MAP case of handlers/editors.ts, run with stand-ins for what it calls (the receiver cannot be imported).
const receiver = receiverSource();
const transpiler = new Bun.Transpiler({ loader: "ts" });

function cut(source: string, start: string, until: RegExp): string {
  const at = source.indexOf(start);
  if (at < 0) throw new Error(`Not found in the source: ${start}`);
  const rest = source.slice(at);
  const end = rest.search(until);
  if (end < 0) throw new Error(`No end found for: ${start}`);
  return rest.slice(0, end);
}
const fn = (header: string) => cut(receiver, header, /\n}\r?\n/) + "\n}";
const caseOf = (name: string) => cut(receiver, `case "${name}": {`, /\n {8}break;\r?\n {6}\}/);
const withNames = (names: string[], code: string): ((given: Record<string, any>) => any) =>
  new Function(`"use strict";\n${transpiler.transformSync(`function make({ ${names.join(", ")} }: any) { ${code} }`)}\nreturn make;`)();

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function node(over: Record<string, any> = {}) {
  const sent: any[] = [];
  const posted: string[] = [];
  const world: any = { width: 10, height: 10, properties: {} };
  const reload = async (name: string) => ({ name, data: {} });
  const given: Record<string, any> = {
    currentPlayer: { username: "admin" },
    wt: { data: { id: "saver" } },
    canSaveMaps: async () => true,
    sendPacket: (_wt: any, packet: any) => sent.push(packet),
    packetManager: {
      notify: (d: any) => ({ notify: d.message }),
      mapSaveResult: (d: any) => ({ result: d }),
    },
    cleanChests,
    cleanPortals,
    getWorldMap: (name: string) => (name.replace(".json", "") === "w" ? world : undefined),
    startSaveHere: async () => ({ tell: () => {}, end: () => {} }),
    zonesForSave: () => ({ zones: undefined }),
    log: quiet,
    process: { env: {} },
    serverFetch: async (url: string) => {
      posted.push(url.replace(/^.*\//, ""));
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ success: true, changed: [] }) };
    },
    assetCache: {
      get: async (key: string) => (key === "maps" ? [{ name: "m.json", data: { width: 10, height: 10, tilewidth: 32, tileheight: 32 } }] : [{ name: "w.json" }, { name: "m.json" }]),
      add: async () => {},
    },
    worldSavedHere: async () => {},
    editorEditHistory: new Map(),
    sizeAfterSave: () => ({ width: 10, height: 10 }),
    saveMapProperties: async () => {},
    respawnMapChests: () => {},
    applyChunksWithRebase: () => null,
    saveMapChunks: async () => {},
    syncMapFromAssetServer: async () => true,
    clearMapCache: () => {},
    showMapSaveHere: () => {},
    zonesSavedHere: async () => {},
    assetloaderModule: { reloadMap: reload },
    ...over,
  };
  return { given, sent, posted, world };
}

async function save(data: any, over: Record<string, any> = {}) {
  const here = node(over);
  const body = `${fn("function cleanMapObjects(")}\n${caseOf("SAVE_MAP")}`
    .replaceAll('await import("../../modules/assetloader")', "assetloaderModule");
  const caseText = body.slice(body.indexOf('case "SAVE_MAP"'));
  const helper = body.slice(0, body.indexOf('case "SAVE_MAP"'));
  const names = [...Object.keys(here.given), "data"];
  const run = withNames(names, `${helper}\nreturn async () => { switch ("SAVE_MAP") { ${caseText}\nbreak;\n}\n} };`);
  await run({ ...here.given, data })();
  const results = here.sent.filter((p) => p.result).map((p) => p.result);
  const notices = here.sent.filter((p) => p.notify).map((p) => p.notify);
  return { results, notices, posted: here.posted, world: here.world };
}

const chest = (name: string) => ({ name, lootTableId: 1, resetMinutes: 30, position: { x: 0, y: 0 }, layer: null });

test("MAP_SAVE_RESULT is a packet type, and carries the saveId as it came", async () => {
  const { packetManager } = await import("../socket/packet_manager");
  const { packetTypes } = await import("../socket/types");
  expect(packetTypes.MAP_SAVE_RESULT).toBe("MAP_SAVE_RESULT");
  const decode = (packets: any[]) => JSON.parse(new TextDecoder().decode(packets[0]));
  expect(decode(packetManager.mapSaveResult({ saveId: 4, mapName: "m.json", ok: true }))).toEqual({ type: "MAP_SAVE_RESULT", data: { saveId: 4, mapName: "m.json", ok: true } });
  expect(decode(packetManager.mapSaveResult({ saveId: undefined, mapName: "m.json", ok: false })).data).toEqual({ mapName: "m.json", ok: false });
});

describe("SAVE_MAP answers the saver with MAP_SAVE_RESULT", () => {
  test("refused for want of permission (asked as the map object pickers ask)", async () => {
    const { results, notices } = await save({ saveId: 7, mapName: "m.json", chunks: [] }, { canSaveMaps: async () => false });
    expect(results).toEqual([{ saveId: 7, mapName: "m.json", ok: false }]);
    expect(notices).toEqual(["You do not have permission to save map changes."]);
  });

  test("refused for a bad list of chests", async () => {
    const { results } = await save({ saveId: 8, mapName: "m.json", chunks: [], chests: [chest("A"), chest("A")] });
    expect(results).toEqual([{ saveId: 8, mapName: "m.json", ok: false }]);
  });

  describe("of a world", () => {
    test("refused for bad zones", async () => {
      const { results } = await save({ saveId: 1, mapName: "w.json", chunks: [{}] }, { zonesForSave: () => ({ error: "bad" }) });
      expect(results).toEqual([{ saveId: 1, mapName: "w.json", ok: false }]);
    });

    test("with nothing to save: nothing is sent to the asset server, and the save stands", async () => {
      const { results, notices, posted } = await save({ saveId: 2, mapName: "w.json", chunks: [], graveyards: [], warps: [] });
      expect(posted).toEqual([]);
      expect(notices).toEqual(["Nothing to save."]);
      expect(results).toEqual([{ saveId: 2, mapName: "w.json", ok: true }]);
    });

    test("an empty list of chests or portals for a world that has none is nothing to save", async () => {
      const { results, notices, posted } = await save({ saveId: 3, mapName: "w.json", chunks: [], chests: [], dungeonPortals: [] });
      expect(posted).toEqual([]);
      expect(notices).toEqual(["Nothing to save."]);
      expect(results).toEqual([{ saveId: 3, mapName: "w.json", ok: true }]);
    });

    test("an empty list of chests for a world that has chests removes them", async () => {
      const here = await save({ saveId: 4, mapName: "w.json", chunks: [], chests: [] }, {
        getWorldMap: (name: string) => (name.replace(".json", "") === "w" ? { width: 10, height: 10, properties: { chests: [chest("A")] } } : undefined),
      });
      expect(here.posted).toEqual(["save-map-properties"]);
      expect(here.results).toEqual([{ saveId: 4, mapName: "w.json", ok: true }]);
    });

    test("saved", async () => {
      const { results, posted } = await save({ saveId: 5, mapName: "w.json", chunks: [{ chunkX: 0, chunkY: 0 }] });
      expect(posted).toEqual(["save-map-chunks"]);
      expect(results).toEqual([{ saveId: 5, mapName: "w.json", ok: true }]);
    });

    test("failed at the asset server", async () => {
      const { results } = await save({ saveId: 6, mapName: "w.json", chunks: [{}] }, {
        serverFetch: async () => ({ ok: false, status: 500, json: async () => ({ error: "down" }) }),
      });
      expect(results).toEqual([{ saveId: 6, mapName: "w.json", ok: false }]);
    });
  });

  describe("of a plain map", () => {
    test("refused for bad zones", async () => {
      const { results } = await save({ saveId: 11, mapName: "m.json", chunks: [] }, { zonesForSave: () => ({ error: "bad" }) });
      expect(results).toEqual([{ saveId: 11, mapName: "m.json", ok: false }]);
    });

    test("saved", async () => {
      const { results, posted } = await save({ saveId: 12, mapName: "m.json", chunks: [{ chunkX: 0, chunkY: 0 }] });
      expect(posted).toEqual(["save-map-chunks"]);
      expect(results).toEqual([{ saveId: 12, mapName: "m.json", ok: true }]);
    });

    test("failed", async () => {
      const { results } = await save({ saveId: 13, mapName: "m.json", chunks: [] }, { serverFetch: async () => { throw new Error("down"); } });
      expect(results).toEqual([{ saveId: 13, mapName: "m.json", ok: false }]);
    });
  });

  describe("a check before the save that throws is answered as a failed save, once", () => {
    const down = async () => { throw new Error("down"); };
    test("the permission check", async () => {
      const { results, posted, notices } = await save({ saveId: 21, mapName: "m.json", chunks: [{}] }, { canSaveMaps: down });
      expect(results).toEqual([{ saveId: 21, mapName: "m.json", ok: false }]);
      expect(posted).toEqual([]);
      expect(notices).toEqual(["Error saving map changes: down"]);
    });

    test("the start of a world save", async () => {
      const { results, posted } = await save({ saveId: 22, mapName: "w.json", chunks: [{}] }, { startSaveHere: down });
      expect(results).toEqual([{ saveId: 22, mapName: "w.json", ok: false }]);
      expect(posted).toEqual([]);
    });

    test("the start of a plain map save", async () => {
      const { results, posted } = await save({ saveId: 23, mapName: "m.json", chunks: [{}] }, { startSaveHere: down });
      expect(results).toEqual([{ saveId: 23, mapName: "m.json", ok: false }]);
      expect(posted).toEqual([]);
    });
  });

  test("a save without a saveId (an older client) is answered too, with none", async () => {
    const { results } = await save({ mapName: "m.json", chunks: [] });
    expect(results).toEqual([{ saveId: undefined, mapName: "m.json", ok: true }]);
  });
});
