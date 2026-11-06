import { describe, expect, test } from "bun:test";
import { receiverSource } from "./receiver-source";

// Cluster mode: a particle saved in the particle editor on one node is sent to every player online in the region; a
// rename reaches the particle NPCs of the maps every node holds; a test is shown to the players of the map on every
// node (peer news "particle" and "test-particle"). The particle list itself is shared (the "particles" cache key).
// socket/handlers/editors.ts cannot be imported: these read its source.

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

function here() {
  const sent: Record<string, any[]> = { a: [], b: [], c: [] };
  const players: Record<string, any> = {
    a: { map: "m", wt: { id: "a", readyState: 1 } },
    b: { map: "n", wt: { id: "b", readyState: 1 } },
    c: { map: "m", wt: { id: "c", readyState: 3 } },
  };
  const mapNpcs = [{ particles: "smoke, fire" }, { particles: "fire" }, { particles: null }];
  return {
    sent,
    mapNpcs,
    playerCache: { list: () => players },
    filterPlayersByMap: (map: string) => Object.values(players).filter((p) => p.map === map),
    sendPacket: (wt: any, packet: any) => sent[wt.id].push(packet),
    packetManager: {
      particleUpdated: (particle: any) => ({ updated: particle.name }),
      custom: (packet: any) => ({ custom: packet }),
    },
    npcSystem: { getMapNpcs: () => mapNpcs },
    renameInList: (list: string, from: string, to: string) => list.split(",").map((x) => (x.trim() === from ? to : x.trim())).join(","),
  };
}

describe("shown here", () => {
  test("a saved particle, to every player whose connection is open", () => {
    const world = here();
    withNames(["playerCache", "sendPacket", "packetManager"], fn("function particleSavedHere(") + "\nreturn particleSavedHere;")(world)({ name: "fire" });
    expect(world.sent).toEqual({ a: [{ updated: "fire" }], b: [{ updated: "fire" }], c: [] });
  });

  test("a rename, on the particle NPCs of the maps held here", () => {
    const world = here();
    const count = withNames(["npcSystem", "renameInList"], fn("function particleRenamedHere(") + "\nreturn particleRenamedHere;")(world)("smoke", "mist");
    expect(count).toBe(1);
    expect(world.mapNpcs.map((n) => n.particles)).toEqual(["mist,fire", "fire", null]);
  });

  test("a test, to the players of the map", () => {
    const world = here();
    withNames(["filterPlayersByMap", "sendPacket", "packetManager"], fn("function testParticleHere(") + "\nreturn testParticleHere;")(world)("m", { testType: "npc", particle: "fire" });
    expect(world.sent.a).toEqual([{ custom: { type: "TEST_PARTICLE_EVENT", data: { testType: "npc", particle: "fire" } } }]);
    expect(world.sent.b).toEqual([]);
  });
});

describe("news from another node", () => {
  function heard() {
    const news: Record<string, (data: any) => unknown> = {};
    const shown: any[] = [];
    const given = {
      onPeerNews: (name: string, run: any) => { news[name] = run; },
      particleSavedHere: (particle: any) => shown.push(["saved", particle.name]),
      particleRenamedHere: (from: string, to: string) => shown.push(["renamed", from, to]),
      testParticleHere: (map: string, event: any) => shown.push(["test", map, event]),
    };
    withNames(Object.keys(given), cut(receiver, `onPeerNews("particle",`, /\n}\);\r?\n/) + "\n});")(given);
    withNames(Object.keys(given), cut(receiver, `onPeerNews("test-particle",`, /\n}\);\r?\n/) + "\n});")(given);
    return { news, shown };
  }

  test("is carried out here", () => {
    const { news, shown } = heard();
    news.particle({ saved: { name: "fire" } });
    news.particle({ renamed: { from: "smoke", to: "mist" } });
    news["test-particle"]({ map: "m", event: { testType: "npc" } });
    expect(shown).toEqual([["saved", "fire"], ["renamed", "smoke", "mist"], ["test", "m", { testType: "npc" }]]);
  });

  test("that is incomplete is not", () => {
    const { news, shown } = heard();
    news.particle({ saved: { nameless: true } });
    news.particle({ renamed: { from: "smoke" } });
    news.particle(null);
    news["test-particle"]({ event: {} });
    news["test-particle"]({ map: "m" });
    expect(shown).toEqual([]);
  });
});

test("each change is told to the region", () => {
  expect(caseOf("SAVE_PARTICLE")).toContain(`void tellPeers("particle", { saved: updatedParticleData });`);
  expect(caseOf("SAVE_PARTICLE")).not.toContain("playerCache.list()");
  expect(caseOf("RENAME_PARTICLE")).toContain(`void tellPeers("particle", { renamed: { from: oldName, to: newName } });`);
  expect(caseOf("RENAME_PARTICLE")).not.toContain("getMapNpcs()");
  expect(caseOf("TEST_PARTICLE")).toContain(`void tellPeers("test-particle", { map: currentPlayer.location.map, event });`);
  expect(caseOf("TEST_PARTICLE")).not.toContain("filterPlayersByMap(");
});
