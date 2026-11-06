import { expect, test } from "bun:test";
import { WEATHER_CYCLE_MS, nextCycleIn, settledPick } from "../systems/weathercycle";

// A "random" world settles on a weather for each stretch of WEATHER_CYCLE_MS. In a cluster every node holding part of
// the world picks it, so the pick comes from the world and the stretch alone: the same on every node, at the same time.

const row = (name: string) => ({ name }) as any;
const table = ["rain", "snow", "fog", "clear", "thunderstorm"].map(row);
const stretch = (n: number) => n * WEATHER_CYCLE_MS + 1234;

test("the same world in the same stretch settles on the same weather, whatever order the table is read in", () => {
  const first = settledPick(table, "overworld", stretch(100));
  expect(first).not.toBeNull();
  expect(settledPick([...table].reverse(), "overworld", stretch(100) + WEATHER_CYCLE_MS - 2000)?.name).toBe(first!.name);
});

test("the weather changes from stretch to stretch, and worlds settle on their own", () => {
  const overStretches = new Set(Array.from({ length: 48 }, (_, n) => settledPick(table, "overworld", stretch(n))!.name));
  expect(overStretches.size).toBeGreaterThan(1);
  const overWorlds = new Set(Array.from({ length: 24 }, (_, n) => settledPick(table, `world${n}`, stretch(7))!.name));
  expect(overWorlds.size).toBeGreaterThan(1);
});

test("never a tornado, and nothing from a table without another weather", () => {
  const withTornado = [...table, row("tornado")];
  for (let n = 0; n < 200; n++) expect(settledPick(withTornado, "overworld", stretch(n))!.name).not.toBe("tornado");
  expect(settledPick([row("tornado")], "overworld", stretch(1))).toBeNull();
  expect(settledPick([], "overworld", stretch(1))).toBeNull();
  expect(settledPick(null, "overworld", stretch(1))).toBeNull();
});

test("the next change is at the turn of the stretch", () => {
  expect(nextCycleIn(5 * WEATHER_CYCLE_MS)).toBe(WEATHER_CYCLE_MS);
  expect(nextCycleIn(5 * WEATHER_CYCLE_MS + 1)).toBe(WEATHER_CYCLE_MS - 1);
  expect(nextCycleIn(6 * WEATHER_CYCLE_MS - 1)).toBe(1);
});
