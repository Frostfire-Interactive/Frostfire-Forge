import { expect, mock, test } from "bun:test";
import { databaseModule } from "./setup";

// The quests and the NPCs that give and end them are held in memory on every node (systems/quests/definitions.ts).
// A save in the quest or NPC editor on one node writes the shared "quests" list; in a cluster the other nodes are told
// (services/assetCache.ts changedElsewhere) and read the definitions again, without writing the list back.

let questRows: any[] = [{ id: 1, name: "First" }];
let linkRows: any[] = [];
let reads = 0;
mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string) => {
    if (/FROM quests\b/.test(sql)) {
      reads++;
      return questRows;
    }
    if (/FROM npc_quests\b/.test(sql)) return linkRows;
    return [];
  },
}));
const { default: assetCache, changedElsewhere, onWrite } = await import("../services/assetCache");
const definitions = await import("../systems/quests/definitions");

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

test("a save here reads the definitions once", async () => {
  await definitions.list();
  await settle();
  expect(reads).toBe(1);
  expect(definitions.find(1)?.name).toBe("First");
});

test("a save on another node is read again here, and the list is not written back", async () => {
  questRows = [{ id: 1, name: "Renamed" }, { id: 2, name: "Second" }];
  linkRows = [{ npc_id: 7, quest_id: 2, role: "giver" }];
  const written: (string | null)[] = [];
  const stop = onWrite((key) => written.push(key));
  try {
    changedElsewhere("quests");
    await settle();
    expect(definitions.find(1)?.name).toBe("Renamed");
    expect(definitions.find(2)?.name).toBe("Second");
    expect(definitions.isGiver(7, 2)).toBe(true);
    expect(written).toEqual([]);
    expect(await assetCache.get("quests")).toHaveLength(1);
  } finally {
    stop();
  }
});
