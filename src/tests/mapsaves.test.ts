import { expect, test } from "bun:test";
import { leaveToSave, mapSaveUnderWay, onLeftChangeMissed, startMapSave } from "../modules/mapsaves";

// A map editor save under way, here or on another node of the region (modules/mapsaves.ts): the asset server's word
// of the change is left to it, and taken in after all when the save ends without saving.

function missedOnes(): { missed: string[]; stop: () => void } {
  const missed: string[] = [];
  const stop = onLeftChangeMissed((name) => { missed.push(name); });
  return { missed, stop };
}

test("a map is under way from the start of its save to its end, by its name with or without .json", () => {
  expect(mapSaveUnderWay("a")).toBe(false);
  const end = startMapSave("a.json");
  expect(mapSaveUnderWay("a")).toBe(true);
  expect(mapSaveUnderWay("a.json")).toBe(true);
  expect(mapSaveUnderWay("b")).toBe(false);
  end(true);
  expect(mapSaveUnderWay("a")).toBe(false);
});

test("a change is left to a save only while one is under way", () => {
  expect(leaveToSave("c")).toBe(false);
  const end = startMapSave("c");
  expect(leaveToSave("c.json")).toBe(true);
  end(true);
  expect(leaveToSave("c")).toBe(false);
});

test("a change left to a save that ends saved is the save's: nothing takes it in again", () => {
  const { missed, stop } = missedOnes();
  const end = startMapSave("d");
  leaveToSave("d");
  end(true);
  stop();
  expect(missed).toEqual([]);
});

test("a change left to a save that ends without saving is taken in after all, once", () => {
  const { missed, stop } = missedOnes();
  const end = startMapSave("e.json");
  leaveToSave("e");
  end(false);
  end(false);
  stop();
  expect(missed).toEqual(["e"]);
});

test("a save that ends without saving, with nothing left to it, has nothing taken in", () => {
  const { missed, stop } = missedOnes();
  startMapSave("f")(false);
  stop();
  expect(missed).toEqual([]);
});

test("two saves of one map: it is under way until both have ended, and what was left is taken in if either did not save", () => {
  const { missed, stop } = missedOnes();
  const first = startMapSave("g");
  const second = startMapSave("g");
  leaveToSave("g");
  first(false);
  expect(mapSaveUnderWay("g")).toBe(true);
  expect(missed).toEqual([]);
  second(true);
  expect(mapSaveUnderWay("g")).toBe(false);
  expect(missed).toEqual(["g"]);

  // a later save starts afresh
  missed.length = 0;
  const third = startMapSave("g");
  third(true);
  stop();
  expect(missed).toEqual([]);
});

test("a listener that throws, or fails later, does not stop the others", async () => {
  const { missed, stop } = missedOnes();
  const stopThrowing = onLeftChangeMissed(() => { throw new Error("no"); });
  const stopFailing = onLeftChangeMissed(async () => { throw new Error("no"); });
  const end = startMapSave("h");
  leaveToSave("h");
  end(false);
  await Bun.sleep(0);
  stop();
  stopThrowing();
  stopFailing();
  expect(missed).toEqual(["h"]);
});
