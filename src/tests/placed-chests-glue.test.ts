import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { databaseModule, mockQuery } from "./setup";

mock.module("../controllers/sqldatabase", () => databaseModule({ default: mockQuery }));
mock.module("../config/settings.json", () => ({ default: { creatures: {} }, creatures: {} }));

const { default: lootChest } = await import("../systems/lootChest");
const { default: assetCache } = await import("../services/assetCache");
const { startPlacedChests } = await import("../systems/placedchestsglue");
import type { MapChestObject } from "../systems/dungeons/types";

const chestObj = (name: string, x = 10, y = 20): MapChestObject => ({ name, lootTableId: 4, resetMinutes: 30, position: { x, y }, layer: null });
const placedOn = (map: string) => [...lootChest.all()].filter((c) => c.map === map && c.placed !== null).map((c) => c.placed);
const restores: Array<{ mockRestore(): void }> = [];
let stop: (() => void) | null = null;

function mapProperties(list: unknown) {
  restores.push(spyOn(assetCache, "get").mockImplementation((async (key: string) => (key === "mapProperties" ? list : null)) as any));
}

afterEach(() => {
  stop?.();
  stop = null;
  for (const r of restores.splice(0)) r.mockRestore();
  for (const c of [...lootChest.all()]) lootChest.despawn(c.id);
});

test("start-up spawns the chests of every map but copies, and a second start spawns none again and starts no second timer", async () => {
  mapProperties([{ name: "main.json", chests: [chestObj("A"), chestObj("B", 50, 60)] }, { name: "crypt~a1.json", chests: [chestObj("C")] }, { name: "empty.json" }]);
  const timers = spyOn(globalThis, "setInterval");
  restores.push(timers);
  stop = await startPlacedChests();
  expect(placedOn("main.json").sort()).toEqual(["A", "B"]);
  expect(placedOn("crypt~a1.json")).toEqual([]);
  const ids = [...lootChest.all()].map((c) => c.id).sort();
  await startPlacedChests();
  expect([...lootChest.all()].map((c) => c.id).sort()).toEqual(ids);
  expect(timers).toHaveBeenCalledTimes(1);
});

test("a map whose chests cannot be spawned does not keep the others from spawning, nor the timer from starting", async () => {
  mapProperties([{ name: "bad.json", chests: [chestObj("X")] }, { name: "main.json", chests: [chestObj("A")] }]);
  const real = lootChest.spawn.bind(lootChest);
  restores.push(spyOn(lootChest, "spawn").mockImplementation(((...args: Parameters<typeof lootChest.spawn>) => {
    if (args[0] === "bad.json") throw new Error("no ids left");
    return real(...args);
  }) as any));
  const timers = spyOn(globalThis, "setInterval");
  restores.push(timers);
  stop = await startPlacedChests();
  expect(placedOn("main.json")).toEqual(["A"]);
  expect(timers).toHaveBeenCalledTimes(1);
});

test("map properties that cannot be read leave start-up going, with the timer started", async () => {
  restores.push(spyOn(assetCache, "get").mockImplementation((async () => { throw new Error("cache down"); }) as any));
  const timers = spyOn(globalThis, "setInterval");
  restores.push(timers);
  stop = await startPlacedChests();
  expect(timers).toHaveBeenCalledTimes(1);
  expect([...lootChest.all()]).toEqual([]);
});

test("once stopped, start-up can run again", async () => {
  mapProperties([{ name: "main.json", chests: [chestObj("A")] }]);
  const first = await startPlacedChests();
  first();
  const timers = spyOn(globalThis, "setInterval");
  restores.push(timers);
  stop = await startPlacedChests();
  expect(timers).toHaveBeenCalledTimes(1);
  expect(placedOn("main.json")).toEqual(["A"]);
});
