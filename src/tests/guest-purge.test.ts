import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { databaseModule, standInFor } from "./setup";
import { CHARACTER_TABLES } from "../utility/charactertables";

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
const engineBefore = process.env.DATABASE_ENGINE;
process.env.DATABASE_ENGINE = "sqlite";
afterAll(() => {
  if (engineBefore === undefined) delete process.env.DATABASE_ENGINE;
  else process.env.DATABASE_ENGINE = engineBefore;
});
const { default: player } = await import("../systems/player");

beforeAll(async () => {
  await setupDatabase();
});

const one = (sql: string, ...params: any[]): any => db.query(sql).get(...params);
const count = (sql: string, ...params: any[]): number => Number(one(sql, ...params).n);
const req = { ip: "203.0.113.5", headers: {} };

async function guest(name: string): Promise<{ account: number; character: number }> {
  expect(await player.register(name, "guest:x", `${name}@example.test`, req, true)).toBe(name);
  db.query("UPDATE accounts SET guest_mode = 1 WHERE username = ?").run(name);
  const account = Number(one("SELECT id FROM accounts WHERE username = ?", name).id);
  return { account, character: Number(one("SELECT id FROM characters WHERE account_id = ?", account).id) };
}

describe("the start-up guest purge", () => {
  test("runs before the realm registers with the Gateway, so a Gateway that is down does not hold it back", async () => {
    const source = await Bun.file(new URL("../socket/server.ts", import.meta.url)).text();
    // At the top level of the start-up, not in a listener that runs later (Events.AWAKE is sent after registering).
    const purge = source.search(/^await clearShared\(/m);
    expect(purge).toBeGreaterThan(-1);
    expect(source.slice(purge, purge + 200)).toContain("player.clear()");
    expect(purge).toBeLessThan(source.indexOf("await gatewayClient.registerWithRetry()"));
  });

  test("a new guest has one active character named guest_...", async () => {
    const name = `guest_${"ab12".repeat(6)}`;
    const { account, character } = await guest(name);
    expect(count("SELECT COUNT(*) AS n FROM characters WHERE account_id = ?", account)).toBe(1);
    expect(one("SELECT name, name_key FROM characters WHERE id = ?", character)).toEqual({ name, name_key: name });
    expect(Number(one("SELECT active_character_id AS a FROM accounts WHERE id = ?", account).a)).toBe(character);
    // no class until it picks one: characters.class_id is what the login's CHARACTER_REQUIRED check reads
    expect(one("SELECT class_id AS c FROM characters WHERE id = ?", character).c).toBeNull();
  });

  test("purge leaves no row of the guest in any CHARACTER_TABLES table", async () => {
    const { account, character } = await guest("guest_purged");
    const real = await guest("guest_stays");
    db.query("UPDATE accounts SET guest_mode = 0 WHERE id = ?").run(real.account);

    // A row of the guest's character in every table of the list: register made some, the rest are added.
    const columns = (table: string) => (db.query(`PRAGMA table_info(${table})`).all() as any[]).filter((c) => c.notnull && c.dflt_value === null && !c.pk && c.name !== "character_id");
    const added: string[] = [];
    for (const table of CHARACTER_TABLES) {
      if (count(`SELECT COUNT(*) AS n FROM ${table} WHERE character_id = ?`, character) > 0) continue;
      const names = ["character_id", ...columns(table).map((c) => c.name)];
      const values = [character, ...columns(table).map((c) => (/INT|REAL|NUM/i.test(c.type) ? 1 : "x"))];
      db.query(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...values);
      added.push(table);
    }
    // Every table has a row of the guest's character now.
    for (const table of CHARACTER_TABLES) expect(count(`SELECT COUNT(*) AS n FROM ${table} WHERE character_id = ?`, character), table).toBeGreaterThan(0);
    db.query("INSERT INTO permissions (username, permissions) VALUES ('guest_purged', '')").run();
    // Mail the guest has sent: kept on the recipient's side, whose row names the sender by name and a dead id.
    const other = Number(one("SELECT character_id AS c FROM stats WHERE character_id = ?", real.character).c);
    db.query("INSERT INTO mail (recipient, sender, character_id, recipient_id, sender_id, subject, body, items, sent_at, expires_at) VALUES ('guest_stays', 'guest_purged', ?, ?, ?, 's', 'b', '[]', 1, 2)").run(other, other, character);

    await player.clear();

    expect(count("SELECT COUNT(*) AS n FROM accounts WHERE id = ?", account)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM characters WHERE account_id = ?", account)).toBe(0);
    for (const table of CHARACTER_TABLES) expect(count(`SELECT COUNT(*) AS n FROM ${table} WHERE character_id = ?`, character), table).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM permissions WHERE username = 'guest_purged'")).toBe(0);
    // A real account's character, whatever its history, is not touched.
    expect(count("SELECT COUNT(*) AS n FROM characters WHERE id = ?", real.character)).toBe(1);
    // What the guest sent stays with the player it was sent to.
    expect(count("SELECT COUNT(*) AS n FROM mail WHERE character_id = ? AND sender = 'guest_purged'", real.character)).toBe(1);
    expect(added.length).toBeGreaterThan(5);
  });

  test("rows from before character_id, keyed by a guest's name, are removed, also when its account is gone", async () => {
    const live = await guest("guest_oldrows");
    void live;
    const tables = ["bags", "stats", "currency", "equipment", "clientconfig", "collectables", "permissions", "mutes", "whitelist"];
    const required = (table: string) => (db.query(`PRAGMA table_info(${table})`).all() as any[]).filter((c) => c.notnull && c.dflt_value === null && !c.pk && c.name !== "username");
    const addNamed = (table: string, username: string) => {
      const names = ["username", ...required(table).map((c) => c.name)];
      const values = [username, ...required(table).map((c) => (/INT|REAL|NUM/i.test(c.type) ? 1 : "x"))];
      db.query(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...values);
    };
    for (const table of tables) {
      addNamed(table, "guest_oldrows");
      addNamed(table, "guest_longgone");
      addNamed(table, "realplayer");
    }
    // A player's ignore of a guest goes; of a player, stays.
    db.query("INSERT INTO ignores (username, ignored, created_at) VALUES ('realplayer', 'guest_longgone', 1), ('realplayer', 'otherplayer', 1)").run();

    await player.clear();

    expect(count("SELECT COUNT(*) AS n FROM ignores WHERE ignored = 'guest_longgone'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM ignores WHERE ignored = 'otherplayer'")).toBe(1);

    for (const table of tables) {
      expect(count(`SELECT COUNT(*) AS n FROM ${table} WHERE username IN ('guest_oldrows', 'guest_longgone')`), table).toBe(0);
      expect(count(`SELECT COUNT(*) AS n FROM ${table} WHERE username = 'realplayer'`), table).toBe(1);
    }
  });

  test("a guest-led guild and party are removed, and the members' guild reference with them", async () => {
    const lead = await guest("guest_leader");
    const member = await guest("guest_member");
    db.query("UPDATE accounts SET guest_mode = 0 WHERE id = ?").run(member.account);
    db.query("INSERT INTO guilds (name, leader, leader_id) VALUES ('GuestGuild', 'guest_leader', ?)").run(lead.character);
    const guild = Number(one("SELECT id FROM guilds WHERE name = 'GuestGuild'").id);
    db.query("UPDATE characters SET guild_id = ?, party_id = 5 WHERE id = ?").run(guild, member.character);
    db.query("INSERT INTO parties (leader, leader_id, character_id) VALUES ('guest_leader', ?, ?)").run(lead.character, lead.character);

    await player.clear();

    expect(count("SELECT COUNT(*) AS n FROM guilds WHERE id = ?", guild)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM parties")).toBe(0);
    expect(one("SELECT guild_id AS g, party_id AS p FROM characters WHERE id = ?", member.character)).toEqual({ g: null, p: null });
  });
});
