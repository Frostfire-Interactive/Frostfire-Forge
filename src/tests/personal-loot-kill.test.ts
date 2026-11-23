import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { setRewardApplier, type RewardApplier } from "../systems/creatures/remotereward";
import { databaseModule, mockQuery } from "./setup";

// kill.ts reaches the database through many modules; the bags, money and loot table are stood in for below.
mock.module("../controllers/sqldatabase", () => databaseModule({ default: mockQuery }));

const { corpseLoot, handleKill, takeCorpseLoot } = await import("../systems/creatures/kill");
const { CreatureFlags } = await import("../systems/creatures/constants");
const { AIState } = await import("../systems/creatures/types");
const { default: playerCache } = await import("../services/playermanager");
const { default: assetCache } = await import("../services/assetCache");
const { default: lootTable } = await import("../systems/lootTable");
const { default: inventory } = await import("../systems/inventory");
const { default: currency } = await import("../systems/currency");
const { default: bags } = await import("../systems/bags");

const COPY = "crypt~abc";
let saved: RewardApplier | null = null;
const restores: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  saved = setRewardApplier(null);
  restores.push(
    spyOn(assetCache, "get").mockImplementation((async () => []) as any),
    spyOn(inventory, "get").mockImplementation((async () => []) as any),
    spyOn(inventory, "add").mockImplementation((async () => true) as any),
    spyOn(currency, "add").mockImplementation((async () => ({ copper: 0, silver: 0, gold: 0 })) as any),
    spyOn(bags, "capacity").mockImplementation((async () => 20) as any),
  );
});

afterEach(() => {
  setRewardApplier(saved);
  for (const r of restores.splice(0)) r.mockRestore();
});

const item = (itemName: string) => ({ itemName, quantity: 1, quality: "common", iconUrl: "" });

/** A player in the copy, beside the corpse, who keeps the CREATURE_LOOTABLE packets sent to them. */
function member(id: string, username: string, party: string[] = []) {
  const lootable: boolean[] = [];
  const wt = {
    readyState: 1,
    send: (p: Uint8Array) => {
      const decoded = JSON.parse(new TextDecoder().decode(p));
      if (decoded.type === "CREATURE_LOOTABLE") lootable.push(decoded.data.lootable);
    },
  };
  return { id, username, party, wt, lootable, stats: { level: 5 }, location: { map: `${COPY}.json`, position: { x: 500, y: 500 } } };
}

const creature = (id: number): any => ({
  id, map: COPY, x: 500, y: 500, layerId: null, level: 5, state: AIState.DEAD,
  combat: { tapper: { playerId: "1", username: "ann" }, corpseUntil: 0 },
});
const template: any = { id: 3, name: "Ghoul", rank: "normal", xp_mult: 1, flags: CreatureFlags.NO_XP, loot_table_id: 9, gold_min: 0, gold_max: 0, level_min: 5, level_max: 5 };

/** Each roll of the loot table answers the next list: the members are rolled for in tap-group order. */
function rolls(...lists: Array<Array<ReturnType<typeof item>>>) {
  let next = 0;
  restores.push(spyOn(lootTable, "roll").mockImplementation((async () => lists[next++] ?? []) as any));
}

async function inCopy(players: ReturnType<typeof member>[], body: () => Promise<void>): Promise<void> {
  for (const p of players) playerCache.add(p.id, p);
  try {
    await body();
  } finally {
    for (const p of players) playerCache.remove(p.id);
  }
}

test("in a copy, a member whose own roll is empty is told there is nothing to loot", async () => {
  const ann = member("1", "ann", ["bob"]);
  const bob = member("2", "bob");
  rolls([item("Bone")], []);
  await inCopy([ann, bob], async () => {
    await handleKill(creature(601), template);
    expect(corpseLoot.canLoot(601, "ann")).toBe(true);
    expect(corpseLoot.canLoot(601, "bob")).toBe(false);
    expect(ann.lootable).toEqual([true]);
    expect(bob.lootable).toEqual([false]);
  });
  corpseLoot.remove(601);
});

test("in a copy, each member is told once when their own loot is gone, and not again when the corpse empties", async () => {
  const ann = member("1", "ann", ["bob"]);
  const bob = member("2", "bob");
  rolls([item("Bone")], [item("Fang")]);
  await inCopy([ann, bob], async () => {
    const dead = creature(602);
    await handleKill(dead, template);
    expect(ann.lootable).toEqual([true]);
    expect(bob.lootable).toEqual([true]);

    const first = await takeCorpseLoot(ann, dead, null);
    expect(typeof first === "object" && first.taken.map((i) => i.itemName)).toEqual(["Bone"]);
    expect(ann.lootable).toEqual([true, false]);
    expect(bob.lootable).toEqual([true]);

    const last = await takeCorpseLoot(bob, dead, null);
    expect(typeof last === "object" && last.empty).toBe(true);
    expect(bob.lootable).toEqual([true, false]);
    // ann's own loot was gone already: she was told then.
    expect(ann.lootable).toEqual([true, false]);
    expect(corpseLoot.has(602)).toBe(false);
  });
});

test("in a copy where nobody rolled anything there is no corpse loot and nobody is told", async () => {
  const ann = member("1", "ann", ["bob"]);
  const bob = member("2", "bob");
  rolls([], []);
  await inCopy([ann, bob], async () => {
    await handleKill(creature(603), template);
    expect(corpseLoot.has(603)).toBe(false);
    expect(ann.lootable).toEqual([]);
    expect(bob.lootable).toEqual([]);
  });
});

test("outside a copy the corpse is shared: only its owner is told", async () => {
  const ann = member("1", "ann", ["bob"]);
  const bob = member("2", "bob");
  for (const p of [ann, bob]) p.location.map = "main.json";
  rolls([item("Bone")]);
  await inCopy([ann, bob], async () => {
    const dead = { ...creature(604), map: "main" };
    await handleKill(dead, template);
    const told = [...ann.lootable, ...bob.lootable];
    expect(told).toEqual([true]);
  });
  corpseLoot.remove(604);
});
