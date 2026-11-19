import { describe, expect, test, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { databaseModule, standInFor } from "./setup";

const db = new Database(":memory:");
db.exec("PRAGMA foreign_keys = ON");
const q = async (sql: string, params: any[] = []) => {
  if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return db.query(sql).all(...params);
  if (params.length === 0) db.exec(sql);
  else db.query(sql).run(...params);
  return { affectedRows: 1 };
};

await standInFor("../controllers/sqldatabase", () => databaseModule({ default: q }));

const { setupDatabase } = await import("../utility/database_setup_sqlite");
const { isValidCharacterName, nameKey, makeCharacterStore } = await import("../systems/characterstore");
const store = makeCharacterStore(q);

beforeAll(async () => {
  await setupDatabase();
});

const addAccount = (name: string): number => {
  db.query("INSERT INTO accounts (email, username, password_hash) VALUES (?, ?, 'x')").run(`${name}@example.com`, name);
  return Number((db.query("SELECT id FROM accounts WHERE username = ?").get(name) as any).id);
};
const addCharacter = (accountId: number, name: string, deletedAt: number | null = null): number => {
  db.query("INSERT INTO characters (account_id, name, name_key, created_at, deleted_at) VALUES (?, ?, ?, 1, ?)").run(accountId, name, name.toLowerCase(), deletedAt);
  return Number((db.query("SELECT id FROM characters WHERE name_key = ?").get(name.toLowerCase()) as any).id);
};

describe("character names", () => {
  test("accepts Ab_1 rejects ab and a 16-letter name", () => {
    expect(isValidCharacterName("Ab_1")).toBe(true);
    expect(isValidCharacterName("ab")).toBe(false);
    expect(isValidCharacterName("a".repeat(16))).toBe(false);
    expect(isValidCharacterName("a".repeat(15))).toBe(true);
    expect(isValidCharacterName("bad name")).toBe(false);
  });
  test("nameKey lowercases", () => {
    expect(nameKey("AbC_1")).toBe("abc_1");
  });
});

describe("character look-ups", () => {
  test("characterByName finds ALICE as Alice", async () => {
    const acc = addAccount("owner1");
    const id = addCharacter(acc, "Alice");
    const row = await store.characterByName("ALICE");
    expect(row).toEqual({ id, accountId: acc, name: "Alice", classId: null, deletedAt: null });
    expect(await store.characterById(id)).toEqual(row);
    expect(await store.characterById(999999)).toBeNull();
  });
  test("characterByName finds a grandfathered long name", async () => {
    const name = `guest_${"ab12".repeat(6)}`;
    const acc = addAccount("owner2");
    addCharacter(acc, name);
    expect((await store.characterByName(name.toUpperCase()))?.name).toBe(name);
  });
  test("characterByName skips a deleted character", async () => {
    const acc = addAccount("owner3");
    const id = addCharacter(acc, "Gone", 12345);
    expect(await store.characterByName("gone")).toBeNull();
    expect((await store.characterById(id))?.deletedAt).toBe(12345);
  });
});

describe("nameTaken", () => {
  test("true for another account's username in other case", async () => {
    const a = addAccount("Bob");
    const other = addAccount("carol");
    expect(await store.nameTaken("bOB", other)).toBe(true);
    expect(a).not.toBe(other);
  });
  test("false for the account's own username", async () => {
    const a = addAccount("Dave");
    expect(await store.nameTaken("dave", a)).toBe(false);
  });
  test("true for any character name, deleted included", async () => {
    const a = addAccount("erin");
    addCharacter(a, "Zed", 5);
    expect(await store.nameTaken("ZED", a)).toBe(true);
    expect(await store.nameTaken("free_name", a)).toBe(false);
  });
});
