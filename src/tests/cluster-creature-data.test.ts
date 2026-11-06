import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Cluster mode: every node spawns and runs the creatures of its own blocks, from the creature tables its spawner was
// given (systems/creatures/index.ts, applyDataChange). A save in the creature editor on one node is told to the
// region's other nodes (peer news "creature-data"): each loads the tables again and respawns its own creatures the
// change touches. index.ts loads the whole engine: these read its source.

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
