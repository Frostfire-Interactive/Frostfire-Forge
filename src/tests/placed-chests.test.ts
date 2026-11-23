import { afterAll, afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { databaseModule, mockQuery } from "./setup";

mock.module("../controllers/sqldatabase", () => databaseModule({ default: mockQuery }));
mock.module("../config/settings.json", () => ({ default: { creatures: {} }, creatures: {} }));

const { default: lootChest } = await import("../systems/lootChest");
const { default: lootTable } = await import("../systems/lootTable");
const { spawnPlacedChests, despawnPlacedChests, dueResets, syncPlacedChests } = await import("../systems/placedchests");
import type { MapChestObject } from "../systems/dungeons/types";

const chestObj = (name: string, table: number, minutes: number, x = 10, y = 20): MapChestObject =>
  ({ name, lootTableId: table, resetMinutes: minutes, position: { x, y }, layer: null });
const start = Date.parse("2030-01-01T00:00:00Z");
let rollSpy: { mockRestore(): void };

beforeEach(() => {
  setSystemTime(start);
  rollSpy = spyOn(lootTable, "roll").mockResolvedValue([{ index: 0, itemName: "Gem", quantity: 1 }] as any);
});
afterEach(() => {
  rollSpy.mockRestore();
  for (const map of ["main", "crypt~a1", "other"]) despawnPlacedChests(map);
  for (const c of [...lootChest.all()]) lootChest.despawn(c.id);
  setSystemTime();
});
afterAll(() => setSystemTime());

test("placed chests spawn from the map's objects, reset on a timer, and leave hand-spawned chests alone", async () => {
  const ids = spawnPlacedChests("main", [chestObj("A", 4, 30)], { resets: true });
  expect(ids.length).toBe(1);
  const placed = lootChest.getChest(ids[0]);
  expect(placed).toMatchObject({ map: "main", x: 10, y: 20, lootTableId: 4, createdBy: "map", placed: "A", resetMs: 30 * 60_000 });
  const hand = lootChest.spawn("main", 1, 1, 4, undefined, "admin");
  await lootChest.open(ids[0], "p1");
  expect(lootChest.getChest(ids[0]).playerLoot.size).toBe(1);

  expect(dueResets(start + 29 * 60_000)).toEqual([]);
  setSystemTime(start + 30 * 60_000);
  expect(dueResets(Date.now())).toEqual(ids);
  expect(lootChest.getChest(ids[0]).playerLoot.size).toBe(0);
  expect(dueResets(Date.now())).toEqual([]);
  setSystemTime(start + 60 * 60_000);
  expect(dueResets(Date.now())).toEqual(ids);

  expect(despawnPlacedChests("main")).toEqual(ids);
  expect(lootChest.getChest(ids[0])).toBeUndefined();
  expect(lootChest.getChest(hand)).toBeTruthy();
});

test("copies get chests that never reset", () => {
  const [id] = spawnPlacedChests("crypt~a1", [chestObj("A", 4, 30)], { resets: false });
  expect(lootChest.getChest(id)).toMatchObject({ placed: "A", resetMs: null, resetAt: null });
  setSystemTime(start + 999 * 60_000);
  expect(dueResets(Date.now())).not.toContain(id);
});

test("the ownership gate leaves out chests this node does not own", () => {
  const ids = spawnPlacedChests("main", [chestObj("A", 4, 30, 1, 1), chestObj("B", 4, 30, 500, 500)], { resets: true, here: (x) => x < 100 });
  expect(ids.length).toBe(1);
  expect(lootChest.getChest(ids[0]).placed).toBe("A");
});

test("reset clears every player's roll and says whether the chest exists", async () => {
  const id = lootChest.spawn("main", 1, 1, 4);
  await lootChest.open(id, "p1");
  expect(lootChest.reset(id)).toBe(true);
  expect(lootChest.getChest(id).playerLoot.size).toBe(0);
  expect(lootChest.reset("nope")).toBe(false);
});

test("a chest with a reset that is not above zero is never reset", () => {
  const id = lootChest.spawn("main", 1, 1, 4, undefined, "map", { name: "Z", resetMs: 0, resetAt: start });
  const neg = lootChest.spawn("main", 2, 2, 4, undefined, "map", { name: "N", resetMs: -5, resetAt: start });
  expect(dueResets(start + 1000)).toEqual([]);
  expect(lootChest.getChest(id).resetAt).toBe(start);
  expect(lootChest.getChest(neg).resetAt).toBe(start);
});

test("syncing keeps unchanged chests with their rolls and timers, and replaces changed, removed and new ones", async () => {
  const [a, b, c] = spawnPlacedChests("main", [chestObj("A", 4, 30, 1, 1), chestObj("B", 4, 30, 2, 2), chestObj("C", 4, 30, 3, 3)], { resets: true });
  await lootChest.open(a, "p1");
  setSystemTime(start + 5 * 60_000);
  const result = syncPlacedChests("main", [chestObj("A", 4, 30, 1, 1), chestObj("B", 5, 30, 2, 2), chestObj("D", 4, 30, 4, 4)], { resets: true });
  expect(result.removed.sort()).toEqual([b, c].sort());
  expect(result.added.length).toBe(2);
  expect(lootChest.getChest(a).playerLoot.size).toBe(1);
  expect(lootChest.getChest(a).resetAt).toBe(start + 30 * 60_000);
  expect(lootChest.getChest(b)).toBeUndefined();
  expect(lootChest.getChest(c)).toBeUndefined();
  const names = result.added.map((id) => lootChest.getChest(id).placed).sort();
  expect(names).toEqual(["B", "D"]);
  expect(lootChest.getChest(result.added.find((id) => lootChest.getChest(id).placed === "B")!).lootTableId).toBe(5);
});

test("syncing replaces a chest whose position or reset changed, and keeps hand-spawned chests", () => {
  const [a, b] = spawnPlacedChests("main", [chestObj("A", 4, 30, 1, 1), chestObj("B", 4, 30, 2, 2)], { resets: true });
  const hand = lootChest.spawn("main", 9, 9, 4, undefined, "admin");
  const result = syncPlacedChests("main", [chestObj("A", 4, 30, 7, 1), chestObj("B", 4, 10, 2, 2)], { resets: true });
  expect(result.removed.sort()).toEqual([a, b].sort());
  expect(result.added.length).toBe(2);
  expect(lootChest.getChest(hand)).toBeTruthy();
});

test("syncing an unchanged list touches nothing, and honours the ownership gate for new chests", () => {
  const ids = spawnPlacedChests("main", [chestObj("A", 4, 30)], { resets: true });
  expect(syncPlacedChests("main", [chestObj("A", 4, 30)], { resets: true })).toEqual({ removed: [], added: [] });
  expect(lootChest.getChest(ids[0])).toBeTruthy();
  const gated = syncPlacedChests("main", [chestObj("A", 4, 30), chestObj("Far", 4, 30, 900, 900)], { resets: true, here: (x) => x < 100 });
  expect(gated.added).toEqual([]);
});

test("syncing removes an unchanged chest this node no longer owns, and spawns none in its place", () => {
  const [a] = spawnPlacedChests("main", [chestObj("A", 4, 30, 1, 1)], { resets: true });
  const result = syncPlacedChests("main", [chestObj("A", 4, 30, 1, 1)], { resets: true, here: () => false });
  expect(result).toEqual({ removed: [a], added: [] });
  expect(lootChest.getChest(a)).toBeFalsy();
});
