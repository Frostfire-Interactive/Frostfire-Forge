import { describe, expect, test, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { databaseModule, standInFor } from "./setup";
import { CHARACTER_TABLES } from "../utility/charactertables";

// The schema for many characters per account, as database_setup_sqlite.ts makes it, in an in-memory SQLite database
// (foreign keys on, as the engine's connection has them). The setup's own query function is this database.

const db = new Database(":memory:");
db.exec("PRAGMA foreign_keys = ON");

await standInFor("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, params: any[] = []) => {
    if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return db.query(sql).all(...params);
    if (params.length === 0) db.exec(sql);
    else db.query(sql).run(...params);
    return { affectedRows: 1 };
  },
}));

const { setupDatabase } = await import("../utility/database_setup_sqlite");

beforeAll(async () => {
  await setupDatabase();
});

const addAccount = (name: string): number => {
  db.query("INSERT INTO accounts (email, username, password_hash) VALUES (?, ?, 'x')").run(`${name}@example.com`, name);
  return Number((db.query("SELECT id FROM accounts WHERE username = ?").get(name) as any).id);
};

const addCharacter = (accountId: number, name: string): number => {
  db.query("INSERT INTO characters (account_id, name, name_key, created_at) VALUES (?, ?, ?, 1)").run(accountId, name, name.toLowerCase());
  return Number((db.query("SELECT id FROM characters WHERE name_key = ?").get(name.toLowerCase()) as any).id);
};

describe("characters schema", () => {
  test("characters table has a unique name_key", () => {
    const indexes = db.query("PRAGMA index_list(characters)").all() as any[];
    const unique = indexes.filter((index) => index.unique).map((index) => (db.query(`PRAGMA index_info(${index.name})`).all() as any[]).map((c) => c.name));
    expect(unique).toContainEqual(["name_key"]);
    expect((db.query("PRAGMA index_list(characters)").all() as any[]).some((index) => index.name === "idx_characters_account")).toBe(true);
  });

  test("a 30-character name (a guest's) inserts whole", () => {
    const name = `guest_${"ab12".repeat(6)}`;
    expect(name.length).toBe(30);
    const account = addAccount(name);
    const id = addCharacter(account, name);
    expect((db.query("SELECT name, name_key FROM characters WHERE id = ?").get(id) as any)).toEqual({ name, name_key: name });
  });

  test("inserting Alice then alice into characters fails", () => {
    const account = addAccount("owner1");
    addCharacter(account, "Alice");
    expect(() => addCharacter(account, "alice")).toThrow();
  });

  test("deleting an account deletes its characters and their stats rows", () => {
    const account = addAccount("owner2");
    const character = addCharacter(account, "Bob");
    db.query("INSERT INTO stats (character_id) VALUES (?)").run(character);
    db.query("INSERT INTO quest_log (character_id, quest_id) VALUES (?, 7)").run(character);
    expect(Number((db.query("SELECT COUNT(*) AS n FROM stats WHERE character_id = ?").get(character) as any).n)).toBe(1);

    db.query("DELETE FROM accounts WHERE id = ?").run(account);

    expect(Number((db.query("SELECT COUNT(*) AS n FROM characters WHERE id = ?").get(character) as any).n)).toBe(0);
    expect(Number((db.query("SELECT COUNT(*) AS n FROM stats WHERE character_id = ?").get(character) as any).n)).toBe(0);
    expect(Number((db.query("SELECT COUNT(*) AS n FROM quest_log WHERE character_id = ?").get(character) as any).n)).toBe(0);
  });

  test("deleting a character nulls active_character_id", () => {
    const account = addAccount("owner3");
    const character = addCharacter(account, "Carol");
    db.query("UPDATE accounts SET active_character_id = ? WHERE id = ?").run(character, account);
    db.query("DELETE FROM characters WHERE id = ?").run(character);
    expect((db.query("SELECT active_character_id AS a FROM accounts WHERE id = ?").get(account) as any).a).toBeNull();
  });

  test("a character row makes the account's other characters' keys independent: two characters of one account each own a stats row", () => {
    const account = addAccount("owner4");
    const first = addCharacter(account, "Dan");
    const second = addCharacter(account, "Eve");
    db.query("INSERT INTO stats (character_id) VALUES (?)").run(first);
    db.query("INSERT INTO stats (character_id) VALUES (?)").run(second);
    expect(() => db.query("INSERT INTO stats (character_id) VALUES (?)").run(first)).toThrow();
  });

  test("every character table has character_id, its index, and a cascading foreign key", () => {
    for (const table of CHARACTER_TABLES) {
      const columns = (db.query(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name);
      expect(columns, table).toContain("character_id");
      const indexes = (db.query(`PRAGMA index_list(${table})`).all() as any[]).map((i) => i.name);
      expect(indexes, table).toContain(`idx_${table}_character`);
      const keys = db.query(`PRAGMA foreign_key_list(${table})`).all() as any[];
      expect(keys.some((k) => k.from === "character_id" && k.table === "characters" && k.on_delete === "CASCADE"), table).toBe(true);
    }
  });

  test("the account name columns of character tables are nullable", () => {
    for (const table of CHARACTER_TABLES) {
      const username = (db.query(`PRAGMA table_info(${table})`).all() as any[]).find((c) => c.name === "username");
      if (username) expect(username.notnull, table).toBe(0);
    }
  });

  test("name-pointer columns have id twins", () => {
    const has = (table: string, ...names: string[]) => {
      const columns = (db.query(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name);
      for (const name of names) expect(columns, `${table}.${name}`).toContain(name);
    };
    has("friendslist", "friend_id");
    has("ignores", "ignored_id");
    has("mail", "sender_id", "recipient_id");
    has("trade_log", "player_a_id", "player_b_id");
    has("reports", "reporter_id", "target_id", "target_account_id");
    has("parties", "leader_id");
    has("guilds", "leader_id");
  });

  test("setup can run again", async () => {
    await setupDatabase();
    const tables = (db.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'characters'").get() as any).n;
    expect(Number(tables)).toBe(1);
  });
});
