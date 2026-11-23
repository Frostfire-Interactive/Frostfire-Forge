import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isCopyKey } from "../systems/dungeons/copykey";
import { releasePlan } from "../systems/dungeons/rules";

// The RELEASE_SPIRIT case of socket/handlers/death.ts, run as a function of the names it uses (the handler imports receiver.ts).
const death = readFileSync(join(import.meta.dir, "..", "socket", "handlers", "death.ts"), "utf8");
const transpiler = new Bun.Transpiler({ loader: "ts" });
const names = [
  "type", "currentPlayer", "isCopyKey", "copyEntrance", "log", "releasePlan", "forceStopPlayerMovement", "player", "playerCache",
  "bumpStateRevision", "packetManager", "filterPlayersByMap", "sendPacket", "relayToMirrorViewers", "spellEffects",
  "sendStatsToPartyMembers", "listener", "Events", "placePlayer", "sendToPortal", "findGraveyardSpawn", "resyncNpcChunks",
  "stateRevision", "GHOST_TELEPORT_DELAY_MS",
];

function releaseCase(): (given: Record<string, unknown>) => Promise<void> {
  const from = '\n      case "RELEASE_SPIRIT": {';
  const start = death.indexOf(from);
  if (start < 0) throw new Error("RELEASE_SPIRIT not found");
  const rest = death.slice(start);
  const body = rest.slice(0, rest.search(/\r?\n {6}}\r?\n/));
  const code = `return (async () => { switch (type) {${body}\n}\n} })();`;
  return new Function(`"use strict";\n${transpiler.transformSync(`function make({ ${names.join(", ")} }: any) { ${code} }`)}\nreturn make;`)();
}

function setup(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const corpse = { map: "crypt~a", x: 3, y: 4 };
  const currentPlayer: any = {
    id: "s1", username: "ann", isDead: true, isGhost: false, corpse, wt: {},
    location: { map: "crypt~a", position: { x: 3, y: 4, direction: "down" } },
    stats: { health: 0, stamina: 0, total_max_health: 100, total_max_stamina: 50 },
  };
  const given: Record<string, unknown> = {
    type: "RELEASE_SPIRIT", currentPlayer, isCopyKey, releasePlan,
    copyEntrance: async () => ({ x: 10, y: 20 }),
    log: { error: (m: string) => calls.push(`error ${m}`), warn: (m: string) => calls.push(`warn ${m}`) },
    forceStopPlayerMovement: async () => { calls.push("stop"); },
    player: { synchronizeStats: async () => null, setDeadState: async (_u: string, state: number) => { calls.push(`dead state ${state}`); } },
    playerCache: { set: () => {} },
    bumpStateRevision: () => {},
    packetManager: { playerGhost: () => [], revive: () => [] },
    filterPlayersByMap: () => [],
    sendPacket: () => {},
    relayToMirrorViewers: () => {},
    spellEffects: { broadcastEffectsUpdate: () => {} },
    sendStatsToPartyMembers: () => {},
    listener: { emit: (event: string) => calls.push(`emit ${event}`) },
    Events: { PLAYER_REVIVED: "revived", PLAYER_GHOST_RELEASED: "released" },
    placePlayer: async (_p: any, map: string, x: number, y: number) => { calls.push(`place ${map} ${x} ${y}`); },
    sendToPortal: async () => { calls.push("portal"); },
    findGraveyardSpawn: () => ({ x: 0, y: 0 }),
    resyncNpcChunks: async () => {},
    stateRevision: () => 1,
    GHOST_TELEPORT_DELAY_MS: 0,
    ...over,
  };
  return { given, calls, currentPlayer };
}

describe("RELEASE_SPIRIT in a dungeon copy", () => {
  const release = releaseCase();

  test("revives at the entrance", async () => {
    const { given, calls, currentPlayer } = setup();
    await release(given);
    expect(currentPlayer.isDead).toBe(false);
    expect(currentPlayer.corpse).toBeNull();
    expect(currentPlayer.stats.health).toBe(100);
    expect(calls).toContain("place crypt~a 10 20");
  });

  test("a stats read that fails still revives: no corpse is left for a later release", async () => {
    const { given, calls, currentPlayer } = setup({
      player: { synchronizeStats: async () => { throw new Error("db down"); }, setDeadState: async () => {} },
    });
    await release(given);
    expect(currentPlayer.isDead).toBe(false);
    expect(currentPlayer.corpse).toBeNull();
    expect(currentPlayer.ghostTeleportPending).toBe(false);
    expect(currentPlayer.stats.health).toBe(100);
    expect(calls).toContain("place crypt~a 10 20");
    expect(calls.some((c) => c.startsWith("warn ") && c.includes("db down"))).toBe(true);
  });

  test("a stop that fails still revives", async () => {
    const { given, calls, currentPlayer } = setup({ forceStopPlayerMovement: async () => { throw new Error("gone"); } });
    await release(given);
    expect(currentPlayer.isDead).toBe(false);
    expect(currentPlayer.corpse).toBeNull();
    expect(calls).toContain("place crypt~a 10 20");
  });
});
