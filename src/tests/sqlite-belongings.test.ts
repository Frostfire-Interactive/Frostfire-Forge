import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import os from "os";
import path from "path";
import fs from "fs";

// The inventory, currency and home systems on a real SQLite file, made by its setup, their rows a character's by its
// id. Their statements are written for MySQL, and the other test files hand them to a stand-in that takes them as
// written: only a database says whether SQLite reads them. It runs in a process of its own (see the fixture), so
// the stand-ins other test files put in place of the database layer do not reach it.

const name = `ff_belongings_test_${process.pid}`;
const file = path.join(os.tmpdir(), "frostfire_forge", `${name}.sqlite`);
const remove = () => { for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true }); };

let out: any;

beforeAll(async () => {
  remove();
  // --preload: the fixture is not a test run, so bunfig.toml's preload (stand-ins for the generated config files, absent on a fresh checkout) does not reach it.
  const run = Bun.spawn(["bun", "--preload", path.join(import.meta.dir, "preload-config.ts"), path.join(import.meta.dir, "sqlite-belongings.fixture.ts")], {
    env: { ...process.env, DATABASE_ENGINE: "sqlite", DATABASE_NAME: name, DB_WORKER_POOL_SIZE: "2", LOG_LEVEL: "error", CACHE: "memory" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]);
  await run.exited;
  const line = stdout.slice(stdout.indexOf("RESULT "));
  if (!line.startsWith("RESULT ")) throw new Error(`The fixture gave no result.\n${stdout}\n${stderr}`);
  out = JSON.parse(line.slice("RESULT ".length));
}, 60000);

afterAll(remove);

describe("the inventory and the currency on SQLite", () => {
  test("every write is taken: a new item, more of it, where it sits, and coins put in and taken out", () => {
    expect(out.steps).toEqual(Array(7).fill("ran"));
    expect(out.afterSteps).toEqual({
      held: [
        { owner: "hero", item: "Iron Ore", quantity: 8, slot: 4 },
        { owner: "hero", item: "Rat's \"Tail\"", quantity: 1, slot: null },
      ],
      // 1g 2s 50c and 60c more is 1g 3s 10c; less 1s 5c is 1g 2s 5c.
      purses: [{ owner: "hero", copper: 5, silver: 2, gold: 1 }],
    });
  });

  test("a batch that takes coins and gives a new item is kept whole", () => {
    expect(out.bought).toBe("ran");
    expect(out.tables).toEqual({
      held: [
        { owner: "hero", item: "Iron Ore", quantity: 8, slot: 4 },
        { owner: "hero", item: "Rat's \"Tail\"", quantity: 1, slot: null },
        { owner: "hero", item: "Small Pouch", quantity: 2, slot: null },
      ],
      purses: [{ owner: "hero", copper: 5, silver: 2, gold: 0 }],
    });
  });

  test("a player's home is written and written over: the inn, then the time they went home, then the next inn", () => {
    expect(out.homeSteps).toEqual(Array(5).fill("ran"));
    expect(out.homes).toEqual([
      // Set at one inn, gone home, then set at another: the time stays.
      { owner: "hero", npc_id: 12, offset_x: -5, offset_y: 8, used_at: 1_700_000_000_000 },
      // Gone home with no home set, then the innkeeper they later chose was deleted.
      { owner: "ally", npc_id: null, offset_x: 30, offset_y: 40, used_at: 1_700_000_000_500 },
    ]);
    expect(out.homeRead).toEqual({
      hero: { map: "forest", x: 95, y: 108, inn: "Leaf Lodge" },
      ally: null,
      cooldown: 3_600_000 - 1000,
    });
  });

  test("every row is the character's, by its id: none names an account", () => {
    expect(out.byName).toEqual([{ count: 0 }]);
  });

  test("what the systems answer after reading again is what the tables hold", () => {
    expect(out.read).toEqual({
      held: [["Iron Ore", 8], ["Rat's \"Tail\"", 1], ["Small Pouch", 2]],
      purse: { copper: 5, silver: 2, gold: 0 },
    });
  });
});

describe("the rest of a character's rows on SQLite, for two characters of one account", () => {
  test("a new player's account, character and first rows are made; a second character is the same account's", () => {
    expect(out.register).toEqual({ made: "rider", active: true, twoCharacters: true });
  });

  test("every write of every system is taken: stats, collectables, spells, bags, equipment, quests, cutscene views, achievements", () => {
    expect(out.perCharacterSteps).toEqual({
      stats: ["ran", "ran"],
      collectables: ["ran", "ran"],
      spells: ["ran", "ran"],
      bags: ["ran", "ran"],
      equipment: ["ran", "ran"],
      quests: Array(5).fill("ran"),
      views: ["ran", "ran"],
      achievements: Array(4).fill("ran"),
    });
  });

  test("each row is the character's it was written for, by its id", () => {
    expect(out.perCharacter).toEqual({
      // setStats writes health and stamina; the other character's level was raised.
      stats: [{ owner: "rider", health: 50, level: 1 }, { owner: "rider_alt", health: 100, level: 2 }],
      // The unicorn register gave rider was taken away; the horse is the other character's.
      collectables: [{ owner: "rider_alt", type: "mount", item: "horse" }],
      spells: [{ owner: "rider_alt", spell: "fire_ball" }],
      bags: [{ owner: "rider", slot_1: "Small Pouch" }, { owner: "rider_alt", slot_1: null }],
      equipment: [{ owner: "rider", helmet: "Iron Helm" }, { owner: "rider_alt", helmet: null }],
      questLog: [{ owner: "rider", quest_id: 1, state: "active" }, { owner: "rider_alt", quest_id: 1, state: "active" }],
      // 2 then 1 more: the second count updated the character's row; the other character's count is its own.
      questProgress: [{ owner: "rider", quest_id: 1, objective_id: 11, count: 3 }, { owner: "rider_alt", quest_id: 1, objective_id: 11, count: 4 }],
      // A scene seen twice is one row (the unique key on the id and the scene).
      views: [{ owner: "rider", cutscene: "Intro" }, { owner: "rider_alt", cutscene: "Outro" }],
      // Achievement 2 was raised in place by the upsert on (character_id, achievement_id); achievement 1 was completed.
      achievements: [
        { owner: "rider", achievement_id: 1, progress: 1, done: 1 },
        { owner: "rider", achievement_id: 2, progress: 3, done: 0 },
        { owner: "rider_alt", achievement_id: 2, progress: 7, done: 0 },
      ],
    });
  });

  test("read again, each character's systems answer only its own rows", () => {
    expect(out.perCharacterRead).toEqual({
      stats: { rider: { health: 50, level: 1 }, rider_alt: { health: 100, level: 2 } },
      collectables: { rider: [], rider_alt: ["horse"] },
      spells: { rider: [], rider_alt: ["fire_ball"] },
      bags: { rider: "Small Pouch", rider_alt: null },
      equipment: { rider: "Iron Helm", rider_alt: null },
      quests: { rider: [[1, 11, 3]], rider_alt: [[1, 11, 4]] },
      views: { rider: ["intro"], rider_alt: ["outro"] },
      achievements: { rider: [[1, 1, true], [2, 3, false]], rider_alt: [[2, 7, false]] },
    });
  });

  test("no row of these tables names an account, and none is without its character", () => {
    expect(out.perCharacterByName).toEqual([{ count: 0 }]);
    expect(out.perCharacterNoOwner).toEqual([{ count: 0 }]);
  });
});
