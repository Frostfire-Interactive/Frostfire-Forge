import { describe, expect, test } from "bun:test";
import { CorpseLootStore, type CorpseItem } from "../systems/creatures/loot";

const item = (index: number, itemName: string): CorpseItem => ({ index, itemName, quantity: 1, quality: "common", iconUrl: "" });

describe("personal corpse loot", () => {
  test("each member has their own record", () => {
    const store = new CorpseLootStore();
    store.createPersonal(7, new Map([["ann", { items: [item(0, "Bone")], copper: 5 }], ["bob", { items: [item(0, "Fang")], copper: 5 }]]));
    expect(store.remaining(7, "ann").map((i) => i.itemName)).toEqual(["Bone"]);
    expect(store.remaining(7, "bob").map((i) => i.itemName)).toEqual(["Fang"]);
    const r = store.take(7, "ann", null)!;
    expect(r.taken.map((i) => i.itemName)).toEqual(["Bone"]);
    expect(r.copper.get("ann")).toBe(5);
    expect(r.copper.has("bob")).toBe(false);
    expect(r.empty).toBe(false);
    expect(store.canLoot(7, "ann")).toBe(false);
    expect(store.canLoot(7, "bob")).toBe(true);
    expect(store.take(7, "bob", null)!.empty).toBe(true);
    expect(store.has(7)).toBe(false);
  });

  test("all-empty records make no corpse", () => {
    const store = new CorpseLootStore();
    expect(store.createPersonal(8, new Map([["ann", { items: [], copper: 0 }]]))).toBeNull();
    expect(store.has(8)).toBe(false);
  });

  test("owners are all keys; a non-member cannot take", () => {
    const store = new CorpseLootStore();
    const loot = store.createPersonal(9, new Map([["Ann", { items: [item(0, "Bone")], copper: 0 }], ["bob", { items: [], copper: 3 }]]))!;
    expect([...loot.owners].sort()).toEqual(["ann", "bob"]);
    expect(store.take(9, "cat", null)).toBeNull();
    expect(store.canLoot(9, "cat")).toBe(false);
  });

  test("copper-only record keeps the member able to loot; partial take leaves the rest", () => {
    const store = new CorpseLootStore();
    store.createPersonal(10, new Map([["ann", { items: [item(0, "A"), item(1, "B")], copper: 4 }]]));
    const r = store.take(10, "ann", [1])!;
    expect(r.taken.map((i) => i.itemName)).toEqual(["B"]);
    expect(r.empty).toBe(false);
    expect(store.canLoot(10, "ann")).toBe(true);
    expect(store.remaining(10, "ann").map((i) => i.itemName)).toEqual(["A"]);
    expect(store.copperOf(10, "ann")).toBe(0);
  });

  test("restore puts a personal take back in the taker's record", () => {
    const store = new CorpseLootStore();
    const loot = store.createPersonal(11, new Map([["ann", { items: [item(0, "A")], copper: 4 }], ["bob", { items: [item(0, "B")], copper: 4 }]]))!;
    const r = store.take(11, "ann", null)!;
    store.restore(loot, r);
    expect(store.remaining(11, "ann").map((i) => i.itemName)).toEqual(["A"]);
    expect(store.copperOf(11, "ann")).toBe(4);
    expect(store.copperOf(11, "bob")).toBe(4);
  });

  test("shared corpses are unchanged", () => {
    const store = new CorpseLootStore();
    store.create(12, [item(0, "X")], 9, ["ann"], ["ann", "bob"]);
    expect(store.remaining(12).map((i) => i.itemName)).toEqual(["X"]);
    expect(store.remaining(12, "bob").map((i) => i.itemName)).toEqual(["X"]);
    expect(store.copperOf(12, "ann")).toBe(9);
  });
});
