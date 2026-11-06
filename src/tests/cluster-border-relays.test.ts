import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { receiverSource } from "./receiver-source";

// Cluster mode: what a node's own send loops (the map's players here, a player's viewers here) tell its players about a
// player must reach the viewers of that player's mirrors on the neighbouring nodes as well (relayToMirrorViewers,
// socket/aoi.ts). A mirror's state carries no packet to the viewers who already see it, so a death, a revive or a
// health bar shown only here would never change for them. receiver.ts cannot be imported: these read its source.

const receiver = receiverSource();
const server = readFileSync(join(import.meta.dir, "..", "socket", "server.ts"), "utf8");
const transpiler = new Bun.Transpiler({ loader: "ts" });

/** `source` from `start` to the first match of `until` after it. */
function cut(source: string, start: string, until: RegExp): string {
  const at = source.indexOf(start);
  if (at < 0) throw new Error(`Not found in the source: ${start}`);
  const rest = source.slice(at);
  const end = rest.search(until);
  if (end < 0) throw new Error(`No end found for: ${start}`);
  return rest.slice(0, end);
}
/** A top-level function of the receiver, header to closing brace. */
const fn = (header: string) => cut(receiver, header, /\n}\r?\n/) + "\n}";
/** A case of a packet handler, without its closing `break;`. */
const caseOf = (name: string) => cut(receiver, `case "${name}": {`, /\r?\n {6}case "|\r?\n {2}}\r?\n}/);

const withNames = (names: string[], code: string): ((given: Record<string, any>) => any) =>
  new Function(`"use strict";\n${transpiler.transformSync(`function make({ ${names.join(", ")} }: any) { ${code} }`)}\nreturn make;`)();

describe("a death", () => {
  test("the stats of the fall go to the mirrors' viewers, as to the map here", () => {
    const body = fn("export async function handlePlayerDeath(");
    const map = body.indexOf("filterPlayersByMap(target.location.map)");
    const relay = body.indexOf("relayToMirrorViewers(target, deathPacket, false)");
    expect(map).toBeGreaterThan(0);
    expect(relay).toBeGreaterThan(map);
  });

  // The owner's death flow now relays the number, so the caster's node sends it only to who that relay missed.
  const hitRemotePlayer = withNames(
    ["sendPlayerHit", "setPlayerPvp", "packetManager", "broadcastStatsUpdateToAOI", "findPlayersWithTargetInAOI", "sendPacketBestEffort", "listener", "Events"],
    fn("export async function hitRemotePlayer(").replace("export ", "") + "\nreturn hitRemotePlayer;",
  );
  const run = async (outcome: string) => {
    const sent: string[] = [];
    const broadcasts: any[] = [];
    const emitted: any[] = [];
    const caster = { id: "c", username: "caster", wt: "caster-wt", location: { map: "m", position: { x: 0, y: 0 } } };
    const target = { id: "t", username: "target", remote: true };
    const viewers: Record<string, any[]> = {
      t: [{ id: "v1", wt: "v1-wt" }],
      c: [{ id: "v1", wt: "v1-wt" }, { id: "v2", wt: "v2-wt" }],
    };
    const ok = await hitRemotePlayer({
      sendPlayerHit: async () => ({ outcome, stats: { health: 0 }, absorb: 0 }),
      setPlayerPvp: () => {},
      packetManager: { updateStats: (data: any) => [data] },
      broadcastStatsUpdateToAOI: (...args: any[]) => broadcasts.push(args),
      findPlayersWithTargetInAOI: (id: string) => viewers[id] ?? [],
      sendPacketBestEffort: (wt: string) => sent.push(wt),
      listener: { emit: (...args: any[]) => emitted.push(args) },
      Events: { PLAYER_DEATH: "death" },
    })(caster, target, { harmful: true, casterParty: [], showsDamage: true, isCrit: false, damage: 9 });
    return { ok, sent, broadcasts, emitted };
  };

  test("a kill across the border shows the number once: to who the owner's relay did not reach", async () => {
    const { ok, sent, broadcasts, emitted } = await run("killed");
    expect(ok).toBe(true);
    expect(broadcasts).toEqual([]);
    expect(sent.sort()).toEqual(["caster-wt", "v2-wt"]);
    expect(emitted.map((e) => e[0])).toEqual(["death"]);
  });

  test("a hit across the border that does not kill is sent the same way", async () => {
    const { sent, emitted } = await run("applied");
    expect(sent.sort()).toEqual(["caster-wt", "v2-wt"]);
    expect(emitted).toEqual([]);
  });

  test("a relog as a ghost is relayed, as it is shown to the map here", () => {
    const at = receiver.indexOf("} else if (relogPlayer?.isGhost) {");
    expect(at).toBeGreaterThan(0);
    const block = receiver.slice(at, at + 600);
    expect(block).toContain("relayToMirrorViewers(relogPlayer, ghostPacket, false)");
  });
});

describe("a release and a revive", () => {
  test("the release is relayed: the ghost at once, and its move and spawn signal at the graveyard", () => {
    const release = caseOf("RELEASE_SPIRIT");
    expect(release).toContain("relayToMirrorViewers(currentPlayer, releasePacket, false)");
    expect(release).toContain("relayToMirrorViewers(p, [...arrivalMove, ...arrivalGhost], false)");
  });

  test("both revives are relayed, the ghost packet before the revive", () => {
    for (const name of ["CONFIRM_REVIVE", "CONFIRM_GRAVEYARD_REVIVE"]) {
      expect(caseOf(name)).toContain("relayToMirrorViewers(currentPlayer, [...ghostPacket, ...revivePacket], false)");
    }
  });

  test("the end of Resurrection Sickness is relayed", () => {
    const body = cut(receiver, "resurrection.setOnSicknessExpiry(", /\r?\n}\);/);
    expect(body).toContain("relayToMirrorViewers(p, statsPacket, false)");
  });
});

