import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { databaseModule, standInFor } from "./setup";

// Engine login plays the account's active character (multiple characters per account, Task 5). The login worker's
// own code (socket/authentication.ts) runs against an in-memory SQLite database made by the engine's SQLite setup:
// token -> account -> accounts.active_character_id -> characters row.

let db = new Database(":memory:");

const run = (sql: string, params: any[] = []) => {
  if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return db.query(sql).all(...params);
  if (params.length === 0) db.exec(sql);
  else db.query(sql).run(...params);
  return { affectedRows: 1 };
};

await standInFor("../controllers/sqldatabase", () => databaseModule({ default: async (sql: string, params: any[] = []) => run(sql, params) }));

const { setupDatabase } = await import("../utility/database_setup_sqlite");
const { default: authentication } = await import("../socket/authentication");
const { decideLoginCharacter, sessionsOfAccount, kickDuplicateSessions } = await import("../systems/logincharacter");
const { packetManager } = await import("../socket/packet_manager");

let blank: Uint8Array;
const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  spyOn(console, "log").mockImplementation(() => {});
  await setupDatabase();
  // Columns a live database has from the login steps (e-mail check, two-factor); the base SQLite setup has neither.
  const columns = (db.query("PRAGMA table_info(accounts)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!columns.includes("email_verified")) db.exec("ALTER TABLE accounts ADD COLUMN email_verified INTEGER DEFAULT 1");
  if (!columns.includes("twofa_pending")) db.exec("ALTER TABLE accounts ADD COLUMN twofa_pending INTEGER DEFAULT 0");
  blank = db.serialize();
});

const one = (sql: string, ...params: any[]): any => db.query(sql).get(...params);

function fresh() {
  db = Database.deserialize(blank);
}

/** An account with a token that logs in. Its id. */
function account(username: string): number {
  db.query("INSERT INTO accounts (email, username, password_hash, token, token_expires, email_verified, twofa_pending, map, position) VALUES (?, ?, 'x', ?, ?, 1, 0, 'overworld', '0,0')")
    .run(`${username}@example.com`, username, `t-${username}`, Date.now() + HOUR);
  return Number(one("SELECT id FROM accounts WHERE username = ?", username).id);
}

/** A character of `accountId`. Its id. */
function character(accountId: number, name: string, over: { map?: string; position?: string; deleted?: boolean } = {}): number {
  db.query("INSERT INTO characters (account_id, name, name_key, class_id, map, position, direction, created_at, deleted_at) VALUES (?, ?, ?, NULL, ?, ?, 'left', 1, ?)")
    .run(accountId, name, name.toLowerCase(), over.map ?? "overworld", over.position ?? "0,0", over.deleted ? 5 : null);
  return Number(one("SELECT id FROM characters WHERE name_key = ?", name.toLowerCase()).id);
}

const activate = (accountId: number, characterId: number | null) =>
  db.query("UPDATE accounts SET active_character_id = ? WHERE id = ?").run(characterId, accountId);

describe("engine login", () => {
  test("login loads the active character's name and map", async () => {
    fresh();
    const acc = account("lillious");
    character(acc, "Older", { map: "overworld", position: "1,1" });
    const chosen = character(acc, "Frosty", { map: "cave", position: "40,72" });
    activate(acc, chosen);
    // The character's rows, keyed by character_id; a row of the account's other character is not read.
    db.query("INSERT INTO stats (username, character_id, health, max_health, level) VALUES ('lillious', ?, 33, 100, 7)").run(chosen);
    db.query("INSERT INTO currency (username, character_id, gold) VALUES ('lillious', ?, 9)").run(chosen);
    db.query("INSERT INTO inventory (username, character_id, item, quantity) VALUES ('lillious', ?, 'Potion', 2)").run(chosen);

    const result = await authentication.process("t-lillious", "801");

    expect(result.authenticated).toBe(true);
    expect(result.error).toBeNull();
    expect((result as any).characterRequired).toBeUndefined();
    const data = result.data as any;
    expect(data.username).toBe("Frosty");
    expect(data.characterId).toBe(chosen);
    expect(data.accountId).toBe(acc);
    expect(data.accountUsername).toBe("lillious");
    expect(data.location).toEqual({ map: "cave", position: { x: 40, y: 72, direction: "left" } });
    expect(data.stats.level).toBe(7);
    expect(data.currency.gold).toBe(9);
    expect(data.inventory.map((i: any) => i.item)).toEqual(["Potion"]);
    // The session is the account's.
    expect(one("SELECT session_id, online FROM accounts WHERE id = ?", acc)).toEqual({ session_id: "801", online: 1 });
  });

  test("login with no active character is refused with CHARACTER_REQUIRED", async () => {
    fresh();
    const acc = account("newcomer");
    const result = await authentication.process("t-newcomer", "802");
    expect(result).toMatchObject({ authenticated: true, completed: true, characterRequired: true, data: null, error: null });
    // The account never got into the game: it is not left online.
    expect(one("SELECT session_id, online FROM accounts WHERE id = ?", acc)).toEqual({ session_id: null, online: 0 });

    // A deleted active character is no character.
    const gone = character(acc, "Gone", { deleted: true });
    activate(acc, gone);
    expect(await authentication.process("t-newcomer", "803")).toMatchObject({ characterRequired: true, data: null });

    // The packet the client answers by going to /character.
    const sent = JSON.parse(new TextDecoder().decode(packetManager.characterRequired()[0]));
    expect(sent).toEqual({ type: "CHARACTER_REQUIRED", data: null });
  });

  test("login with an active character of another account is refused", async () => {
    fresh();
    const mine = account("mine");
    const theirs = account("theirs");
    const theirCharacter = character(theirs, "Theirchar");
    activate(mine, theirCharacter);
    const result = await authentication.process("t-mine", "804");
    expect(result).toMatchObject({ authenticated: true, characterRequired: true, data: null, error: null });
    expect(one("SELECT session_id, online FROM accounts WHERE id = ?", mine)).toEqual({ session_id: null, online: 0 });
  });

  test("the decision: token's account, its active character, or a refusal", () => {
    const account = { id: 4, username: "ann", activeCharacterId: 9 };
    const row = (over: any = {}) => ({ id: 9, accountId: 4, name: "Annie", classId: null, deletedAt: null, ...over });
    expect(decideLoginCharacter(account, row())).toEqual({ ok: true, accountId: 4, accountUsername: "ann", characterId: 9, characterName: "Annie" });
    expect(decideLoginCharacter({ ...account, activeCharacterId: null }, null)).toEqual({ ok: false, reason: "no_active_character" });
    expect(decideLoginCharacter(account, null)).toEqual({ ok: false, reason: "character_missing" });
    expect(decideLoginCharacter(account, row({ deletedAt: 3 }))).toEqual({ ok: false, reason: "character_deleted" });
    expect(decideLoginCharacter(account, row({ accountId: 5 }))).toEqual({ ok: false, reason: "character_of_another_account" });
    expect(decideLoginCharacter(account, row({ id: 8 }))).toEqual({ ok: false, reason: "character_missing" });
  });
});

