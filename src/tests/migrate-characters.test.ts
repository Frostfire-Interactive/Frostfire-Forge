import { describe, expect, test, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { databaseModule, standInFor } from "./setup";
import { CHARACTER_TABLES } from "../utility/charactertables";

let db = new Database(":memory:");
db.exec("PRAGMA foreign_keys = ON");

const run = (sql: string, params: any[] = []) => {
  if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return db.query(sql).all(...params);
  if (params.length === 0) db.exec(sql);
  else db.query(sql).run(...params);
  return { affectedRows: 1 };
};

await standInFor("../controllers/sqldatabase", () => databaseModule({ default: async (sql: string, params: any[] = []) => run(sql, params) }));

const { setupDatabase } = await import("../utility/database_setup_sqlite");
const { migrateCharacters } = await import("../utility/migrate_characters");

let blank: Uint8Array;

beforeAll(async () => {
  await setupDatabase();
  blank = db.serialize();
});

const ask = async (sql: string, values: unknown[] = []) => run(sql, values as any[]) as any[];
const migrate = () => migrateCharacters(ask, { dialect: "sqlite" });
const one = (sql: string, ...params: any[]): any => db.query(sql).get(...params);
const all = (sql: string, ...params: any[]): any[] => db.query(sql).all(...params);

/** A fresh database holding the fixture. */
function fixture(extra?: () => void) {
  db = Database.deserialize(blank);
  db.exec("PRAGMA foreign_keys = ON");
  const account = (name: string, map: string) =>
    db.query("INSERT INTO accounts (email, username, password_hash, map, position, class_id) VALUES (?, ?, 'x', ?, '3,4', 2)").run(`${name}@example.com`, name, map);
  account("Alice", "overworld");
  account("Bob", "cave");
  for (const [name, health] of [["Alice", 80], ["Bob", 60]] as const) {
    db.query("INSERT INTO stats (username, health, level) VALUES (?, ?, 5)").run(name, health);
    db.query("INSERT INTO inventory (username, item, quantity) VALUES (?, 'Sword', 1)").run(name);
    db.query("INSERT INTO inventory (username, item, quantity) VALUES (?, 'Potion', 3)").run(name);
    db.query("INSERT INTO quest_log (username, quest_id) VALUES (?, 7)").run(name);
    db.query("INSERT INTO currency (username, copper) VALUES (?, 12)").run(name);
  }
  db.query("INSERT INTO friendslist (username, friends) VALUES ('Alice', 'Bob')").run();
  db.query("INSERT INTO friendslist (username, friends) VALUES ('Bob', 'alice')").run();
  db.query("INSERT INTO ignores (username, ignored, created_at) VALUES ('Alice', 'Bob', 1)").run();
  db.query("INSERT INTO mail (recipient, sender, subject, body, items, sent_at, expires_at) VALUES ('Bob', 'Alice', 's', 'b', '[]', 1, 2)").run();
  db.query("INSERT INTO mail (recipient, sender, subject, body, items, sent_at, expires_at) VALUES ('Nobody', 'Alice', 's2', 'b2', '[]', 1, 2)").run();
  db.query("INSERT INTO reports (reporter, target, category, chat_log, created_at) VALUES ('Alice', 'Bob', 'spam', '', 1)").run();
  extra?.();
}

/** Every table's rows, in a stable order, for comparing two databases. */
const dump = (): string => JSON.stringify([
  ...["accounts", "characters", ...CHARACTER_TABLES].map((table) => [table, all(`SELECT * FROM ${table}`).map((row) => JSON.stringify(row)).sort()]),
]);

describe("migrateCharacters", () => {
  test("makes one character per account named after it", async () => {
    fixture();
    const report = await migrate();
    expect(report.charactersMade).toBe(2);
    expect(report.renamed).toEqual([]);
    const characters = all("SELECT c.name, c.name_key, c.map, c.position, c.class_id, a.username, a.active_character_id, c.id FROM characters c JOIN accounts a ON a.id = c.account_id ORDER BY c.id");
    expect(characters.map((c) => [c.name, c.name_key, c.map, c.position, c.class_id])).toEqual([
      ["Alice", "alice", "overworld", "3,4", 2],
      ["Bob", "bob", "cave", "3,4", 2],
    ]);
    for (const c of characters) expect(c.active_character_id).toBe(c.id);
  });

  test("fills character_id on every table", async () => {
    fixture();
    await migrate();
    for (const table of ["stats", "inventory", "quest_log", "currency", "friendslist", "ignores", "mail", "reports"]) {
      expect(one(`SELECT COUNT(*) AS n FROM ${table} WHERE character_id IS NULL`).n).toBe(table === "mail" ? 1 : 0);
    }
    const alice = one("SELECT id FROM characters WHERE name = 'Alice'").id;
    expect(one("SELECT character_id FROM stats WHERE username = 'Alice'").character_id).toBe(alice);
    expect(one("SELECT COUNT(*) AS n FROM inventory WHERE character_id = ?", alice).n).toBe(2);
    expect(one("SELECT character_id FROM reports").character_id).toBe(alice);
    const bob = one("SELECT id, account_id FROM characters WHERE name = 'Bob'");
    expect(one("SELECT target_id, target_account_id FROM reports")).toEqual({ target_id: bob.id, target_account_id: bob.account_id });
  });

  test("friend_id stays NULL (a friends list is a comma list); the other pointers fill", async () => {
    fixture();
    await migrate();
    const alice = one("SELECT id FROM characters WHERE name = 'Alice'").id;
    const bob = one("SELECT id FROM characters WHERE name = 'Bob'").id;
    expect(all("SELECT friend_id FROM friendslist").map((r) => r.friend_id)).toEqual([null, null]);
    expect(one("SELECT COUNT(*) AS n FROM friendslist WHERE character_id IS NOT NULL").n).toBe(2);
    expect(one("SELECT ignored_id FROM ignores").ignored_id).toBe(bob);
    expect(one("SELECT sender_id, recipient_id FROM mail WHERE subject = 's'")).toEqual({ sender_id: alice, recipient_id: bob });
  });

  test("a mail to an unknown name is kept with NULL and reported dangling", async () => {
    fixture();
    const report = await migrate();
    const row = one("SELECT character_id, recipient_id FROM mail WHERE subject = 's2'");
    expect(row).toEqual({ character_id: null, recipient_id: null });
    expect(report.dangling).toEqual([{ table: "mail", column: "recipient", value: "Nobody" }]);
  });

  test("running twice changes nothing the second time", async () => {
    fixture();
    await migrate();
    const once = dump();
    const second = await migrate();
    expect(second.charactersMade).toBe(0);
    expect(dump()).toBe(once);
  });

  test("a run stopped after stats then rerun matches a clean run", async () => {
    fixture();
    await migrate();
    const clean = dump().replace(/created_at[^,}]*/g, "");

    fixture();
    let failed = false;
    const stopping = (statements: { sql: string; values?: unknown[] }[]) => {
      // Fails the quest_log table's transaction, so the tables before it are done and the ones from it on are not
      if (!failed && statements.some((s) => s.sql.startsWith("UPDATE quest_log"))) {
        failed = true;
        throw new Error("stopped");
      }
      return Promise.resolve();
    };
    // Same SQLite transaction, but the one on quest_log is refused first
    const runner = async (statements: { sql: string; values?: unknown[] }[]) => {
      await stopping(statements);
      db.exec("BEGIN");
      try {
        for (const s of statements) run(s.sql, (s.values || []) as any[]);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    };
    await expect(migrateCharacters(ask, { dialect: "sqlite", transaction: runner })).rejects.toThrow("stopped");
    expect(one("SELECT COUNT(*) AS n FROM stats WHERE character_id IS NOT NULL").n).toBe(2);
    expect(one("SELECT COUNT(*) AS n FROM quest_log WHERE character_id IS NOT NULL").n).toBe(0);

    const rerun = await migrate();
    expect(rerun.charactersMade).toBe(0);
    expect(dump().replace(/created_at[^,}]*/g, "")).toBe(clean);
  });

  test("checksums match before and after", async () => {
    fixture();
    const report = await migrate();
    expect(Object.keys(report.rows).sort()).toEqual([...CHARACTER_TABLES].sort());
    for (const [table, row] of Object.entries(report.rows)) {
      expect(row.checksumAfter).toBe(row.checksumBefore);
      expect(row.after).toBe(row.before);
      expect(typeof row.checksumBefore).toBe("string");
      void table;
    }
    expect(report.rows.inventory.before).toBe(4);
    expect(report.rows.mail.before).toBe(1);
  });

  test("a changed row makes the checksums differ", async () => {
    fixture();
    // A row that is lost on the way: its account name is not an account, so it is outside both sides; but changing data between is seen
    const report = await migrate();
    db.query("UPDATE stats SET health = 1 WHERE username = 'Alice'").run();
    const again = await migrate();
    expect(again.rows.stats.checksumBefore).not.toBe(report.rows.stats.checksumBefore);
    expect(again.rows.stats.checksumAfter).toBe(again.rows.stats.checksumBefore);
  });

  test("a name taken ignoring case gets a suffixed name, reported as renamed", async () => {
    fixture(() => {
      db.query("INSERT INTO accounts (email, username, password_hash) VALUES ('a2@example.com', 'ALICE', 'x')").run();
      db.query("INSERT INTO accounts (email, username, password_hash) VALUES ('long@example.com', 'LongNameNumber1', 'x')").run();
      db.query("INSERT INTO accounts (email, username, password_hash) VALUES ('long2@example.com', 'longnamenumber1', 'x')").run();
      db.query("INSERT INTO stats (username, health) VALUES ('ALICE', 33)").run();
    });
    const report = await migrate();
    expect(report.charactersMade).toBe(5);
    const second = one("SELECT c.name, c.name_key FROM characters c JOIN accounts a ON a.id = c.account_id WHERE a.username = 'ALICE'");
    expect(second).toEqual({ name: "ALICE_2", name_key: "alice_2" });
    const longer = one("SELECT c.name FROM characters c JOIN accounts a ON a.id = c.account_id WHERE a.username = 'longnamenumber1'").name;
    expect(longer).toBe("longnamenumber1_2");
    expect(longer.length).toBeLessThanOrEqual(191);
    expect(report.renamed.map((r) => [r.username, r.name])).toEqual([["ALICE", "ALICE_2"], ["longnamenumber1", "longnamenumber1_2"]]);
    // The renamed account's own rows follow it, not the first Alice
    expect(one("SELECT c.name FROM stats s JOIN characters c ON c.id = s.character_id WHERE s.username = 'ALICE'").name).toBe("ALICE_2");
    expect(one("SELECT c.name FROM stats s JOIN characters c ON c.id = s.character_id WHERE s.username = 'Alice'").name).toBe("Alice");
    expect(report.rows.stats.checksumAfter).toBe(report.rows.stats.checksumBefore);
  });

  test("a 30-character guest name becomes the character's name whole", async () => {
    const guest = `guest_${"ab12cd34".repeat(3)}`;
    expect(guest.length).toBe(30);
    fixture(() => {
      db.query("INSERT INTO accounts (email, username, password_hash) VALUES ('g@example.com', ?, 'x')").run(guest);
      db.query("INSERT INTO accounts (email, username, password_hash) VALUES ('g2@example.com', ?, 'x')").run(guest.toUpperCase());
      db.query("INSERT INTO stats (username, health) VALUES (?, 9)").run(guest);
    });
    const report = await migrate();
    expect(one("SELECT c.name, c.name_key FROM characters c JOIN accounts a ON a.id = c.account_id WHERE a.username = ?", guest)).toEqual({ name: guest, name_key: guest });
    const second = one("SELECT c.name FROM characters c JOIN accounts a ON a.id = c.account_id WHERE a.username = ?", guest.toUpperCase()).name;
    expect(second).toBe(`${guest.toUpperCase()}_2`);
    expect(second.length).toBeLessThanOrEqual(191);
    expect(report.renamed.length).toBe(1);
    expect(one("SELECT c.name FROM stats s JOIN characters c ON c.id = s.character_id WHERE s.username = ?", guest).name).toBe(guest);
  });

  test("a small chunk size gives the same result as one chunk", async () => {
    const more = () => {
      for (let i = 0; i < 7; i++) {
        db.query("INSERT INTO accounts (email, username, password_hash) VALUES (?, ?, 'x')").run(`u${i}@example.com`, `user${i}`);
        db.query("INSERT INTO stats (username, health) VALUES (?, ?)").run(`user${i}`, i);
        db.query("INSERT INTO inventory (username, item, quantity) VALUES (?, 'Gem', ?)").run(`user${i}`, i + 1);
        db.query("INSERT INTO mail (recipient, sender, subject, body, items, sent_at, expires_at) VALUES (?, 'Alice', 'm', 'b', '[]', 1, 2)").run(`user${i}`);
      }
    };
    fixture(more);
    const whole = await migrateCharacters(ask, { dialect: "sqlite", chunkSize: 1000 });
    const wholeDump = dump().replace(/created_at[^,}]*/g, "");
    fixture(more);
    const small = await migrateCharacters(ask, { dialect: "sqlite", chunkSize: 2 });
    expect(small.charactersMade).toBe(whole.charactersMade);
    expect(small.rows).toEqual(whole.rows);
    expect(small.dangling).toEqual(whole.dangling);
    expect(dump().replace(/created_at[^,}]*/g, "")).toBe(wholeDump);
    expect(one("SELECT COUNT(*) AS n FROM stats WHERE character_id IS NULL").n).toBe(0);
  });

  test("mail to ALICE lands on ALICE's character, not Alice's", async () => {
    fixture(() => {
      db.query("INSERT INTO accounts (email, username, password_hash) VALUES ('a2@example.com', 'ALICE', 'x')").run();
      db.query("INSERT INTO mail (recipient, sender, subject, body, items, sent_at, expires_at) VALUES ('ALICE', 'Bob', 'toBig', 'b', '[]', 1, 2)").run();
    });
    const report = await migrate();
    const big = one("SELECT c.id FROM characters c JOIN accounts a ON a.id = c.account_id WHERE a.username = 'ALICE'").id;
    const small = one("SELECT id FROM characters WHERE name = 'Alice'").id;
    expect(one("SELECT character_id, recipient_id FROM mail WHERE subject = 'toBig'")).toEqual({ character_id: big, recipient_id: big });
    expect(one("SELECT character_id FROM mail WHERE subject = 's'").character_id).not.toBe(small);
    expect(report.rows.mail.checksumAfter).toBe(report.rows.mail.checksumBefore);

    // A row attached to the wrong one of the two is seen on the next run
    db.query("UPDATE mail SET character_id = ? WHERE subject = 'toBig'").run(small);
    const again = await migrate();
    expect(again.rows.mail.checksumAfter).not.toBe(again.rows.mail.checksumBefore);
  });
});