describe("stats, casts and drags", () => {
  test("a spell's stats on the target are relayed by the combat handler's broadcastStats", () => {
    const body = cut(receiver, "const broadcastStats = (p: any) => {", /\r?\n {10}};/);
    expect(body).toContain("relayToMirrorViewers(p, statsPacket, false)");
  });

  test("a projectile at a creature is relayed best effort, as it goes to the map here", () => {
    const body = cut(receiver, "if (projectile.length) {", /\r?\n {2}}/);
    expect(body).toContain("relayToMirrorViewers(after, projectile, true)");
  });

  test("a drag's start and stop are relayed, by the commands and when the admin leaves", () => {
    expect(caseOf("DRAG_PLAYER_START")).toContain("relayToMirrorViewers(targetPlayer, dragStartPacket, false)");
    expect(caseOf("DRAG_PLAYER_STOP")).toContain("relayToMirrorViewers(targetPlayer, dragStopPacket, false)");
    expect(fn("export function releaseDraggedBy(")).toContain("relayToMirrorViewers(draggedPlayer, dragStopPacket, false)");
  });

  test("the regen tick relays the observers' stats, best effort", () => {
    const body = cut(server, "const frames = regenStatsFrames(playerData, stats);", /\r?\n {2}}\r?\n/);
    expect(body).toContain("relayToMirrorViewers(playerData, [frames.frameFor({})], true)");
  });
});

