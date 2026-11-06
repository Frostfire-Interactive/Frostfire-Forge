import { describe, expect, test } from "bun:test";
import { receiverSource } from "./receiver-source";

// Cluster mode: an NPC added, saved, moved or deleted in the editor on one node is shown to the players of its map on
// every node of the region (peer news "npc"), and their map markers are sent again when it touched an inn or a shop.
// The list itself is shared (the "npcs" cache key), and the other nodes are told it was written (services/assetCache.ts).
// receiver.ts cannot be imported: these read its source.

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
  const sent: Record<string, any[]> = { p1: [], p2: [], q1: [] };
  const players: Record<string, any> = {
    p1: { id: "p1", map: "m", wt: { id: "p1", readyState: 1 } },
    p2: { id: "p2", map: "m", wt: { id: "p2", readyState: 1 } },
    q1: { id: "q1", map: "n", wt: { id: "q1", readyState: 1 } },
  };
  let markers = 0;
  return {
    sent,
    markers: () => markers,
    filterPlayersByMap: (map: string) => Object.values(players).filter((p) => p.map === map),
    packetManager: { npcUpdated: (npc: any) => ({ updated: npc.id }), npcRemoved: (id: number) => ({ removed: id }) },
    sendPacket: (wt: any, packet: any) => sent[wt.id].push(packet),
    resendMapMarkers: async () => { markers++; },
  };
}

describe("an NPC change shown here", () => {
  const make = withNames(["filterPlayersByMap", "packetManager", "sendPacket", "resendMapMarkers"], fn("function npcChangeHere(") + "\nreturn npcChangeHere;");

  test("an NPC added or changed, to the players of its map", () => {
    const world = here();
    make(world)({ map: "m", updated: { id: 5 } });
    expect(world.sent).toEqual({ p1: [{ updated: 5 }], p2: [{ updated: 5 }], q1: [] });
    expect(world.markers()).toBe(0);
  });

  test("an NPC deleted, and the markers sent again when it was an inn or a shop", () => {
    const world = here();
    make(world)({ map: "m", removed: 5, markers: true });
    expect(world.sent).toEqual({ p1: [{ removed: 5 }], p2: [{ removed: 5 }], q1: [] });
    expect(world.markers()).toBe(1);
  });
});

describe("an NPC change from another node", () => {
  const install = withNames(["onPeerNews", "npcChangeHere"], cut(receiver, `onPeerNews("npc",`, /\n}\);\r?\n/) + "\n});");
  function heard() {
    let news: (data: any) => unknown = () => {};
    const shown: any[] = [];
    install({
      onPeerNews: (name: string, run: any) => { if (name === "npc") news = run; },
      npcChangeHere: (change: any) => shown.push(change),
    });
    return { news, shown };
  }

  test("is shown to this node's players of the map", () => {
    const { news, shown } = heard();
    news({ map: "m", updated: { id: 5 } });
    news({ map: "m", removed: 6, markers: true });
    expect(shown).toEqual([
      { map: "m", updated: { id: 5 }, markers: false },
      { map: "m", removed: 6, markers: true },
    ]);
  });

  test("without a map, or with neither an NPC nor an id, shows nothing", () => {
    const { news, shown } = heard();
    news({ updated: { id: 5 } });
    news({ map: "m" });
    news({ map: "m", removed: "x" });
    expect(shown).toEqual([]);
  });
});

describe("what tells the other nodes", () => {
  test("npcChanged shows it here and tells the region", () => {
    const body = fn("export function npcChanged(");
    expect(body).toContain("npcChangeHere(change)");
    expect(body).toContain(`tellPeers("npc", change)`);
  });

  test("every edit of an NPC", () => {
    for (const name of ["ADD_NPC", "SAVE_NPC", "MOVE_NPC", "DELETE_NPC"]) {
      const one = cut(receiver, `case "${name}": {`, /\n {8}break;\r?\n {6}\}/);
      expect(one).toContain("npcChanged(");
      expect(one).not.toContain("filterPlayersByMap(");
    }
  });
});
