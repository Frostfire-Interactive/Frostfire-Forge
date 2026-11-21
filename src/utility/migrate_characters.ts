import { createHash } from "crypto";
import { CHARACTER_TABLES } from "./charactertables";

type Ask = (sql: string, values?: unknown[]) => Promise<any[]>;
type Statement = { sql: string; values?: unknown[] };
type RunAll = (statements: Statement[]) => Promise<unknown>;

export type MigrationReport = {
  charactersMade: number;
  /** Accounts whose character got a suffixed name because another character already had theirs (ignoring case). */
  renamed: { accountId: number; username: string; name: string }[];
  rows: Record<string, { before: number; after: number; checksumBefore: string; checksumAfter: string }>;
  dangling: { table: string; column: string; value: string }[];
};

export type MigrateOptions = {
  /** Which database `ask` talks to: decides how a transaction is made when `transaction` is not given. */
  dialect: "mysql" | "sqlite";
  /** Runs statements as one transaction (the engine's own, for MySQL). Without it SQLite uses BEGIN/COMMIT on `ask`. */
  transaction?: RunAll;
  /** How many names, ids or accounts one transaction or one read takes (default 500). */
  chunkSize?: number;
};

/** Where a table's rows say whose they are, and its name pointers (each with the id column that gets filled). */
type TableSpec = { owner: string; pointers: { column: string; twin: string }[] };

// friendslist keeps its friends as one comma list, which one friend_id cannot hold: it gets no pointer here.
const TABLE_SPECS: Record<string, TableSpec> = {
  ignores: { owner: "username", pointers: [{ column: "ignored", twin: "ignored_id" }] },
  parties: { owner: "leader", pointers: [{ column: "leader", twin: "leader_id" }] },
  mail: { owner: "recipient", pointers: [{ column: "sender", twin: "sender_id" }, { column: "recipient", twin: "recipient_id" }] },
  trade_log: { owner: "player_a", pointers: [{ column: "player_a", twin: "player_a_id" }, { column: "player_b", twin: "player_b_id" }] },
  reports: { owner: "reporter", pointers: [{ column: "reporter", twin: "reporter_id" }, { column: "target", twin: "target_id" }] },
};

const specOf = (table: string): TableSpec => TABLE_SPECS[table] || { owner: "username", pointers: [] };

/** Columns that are keys, not data: left out of the checksums. */
const KEY_COLUMNS = new Set([
  "id", "username", "character_id", "friend_id", "ignored_id", "sender_id", "recipient_id", "player_a_id", "player_b_id",
  "reporter_id", "target_id", "target_account_id", "leader_id",
]);

/** characters.name_key is VARCHAR(191) on MySQL. */
const MAX_NAME = 191;

/** The id of the character a name belongs to: the account of that name first (exact), then a character of that name (any case). */
const byAccountOrName = (table: string, column: string) =>
  `COALESCE((SELECT c.id FROM characters c JOIN accounts a ON a.id = c.account_id WHERE a.username = ${table}.${column} ORDER BY c.id LIMIT 1), ` +
  `(SELECT c.id FROM characters c WHERE c.name_key = LOWER(${table}.${column})))`;

const plain = (value: unknown): unknown => (typeof value === "bigint" ? String(value) : value);

/** The part of a row that is its data, as stable text. */
const dataOf = (row: Record<string, unknown>): string => {
  const keys = Object.keys(row).filter((key) => !KEY_COLUMNS.has(key) && key !== "__account").sort();
  return JSON.stringify(keys.map((key) => [key, plain(row[key])]));
};

/** One hash over a table's data rows grouped by owning account id, in a stable order. */
const checksum = (rows: { owner: number; data: string }[]): string => {
  const byOwner = new Map<number, string[]>();
  for (const row of rows) {
    const list = byOwner.get(row.owner) || [];
    list.push(row.data);
    byOwner.set(row.owner, list);
  }
  const hash = createHash("sha256");
  for (const owner of [...byOwner.keys()].sort((a, b) => a - b)) {
    hash.update(`${owner}\n${byOwner.get(owner)!.sort().join("\n")}\n`);
  }
  return hash.digest("hex");
};

/** A name that is free (ignoring case) and still within the column: the old name's start, then `_2`, `_3`, ... */
const freeName = (base: string, taken: Set<string>): string => {
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const name = base.slice(0, MAX_NAME - suffix.length) + suffix;
    if (!taken.has(name.toLowerCase())) return name;
  }
};

const marks = (n: number): string => Array(n).fill("?").join(", ");