describe("fishing", () => {
  const broadcastFishing = withNames(
    ["packetManager", "playerCache", "filterPlayersByMap", "sendPacket", "relayToMirrorViewers"],
    fn("function broadcastFishing(") + "\nreturn broadcastFishing;",
  );
  const angle = (angler: any, data: any) => {
    const relays: any[] = [];
    broadcastFishing({
      packetManager: { fishing: (d: any) => [d] },
      playerCache: { get: () => angler },
      filterPlayersByMap: () => [],
      sendPacket: () => {},
      relayToMirrorViewers: (...args: any[]) => relays.push(args),
    })("main", data);
    return relays;
  };

  test("every line packet is relayed for the angler", () => {
    const angler = { id: "5", username: "fisher" };
    expect(angle(angler, { id: "5", state: "cast", x: 1, y: 2 })).toEqual([[angler, [{ id: "5", state: "cast", x: 1, y: 2 }], false]]);
  });

  test("the angler carries their line for the mirrors, until it ends", () => {
    const angler: any = { id: "5", username: "fisher" };
    angle(angler, { id: "5", state: "cast", x: 1, y: 2 });
    expect(angler.fishLine).toEqual({ x: 1, y: 2, bit: false, reeled: false });
    angle(angler, { id: "5", state: "bite" });
    expect(angler.fishLine).toEqual({ x: 1, y: 2, bit: true, reeled: false });
    angle(angler, { id: "5", state: "reel" });
    expect(angler.fishLine).toEqual({ x: 1, y: 2, bit: true, reeled: true });
    for (const state of ["catch", "escape", "end"]) {
      angle(angler, { id: "5", state: "cast", x: 1, y: 2 });
      angle(angler, { id: "5", state });
      expect(angler.fishLine).toBeNull();
    }
  });

  test("a viewer who comes into view of a fishing mirror is sent its line", () => {
    const body = fn("export async function sendAnimationTo(");
    expect(body).toContain("targetPlayer.remote ? targetPlayer.fishLine");
  });
});

describe("ground AoE zones", () => {
  // The zone's tick on a mirror (systems/groundaoe.ts) is handed to receiver.ts, which sends it to the mirror's owner.
  const wiring = () => cut(receiver, "setMirrorZoneHitHandler(", /\);\r?\n/) + ");";
  const run = () => {
    const calls: any[] = [];
    let handler: any = null;
    withNames(["setMirrorZoneHitHandler", "hitRemotePlayer", "remoteHit"], wiring())({
      setMirrorZoneHitHandler: (h: any) => { handler = h; },
      hitRemotePlayer: async (caster: any, target: any, hit: any) => { calls.push({ caster: caster.id, target: target.id, hit }); return true; },
      remoteHit: (caster: any, spell: any, damage: number, isCrit: boolean, how: any) => ({ from: caster.id, spell, damage, isCrit, how }),
    });
    return { calls, handler: () => handler };
  };
  const zone = (extra: any) => ({ id: "z", spell: { name: "Fire Pit", effects: [] }, effects: null, damageType: "damage", damagePerTick: 12, ...extra });

  test("a hostile tick goes to the owner as a harmful hit that shows its number", async () => {
    const { calls, handler } = run();
    await handler()({ id: "c" }, { id: "m" }, zone({}), 12);
    expect(calls).toEqual([{ caster: "c", target: "m", hit: { from: "c", spell: { name: "Fire Pit", effects: [] }, damage: 12, isCrit: false, how: { skipEffects: true, showsDamage: true, harmful: true } } }]);
  });

  test("a heal tick is not harmful, and a zone with effects sends the spell with them to be applied", async () => {
    const { calls, handler } = run();
    const effects = [{ type: "slow", value: 20, duration: 2 }];
    await handler()({ id: "c" }, { id: "m" }, zone({ damageType: "heal", damagePerTick: -10, effects }), -10);
    expect(calls[0].hit.how).toEqual({ skipEffects: false, showsDamage: true, harmful: false });
    expect(calls[0].hit.spell.effects).toEqual(effects);
  });

  test("an avoided tick shows no number", async () => {
    const { calls, handler } = run();
    await handler()({ id: "c" }, { id: "m" }, zone({}), 0);
    expect(calls[0].hit.how.showsDamage).toBe(false);
  });
});