describe("a second login of the same account", () => {
  test('a second login of the account saves then kicks the first with "You have been logged in from another location."', async () => {
    const events: string[] = [];
    const players = [
      { id: "1", username: "Frosty", accountId: 4 },
      // Another character of the same account: it is the same account in the game twice.
      { id: "2", username: "Older", accountId: 4 },
      // Another account whose character has the account's old name: not this account.
      { id: "3", username: "ann", accountId: 7 },
    ];
    const kicked = sessionsOfAccount(players, 4);
    expect(kicked.map((p) => p.id)).toEqual(["1", "2"]);

    let saved: () => void = () => {};
    const kicking = kickDuplicateSessions(kicked, {
      save: (p) => new Promise<void>((resolve) => {
        events.push(`save:${p.id}`);
        saved = () => { events.push(`saved:${p.id}`); resolve(); };
      }),
      leave: (p) => events.push(`leave:${p.id}`),
      notify: (p, message) => events.push(`notify:${p.id}:${message}`),
      drop: async (p) => { events.push(`drop:${p.id}`); },
    });
    await Promise.resolve();
    // Nothing is said to the old session before its save has landed.
    expect(events).toEqual(["save:1"]);
    saved();
    await new Promise((r) => setTimeout(r, 0));
    saved();
    await kicking;
    expect(events).toEqual([
      "save:1", "saved:1", "leave:1", "notify:1:You have been logged in from another location.", "drop:1",
      "save:2", "saved:2", "leave:2", "notify:2:You have been logged in from another location.", "drop:2",
    ]);
  });

  test("a save that fails still kicks", async () => {
    const events: string[] = [];
    await kickDuplicateSessions([{ id: "1", accountId: 4 }], {
      save: async () => { throw new Error("db down"); },
      leave: (p) => events.push(`leave:${p.id}`),
      notify: (_p, message) => events.push(`notify:${message}`),
      drop: (p) => { events.push(`drop:${p.id}`); },
    });
    expect(events).toEqual(["leave:1", "notify:You have been logged in from another location.", "drop:1"]);
  });

  test("a leave or a drop that throws is logged, and the next session is still kicked", async () => {
    const events: string[] = [];
    await kickDuplicateSessions([{ id: "1", accountId: 4 }, { id: "2", accountId: 4 }], {
      save: async (p) => { events.push(`save:${p.id}`); },
      leave: (p) => { events.push(`leave:${p.id}`); if (p.id === "1") throw new Error("listener threw"); },
      notify: (p) => events.push(`notify:${p.id}`),
      drop: (p) => { events.push(`drop:${p.id}`); if (p.id === "1") throw new Error("drop threw"); },
    });
    expect(events).toEqual(["save:1", "leave:1", "notify:1", "drop:1", "save:2", "leave:2", "notify:2", "drop:2"]);
  });

  test("the login wiring: kicked by account, saved first; CHARACTER_REQUIRED sent for a refused character", () => {
    const receiver = readFileSync(new URL("../socket/receiver.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const login = receiver.slice(receiver.indexOf("async function completeLogin("));
    expect(login).toContain("sessionsOfAccount(Object.values(playerCache.list()), playerData.accountId)");
    expect(login).toContain("await kickDuplicateSessions(");
    expect(login).toContain("save: saveKickedPlayer,");
    expect(login).toContain("leave: leaveKickedPlayer,");
    // The drop takes the session out of the cache whatever throws before: marked leftByKick, its close would skip it.
    const drop = login.slice(login.indexOf("drop: async (p: any) => {"));
    expect(drop.slice(0, drop.indexOf("\n      },"))).toMatch(/\} finally \{\n\s*playerCache\.remove\(p\.id\);\n\s*forgetNpcStream\(p\.id\);\n\s*\}$/);
    const refused = login.indexOf("if (status.characterRequired) {");
    expect(refused).toBeGreaterThan(0);
    expect(login.indexOf("sendPacket(wt, packetManager.characterRequired());", refused)).toBeGreaterThan(refused);
    expect(refused).toBeLessThan(login.indexOf("if (status.error && !status.authenticated)"));
  });
});
