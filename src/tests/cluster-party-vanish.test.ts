import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { receiverSource } from "./receiver-source";

// Cluster mode: a vanished (or stealthed) player is shown to their party. A member on another node sees them as a
// mirror, which checks who is shown it only when it enters a view or its hidden flag flips (cluster/kinds/players.ts).
// So a party change of the viewer (a join, a leave, a kick, a disband) must show or hide the hidden mirrors already in
// its view. receiver.ts cannot be imported: these read its source.

const receiver = receiverSource();
const social = readFileSync(join(import.meta.dir, "..", "socket", "handlers", "social.ts"), "utf8");
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

function viewing(mirrors: any[], viewer: any = {}, locals: any[] = []) {
  const mirrorPlayers = new Map(mirrors.map((m) => [m.id, m]));
  const held = new Map<string, any>(locals.map((l) => [l.id, l]));
  const playerCache = { get: (id: string) => held.get(id) };
  const spawnBatchQueue = new Map<string, Map<string, any>>();
  const despawnBatchQueue = new Map<string, Set<string>>();
  const p = { id: "p", username: "pat", wt: {}, party: [] as string[], aoi: { playersInAOI: new Set([...mirrors, ...locals].map((m) => m.id)) }, ...viewer };
  held.set(p.id, p);
  const given = {
    mirrorPlayers,
    playerCache,
    spawnBatchQueue,
    despawnBatchQueue,
    // as socket/aoi.ts
    canSee: (v: any, o: any) => !o.isStealth && !o.isVanished || !!v.isAdmin || !!v.forceVisibleTo?.has(o.id) || !!v.party?.includes(o.username),
    queueSpawnPlayerPacket: (m: any) => ({ spawn: m.id }),
  };
  const partyViewChanged = withNames(Object.keys(given), `${fn("export async function partyViewChanged(").replace("export ", "")}\nreturn partyViewChanged;`)(given);
  const spawns = () => [...(spawnBatchQueue.get("p")?.keys() ?? [])];
  const despawns = () => [...(despawnBatchQueue.get("p") ?? [])];
  return { p, partyViewChanged, spawns, despawns, spawnBatchQueue, despawnBatchQueue, mirrorPlayers, held };
}

describe("a party change and the hidden members of another node", () => {
  test("joining shows the vanished member in view", async () => {
    const v = viewing([{ id: "v", username: "val", isVanished: true }]);
    await v.partyViewChanged(v.p, () => { v.p.party = ["pat", "val"]; });
    expect(v.spawns()).toEqual(["v"]);
    expect(v.spawnBatchQueue.get("p")?.get("v")).toEqual({ spawn: "v" });
    expect(v.despawns()).toEqual([]);
  });

  test("leaving hides the vanished member, and a spawn of it still queued is dropped", async () => {
    const v = viewing([{ id: "v", username: "val", isVanished: true }], { party: ["pat", "val"] });
    v.spawnBatchQueue.set("p", new Map([["v", { spawn: "v" }]]));
    await v.partyViewChanged(v.p, async () => { await Promise.resolve(); v.p.party = []; });
    expect(v.spawns()).toEqual([]);
    expect(v.despawns()).toEqual(["v"]);
  });

  test("a join clears a despawn of the member still queued", async () => {
    const v = viewing([{ id: "v", username: "val", isStealth: true }]);
    v.despawnBatchQueue.set("p", new Set(["v"]));
    await v.partyViewChanged(v.p, () => { v.p.party = ["pat", "val"]; });
    expect(v.spawns()).toEqual(["v"]);
    expect(v.despawns()).toEqual([]);
  });

  test("nothing is queued for members not hidden, out of view, gone meanwhile, or seen either way", async () => {
    const shown = viewing([{ id: "s", username: "sam" }]);
    await shown.partyViewChanged(shown.p, () => { shown.p.party = ["pat", "sam"]; });
    expect([shown.spawns(), shown.despawns()]).toEqual([[], []]);

    const away = viewing([{ id: "v", username: "val", isVanished: true }], { aoi: { playersInAOI: new Set() } });
    await away.partyViewChanged(away.p, () => { away.p.party = ["pat", "val"]; });
    expect([away.spawns(), away.despawns()]).toEqual([[], []]);

    const gone = viewing([{ id: "v", username: "val", isVanished: true }]);
    await gone.partyViewChanged(gone.p, () => { gone.mirrorPlayers.delete("v"); gone.p.party = ["pat", "val"]; });
    expect([gone.spawns(), gone.despawns()]).toEqual([[], []]);

    const admin = viewing([{ id: "v", username: "val", isVanished: true }], { isAdmin: true, party: ["pat", "val"] });
    await admin.partyViewChanged(admin.p, () => { admin.p.party = []; });
    expect([admin.spawns(), admin.despawns()]).toEqual([[], []]);

    const offline = viewing([{ id: "v", username: "val", isVanished: true }], { wt: null });
    await offline.partyViewChanged(offline.p, () => { offline.p.party = ["pat", "val"]; });
    expect([offline.spawns(), offline.despawns()]).toEqual([[], []]);
  });

  test("leaving hides a vanished member of this node in view", async () => {
    const v = viewing([], { party: ["pat", "lou"] }, [{ id: "l", username: "lou", isVanished: true }]);
    await v.partyViewChanged(v.p, () => { v.p.party = []; });
    expect([v.spawns(), v.despawns()]).toEqual([[], ["l"]]);
  });

  test("joining shows a stealthed member of this node in view", async () => {
    const v = viewing([], {}, [{ id: "l", username: "lou", isStealth: true }]);
    await v.partyViewChanged(v.p, () => { v.p.party = ["pat", "lou"]; });
    expect([v.spawns(), v.despawns()]).toEqual([["l"], []]);
  });

  test("a member of this node who logged out meanwhile, or the viewer themself, is left alone", async () => {
    const gone = viewing([], { party: ["pat", "lou"] }, [{ id: "l", username: "lou", isVanished: true }]);
    await gone.partyViewChanged(gone.p, () => { gone.held.delete("l"); gone.p.party = []; });
    expect([gone.spawns(), gone.despawns()]).toEqual([[], []]);

    const self = viewing([], { isVanished: true, party: ["pat", "lou"] });
    self.p.aoi.playersInAOI.add("p");
    await self.partyViewChanged(self.p, () => { self.p.party = []; });
    expect([self.spawns(), self.despawns()]).toEqual([[], []]);
  });

  test("the party actions and a leaver's own clear go through it", () => {
    const update = cut(receiver, 'registerPlayerAction("party-update"', /\n}\);/);
    const cleared = cut(receiver, 'registerPlayerAction("party-cleared"', /\n}\);/);
    expect(update).toContain("partyViewChanged(p,");
    expect(cleared).toContain("partyViewChanged(p,");
    const leave = cut(social, 'case "LEAVE_PARTY": {', /\n {8}break;\r?\n {6}\}/);
    expect(leave).toContain("partyViewChanged(currentPlayer,");
  });
});