export async function migrateCharacters(ask: Ask, options: MigrateOptions): Promise<MigrationReport> {
  const size = Math.max(1, options.chunkSize ?? 500);
  const runAll: RunAll = options.transaction || (async (statements) => {
    if (options.dialect !== "sqlite") throw new Error("migrateCharacters: MySQL needs the engine's transaction function");
    await ask("BEGIN");
    try {
      for (const statement of statements) await ask(statement.sql, statement.values);
      await ask("COMMIT");
    } catch (error) {
      await ask("ROLLBACK");
      throw error;
    }
  });

  /** The distinct values of `column` where `where` holds, in pages of `size` taken in order. */
  async function* pages(table: string, column: string, where: string): AsyncGenerator<unknown[]> {
    let last: unknown = null;
    for (;;) {
      const rows = ((await ask(
        `SELECT DISTINCT ${column} AS value FROM ${table} WHERE ${where} AND ${column} IS NOT NULL${last === null ? "" : ` AND ${column} > ?`} ORDER BY ${column} LIMIT ${size}`,
        last === null ? [] : [last]
      )) || []) as any[];
      if (rows.length === 0) return;
      const values = rows.map((row) => row.value);
      yield values;
      last = values[values.length - 1];
      if (rows.length < size) return;
    }
  }

  /** Runs `UPDATE table SET set WHERE where AND column IN (page)` for each page of `column` values still unset. */
  async function fill(table: string, column: string, set: string, where: string) {
    for await (const page of pages(table, column, where)) {
      await runAll([{ sql: `UPDATE ${table} SET ${set} WHERE ${where} AND ${column} IN (${marks(page.length)})`, values: page }]);
    }
  }

  const report: MigrationReport = { charactersMade: 0, renamed: [], rows: {}, dangling: [] };

  // The accounts, to say which one a name belongs to: exact name first, then any case
  const exact = new Map<string, number>();
  const folded = new Map<string, number>();
  for await (const ids of pages("accounts", "id", "1 = 1")) {
    const accounts = (await ask(`SELECT id, username FROM accounts WHERE id IN (${marks(ids.length)})`, ids)) as any[];
    for (const account of accounts) {
      const name = String(account.username);
      exact.set(name, Number(account.id));
      if (!folded.has(name.toLowerCase())) folded.set(name.toLowerCase(), Number(account.id));
    }
  }
  const accountOf = (name: unknown): number | undefined => exact.get(String(name)) ?? folded.get(String(name).toLowerCase());

  // Before: every table's data rows, keyed by the account their name belongs to now
  const before = new Map<string, { owner: number; data: string }[]>();
  for (const table of CHARACTER_TABLES) {
    const owner = specOf(table).owner;
    const kept: { owner: number; data: string }[] = [];
    for await (const names of pages(table, owner, "1 = 1")) {
      const rows = (await ask(`SELECT * FROM ${table} WHERE ${owner} IN (${marks(names.length)})`, names)) as Record<string, unknown>[];
      for (const row of rows) {
        const account = accountOf(row[owner]);
        if (account !== undefined) kept.push({ owner: account, data: dataOf(row) });
      }
    }
    before.set(table, kept);
  }

  // Characters: one for each account that has none, a chunk of accounts to a transaction
  const taken = new Set<string>();
  for await (const ids of pages("characters", "id", "1 = 1")) {
    for (const row of (await ask(`SELECT name_key FROM characters WHERE id IN (${marks(ids.length)})`, ids)) as any[]) {
      taken.add(String(row.name_key).toLowerCase());
    }
  }
  const now = Date.now();
  for (let last = 0; ;) {
    const accounts = ((await ask(
      `SELECT a.id, a.username, a.class_id, a.map, a.position, a.direction, a.is_dead, a.corpse_map, a.corpse_x, a.corpse_y,
              a.stealth, a.noclip, a.party_id, a.guild_id
       FROM accounts a WHERE a.id > ? AND NOT EXISTS (SELECT 1 FROM characters c WHERE c.account_id = a.id) ORDER BY a.id LIMIT ${size}`,
      [last]
    )) || []) as any[];
    if (accounts.length === 0) break;
    const statements: Statement[] = [];
    const renamed: MigrationReport["renamed"] = [];
    const names: string[] = [];
    for (const account of accounts) {
      let name = String(account.username);
      if (taken.has(name.toLowerCase())) {
        name = freeName(name, taken);
        renamed.push({ accountId: Number(account.id), username: String(account.username), name });
      }
      names.push(name.toLowerCase());
      taken.add(name.toLowerCase());
      statements.push({
        sql: `INSERT INTO characters (account_id, name, name_key, class_id, map, position, direction, is_dead, corpse_map, corpse_x, corpse_y,
                stealth, noclip, party_id, guild_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        values: [account.id, name, name.toLowerCase(), account.class_id, account.map, account.position, account.direction, account.is_dead,
          account.corpse_map, account.corpse_x, account.corpse_y, account.stealth, account.noclip, account.party_id, account.guild_id, now],
      });
    }
    try {
      await runAll(statements);
    } catch (error) {
      for (const name of names) taken.delete(name);
      throw error;
    }
    report.charactersMade += accounts.length;
    report.renamed.push(...renamed);
    last = Number(accounts[accounts.length - 1].id);
  }
  await fill(
    "accounts", "id",
    "active_character_id = (SELECT c.id FROM characters c WHERE c.account_id = accounts.id ORDER BY c.id LIMIT 1)",
    "active_character_id IS NULL AND EXISTS (SELECT 1 FROM characters c WHERE c.account_id = accounts.id)"
  );

  // Each table: the owner key, then the id twins of its name pointers, a chunk of names to a transaction
  for (const table of CHARACTER_TABLES) {
    const spec = specOf(table);
    await fill(table, spec.owner, `character_id = ${byAccountOrName(table, spec.owner)}`, "character_id IS NULL");
    for (const pointer of spec.pointers) {
      await fill(table, pointer.column, `${pointer.twin} = ${byAccountOrName(table, pointer.column)}`, `${pointer.twin} IS NULL`);
    }
    if (table === "reports") {
      await fill(
        "reports", "target_id",
        "target_account_id = (SELECT c.account_id FROM characters c WHERE c.id = reports.target_id)",
        "target_account_id IS NULL"
      );
    }
  }
  await fill("guilds", "leader", `leader_id = ${byAccountOrName("guilds", "leader")}`, "leader_id IS NULL");

  // After: the same rows, found by character_id and keyed by the account their character belongs to
  for (const table of CHARACTER_TABLES) {
    const after: { owner: number; data: string }[] = [];
    for await (const ids of pages(table, "character_id", "1 = 1")) {
      const rows = (await ask(
        `SELECT t.*, c.account_id AS __account FROM ${table} t JOIN characters c ON c.id = t.character_id WHERE t.character_id IN (${marks(ids.length)})`,
        ids
      )) as Record<string, unknown>[];
      for (const row of rows) after.push({ owner: Number(row.__account), data: dataOf(row) });
    }
    const was = before.get(table)!;
    report.rows[table] = { before: was.length, after: after.length, checksumBefore: checksum(was), checksumAfter: checksum(after) };

    // What names nobody: the owner key, and each name pointer
    const spec = specOf(table);
    const unresolved = [{ column: spec.owner, where: "character_id IS NULL" }, ...spec.pointers.map((p) => ({ column: p.column, where: `${p.twin} IS NULL` }))];
    const seen = new Set<string>();
    for (const { column, where } of unresolved) {
      if (seen.has(column)) continue;
      seen.add(column);
      const found = ((await ask(`SELECT DISTINCT ${column} AS value FROM ${table} WHERE ${where} AND ${column} IS NOT NULL AND ${column} <> ''`)) || []) as any[];
      for (const row of found) report.dangling.push({ table, column, value: String(row.value) });
    }
  }
  const leaders = ((await ask("SELECT DISTINCT leader AS value FROM guilds WHERE leader_id IS NULL AND leader IS NOT NULL AND leader <> ''")) || []) as any[];
  for (const row of leaders) report.dangling.push({ table: "guilds", column: "leader", value: String(row.value) });

  return report;
}

async function main() {
  const { default: query, transaction } = await import("../controllers/sqldatabase");
  const dialect = (process.env.DATABASE_ENGINE || "mysql") === "sqlite" ? "sqlite" : "mysql";
  const report = await migrateCharacters((sql, values) => query<any>(sql, values as any[]), {
    dialect,
    transaction: (statements) => transaction(statements as any),
  });
  console.log(`Characters made: ${report.charactersMade}`);
  for (const item of report.renamed) console.log(`Renamed: account ${item.accountId} (${item.username}) -> ${item.name}`);
  let mismatched = 0;
  for (const [table, row] of Object.entries(report.rows)) {
    const same = row.before === row.after && row.checksumBefore === row.checksumAfter;
    if (!same) mismatched++;
    console.log(`${same ? "ok      " : "MISMATCH"} ${table}: ${row.before} -> ${row.after} rows`);
  }
  console.log(`Dangling pointers: ${report.dangling.length}`);
  for (const item of report.dangling) console.log(`  ${item.table}.${item.column} = ${item.value}`);
  process.exit(mismatched > 0 ? 1 : 0);
}

if (import.meta.main) await main();
