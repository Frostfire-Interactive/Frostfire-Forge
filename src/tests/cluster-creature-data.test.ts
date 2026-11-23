import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../systems/creatures/index.ts", import.meta.url), "utf8");
const transpiler = new Bun.Transpiler({ loader: "ts" });

function cut(start: string, until: RegExp): string {
  const at = source.indexOf(start);
  if (at < 0) throw new Error(`Not found in the source: ${start}`);
  const rest = source.slice(at);
  const end = rest.search(until);
  if (end < 0) throw new Error(`No end found for: ${start}`);
  return rest.slice(0, end);
}
const fn = (header: string) => cut(header, /\n}\r?\n/) + "\n}";
const withNames = (names: string[], code: string): ((given: Record<string, any>) => any) =>
  new Function(`"use strict";\n${transpiler.transformSync(`function make({ ${names.join(", ")} }: any) { ${code} }`)}\nreturn make;`)();
const newsOf = (name: string) => cut(`onPeerNews("${name}", `, /\n\}\);/) + "\n});";

describe("a creature editor save", () => {
  test("every change the editor makes is taken here and told to the region", () => {
    const editor = fn("export async function handleEditorPacket(");
    expect(editor).not.toContain("applyDataChange(");
    expect(editor.split("await dataChanged(").length - 1).toBe(13);
  });

  test("is taken here first, then told", async () => {
    const order: any[] = [];
    const dataChanged = withNames(["applyDataChange", "tellPeers"], `${fn("async function dataChanged(")}\nreturn dataChanged;`)({
      applyDataChange: async (change: any) => { await Promise.resolve(); order.push(["here", change]); },
      tellPeers: async (name: string, data: any) => { order.push(["told", name, data]); return true; },
    });
    await dataChanged({ templateIds: [4] });
    expect(order).toEqual([["here", { templateIds: [4] }], ["told", "creature-data", { templateIds: [4] }]]);
  });

  test("one told by another node is taken here, with only its lists of ids", async () => {
    let news: (data: any) => unknown = () => {};
    const taken: any[] = [];
    const given = {
      onPeerNews: (name: string, run: any) => { if (name === "creature-data") news = run; },
      applyDataChange: async (change: any) => { taken.push(change); },
    };
    withNames(Object.keys(given), `${fn("function creatureChangeOf(")}\n${newsOf("creature-data")}`)(given);
    await news({ templateIds: [1, "2"], spawnIds: [3], patrolPathIds: [5], extra: true });
    await news({ templateIds: "x", spawnIds: [null, "nope", 6] });
    await news(null);
    expect(taken).toEqual([
      { templateIds: [1, 2], spawnIds: [3], patrolPathIds: [5] },
      { templateIds: [], spawnIds: [6], patrolPathIds: [] },
      { templateIds: [], spawnIds: [], patrolPathIds: [] },
    ]);
  });
});

describe("a creature data change", () => {
  test("leaves a dungeon copy's creatures alone: nothing would respawn them", async () => {
    const despawned: number[] = [];
    const log = { info: () => {} };
    const copy: any = { id: 1, templateId: 4, spawnId: 0, map: "crypt~a1", state: "idle" };
    const copyBusy: any = { id: 2, templateId: 4, spawnId: 0, map: "crypt~a1", state: "combat" };
    const open: any = { id: 3, templateId: 4, spawnId: 7, map: "crypt", state: "idle" };
    const given = {
      repository: { loadIntoCache: async () => {} },
      buildSpawnerData: async () => ({ spawns: new Map() }),
      refreshNavGrids: async () => {},
      spawner: { updateData: () => {}, getSpawn: () => undefined, despawn: (id: number) => despawned.push(id) },
      registry: { all: () => [copy, copyBusy, open] },
      AIState: { DEAD: "dead" },
      isOutOfCombat: (c: any) => c.state === "idle",
      isCopyKey: (map: string) => map.includes("~"),
      localCreatureCount: () => 0,
      log,
    };
    let spawnCache: any;
    const run = withNames([...Object.keys(given), "setSpawnCache"], `${fn("export async function applyDataChange(").replace("export async function applyDataChange", "async function applyDataChange").replace("spawnCache = [...data.spawns.values()];", "setSpawnCache([...data.spawns.values()]);").replace("refreshNavGrids(spawnCache)", "refreshNavGrids()")}\nreturn applyDataChange;`)({ ...given, setSpawnCache: (v: any) => { spawnCache = v; } });
    await run({ templateIds: [4] });
    expect(despawned).toEqual([3]);
    expect(copyBusy.pendingRefresh).toBeUndefined();
    expect(open.pendingRefresh).toBeUndefined();
    expect(spawnCache).toEqual([]);
  });
});
