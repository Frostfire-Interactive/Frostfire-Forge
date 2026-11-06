import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Cluster mode: every node spawns the gathering nodes of its own blocks, from the areas its spawner was given
// (systems/gathering/index.ts). The areas are shared (the "gathering_areas" table cache); a save in the editor on one
// node is told to the region's other nodes (peer news "gathering-areas"), and each gives its spawner the areas again
// and tells its own open editors. index.ts loads the whole engine: these read its source.

const source = readFileSync(new URL("../systems/gathering/index.ts", import.meta.url), "utf8");
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

function world(reloadFails = false) {
  const sent: Record<string, any[]> = { boss: [], builder: [], player: [] };
  const players = {
    boss: { id: "boss", wt: { id: "boss" }, isAdmin: true },
    builder: { id: "builder", wt: { id: "builder" }, permissions: ["tools.gathering_editor"] },
    player: { id: "player", wt: { id: "player" } },
  };
  let reloads = 0;
  const errors: string[] = [];
  return {
    sent,
    reloads: () => reloads,
    errors,
    reloadAreas: async () => {
      reloads++;
      if (reloadFails) throw new Error("no database");
    },
    playerCache: { list: () => players },
    packetManager: { gatheringEditorUpdated: (data: any) => ({ updated: data.by }) },
    send: (wt: any, packet: any) => sent[wt.id].push(packet),
    editor: { mayHaveEditorOpen: (p: any) => !!p.isAdmin || (p.permissions ?? []).length > 0 },
    log: { error: (message: string) => errors.push(message) },
  };
}

describe("the areas changed", () => {
  const make = withNames(["reloadAreas", "playerCache", "packetManager", "send", "editor", "log"], fn("async function areasChangedHere(") + "\nreturn areasChangedHere;");

  test("the spawner is given the areas again, and the open editors but the saver's are told", async () => {
    const here = world();
    await make(here)("boss", "boss");
    expect(here.reloads()).toBe(1);
    expect(here.sent).toEqual({ boss: [], builder: [{ updated: "boss" }], player: [] });
  });

  test("from another node, every open editor here is told", async () => {
    const here = world();
    await make(here)("boss");
    expect(here.sent).toEqual({ boss: [{ updated: "boss" }], builder: [{ updated: "boss" }], player: [] });
  });

  test("a reload that fails is logged, and the editors are told all the same", async () => {
    const here = world(true);
    await make(here)("boss");
    expect(here.errors).toHaveLength(1);
    expect(here.sent.builder).toEqual([{ updated: "boss" }]);
  });
});

describe("news from another node", () => {
  const install = withNames(["onPeerNews", "areasChangedHere"], cut(`onPeerNews("gathering-areas",`, /\n}\);\r?\n/) + "\n});");

  test("gives the areas again here, saying who saved them", async () => {
    let news: (data: any) => unknown = () => {};
    const changed: any[] = [];
    install({
      onPeerNews: (name: string, run: any) => { if (name === "gathering-areas") news = run; },
      areasChangedHere: async (...args: any[]) => { changed.push(args); },
    });
    await news({ by: "boss" });
    await news({});
    await news(null);
    expect(changed).toEqual([["boss"], [""], [""]]);
  });
});

test("a change in the editor here is carried out here and told to the region", () => {
  const body = fn("export async function handleEditorPacket(");
  expect(body).toContain("await areasChangedHere(admin.username, admin.id);");
  expect(body).toContain(`void tellPeers("gathering-areas", { by: admin.username });`);
  expect(body).not.toContain("playerCache.list()");
});
