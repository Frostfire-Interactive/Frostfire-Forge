import { describe, expect, test } from "bun:test";
import { receiverSource } from "./receiver-source";

// Cluster mode: a save in the map editor's Sounds, Footprints or Fishing tab is sent to every player online in the
// region, not only on the node it was saved on (peer news "tile-data"). The fishing tiles are read again first on
// each node: a cast is worked out from what the node holds. socket/handlers/editors.ts cannot be imported: these
// read its source.

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
const withNames = (names: string[], code: string): ((given: Record<string, any>) => any) =>
  new Function(`"use strict";\n${transpiler.transformSync(`function make({ ${names.join(", ")} }: any) { ${code} }`)}\nreturn make;`)();

function here() {
  const sent: Record<string, any[]> = { a: [], b: [] };
  let reads = 0;
  return {
    sent,
    reads: () => reads,
    playerCache: { list: () => ({ a: { wt: { id: "a" } }, b: { wt: { id: "b" } }, gone: {} }) },
    sendPacket: (wt: any, packet: any) => sent[wt.id].push(packet),
    packetManager: {
      tileSounds: (data: any) => ({ sounds: data.tilesets }),
      tileFootprints: (data: any) => ({ footprints: data.tilesets }),
      fishingTiles: (data: any) => ({ fishing: data.tilesets }),
    },
    fishing: {
      refreshTiles: async () => { reads++; },
      publicTiles: () => ({ grass: [reads] }),
    },
  };
}

describe("the tiles sent here", () => {
  const make = withNames(["playerCache", "sendPacket", "packetManager", "fishing"], fn("async function tileDataHere(") + "\nreturn tileDataHere;");

  test("tile sounds and footprints, as saved, to every player online", async () => {
    const world = here();
    await make(world)({ kind: "sounds", tilesets: { grass: { 1: "step" } } });
    await make(world)({ kind: "footprints", tilesets: { sand: {} } });
    expect(world.sent.a).toEqual([{ sounds: { grass: { 1: "step" } } }, { footprints: { sand: {} } }]);
    expect(world.sent.b).toEqual(world.sent.a);
    expect(world.reads()).toBe(0);
  });

  test("the fishing tiles, read again first", async () => {
    const world = here();
    await make(world)({ kind: "fishing" });
    expect(world.reads()).toBe(1);
    expect(world.sent.a).toEqual([{ fishing: { grass: [1] } }]);
  });
});

describe("news from another node", () => {
  const install = withNames(["onPeerNews", "tileDataHere"], cut(receiver, `onPeerNews("tile-data",`, /\n}\);\r?\n/) + "\n});");
  function heard() {
    let news: (data: any) => unknown = () => {};
    const shown: any[] = [];
    install({
      onPeerNews: (name: string, run: any) => { if (name === "tile-data") news = run; },
      tileDataHere: async (change: any) => { shown.push(change); },
    });
    return { news, shown };
  }

  test("is sent to this node's players", async () => {
    const { news, shown } = heard();
    await news({ kind: "sounds", tilesets: { grass: {} } });
    await news({ kind: "footprints", tilesets: { sand: {} } });
    await news({ kind: "fishing", tilesets: { ignored: [] } });
    expect(shown).toEqual([
      { kind: "sounds", tilesets: { grass: {} } },
      { kind: "footprints", tilesets: { sand: {} } },
      { kind: "fishing" },
    ]);
  });

  test("of another kind, or without the tiles, sends nothing", async () => {
    const { news, shown } = heard();
    await news({ kind: "maps", tilesets: {} });
    await news({ kind: "sounds" });
    await news({ kind: "footprints", tilesets: [] });
    await news(null);
    expect(shown).toEqual([]);
  });
});

test("each save sends the tiles to the region", () => {
  expect(fn("async function tileDataChanged(")).toContain(`tellPeers("tile-data", change)`);
  for (const [start, kind] of [['case "SAVE_TILE_SOUNDS": {', "sounds"], ['case "SAVE_TILE_FOOTPRINTS": {', "footprints"], ['case "FISHING_EDITOR_SAVE": {', "fishing"]]) {
    const body = cut(receiver, start, /\n {8}break;\r?\n {6}\}/);
    expect(body).toContain(`tileDataChanged({ kind: "${kind}"`);
    expect(body).not.toContain("playerCache.list()");
  }
});
