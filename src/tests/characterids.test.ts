import { beforeEach, describe, expect, test } from "bun:test";
import { databaseModule, standInFor } from "./setup";

// systems/characterids.ts: the characters.id a character's rows are kept by, found from its name.

const asked: Array<{ sql: string; values: any[] }> = [];
const characters = new Map<string, { id: number; deleted_at: number | null }>();
const online = new Map<string, any>();

await standInFor("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, values: any[] = []) => {
    asked.push({ sql, values });
    if (sql.startsWith("SELECT id FROM characters WHERE name_key = ? AND deleted_at IS NULL")) {
      const row = characters.get(values[0]);
      return row && row.deleted_at === null ? [{ id: row.id }] : [];
    }
    return [];
  },
}));
await standInFor("../services/playermanager", () => ({
  default: { getByUsername: (name: string) => online.get(name) },
}));

const { characterIdOf, needCharacterId, NoSuchCharacter } = await import("../systems/characterids");

beforeEach(() => {
  asked.length = 0;
  characters.clear();
  online.clear();
});

describe("characterIdOf", () => {
  test("is the database's id for the name, whatever its case", async () => {
    characters.set("hero", { id: 42, deleted_at: null });
    expect(await characterIdOf("Hero")).toBe(42);
    expect(await characterIdOf("HERO")).toBe(42);
    const ask = { sql: "SELECT id FROM characters WHERE name_key = ? AND deleted_at IS NULL LIMIT 1", values: ["hero"] };
    expect(asked).toEqual([ask, ask]);
  });

  test("an online player's own id is taken without asking", async () => {
    online.set("hero", { username: "Hero", characterId: 7 });
    expect(await characterIdOf("hero")).toBe(7);
    expect(asked).toEqual([]);
  });

  test("a name freed by a purged character and taken by a new one is the new one's", async () => {
    characters.set("hero", { id: 42, deleted_at: null });
    expect(await characterIdOf("hero")).toBe(42);
    characters.delete("hero");
    characters.set("hero", { id: 43, deleted_at: null });
    expect(await characterIdOf("hero")).toBe(43);
  });

  test("a player who went offline is asked of the database, not taken from when it was online", async () => {
    online.set("hero", { username: "Hero", characterId: 7 });
    expect(await characterIdOf("hero")).toBe(7);
    online.clear();
    characters.set("hero", { id: 8, deleted_at: null });
    expect(await characterIdOf("hero")).toBe(8);
  });

  test("null for no name, for no such character, and for a deleted one", async () => {
    characters.set("gone", { id: 3, deleted_at: 1 });
    expect(await characterIdOf("")).toBeNull();
    expect(await characterIdOf(null)).toBeNull();
    expect(await characterIdOf("nobody")).toBeNull();
    expect(await characterIdOf("gone")).toBeNull();
  });
});

describe("needCharacterId", () => {
  test("throws for a name that is no character's, so nothing is written for it", async () => {
    await expect(needCharacterId("nobody")).rejects.toBeInstanceOf(NoSuchCharacter);
    characters.set("hero", { id: 42, deleted_at: null });
    expect(await needCharacterId("hero")).toBe(42);
  });
});
