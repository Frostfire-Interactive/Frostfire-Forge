import query, { GuardError } from "../controllers/sqldatabase";
import log from "../modules/logger";
import type { Batch } from "../services/batch";

export const GRANT_WRITES_TABLE = "grant_writes";
/** The longest grant id (cluster/grants.ts MAX_ID). */
export const GRANT_ID_MAX = 128;

const sqlite = (): boolean => (process.env.DATABASE_ENGINE || "mysql") === "sqlite";

let made: Promise<void> | null = null;

/** Creates the table once per process; a failure is thrown, and the next write tries again. */
export function ensureGrantWrites(): Promise<void> {
  made ??= (async () => {
    await query(sqlite()
      ? `CREATE TABLE IF NOT EXISTS ${GRANT_WRITES_TABLE} (id TEXT NOT NULL PRIMARY KEY, written_at INTEGER NOT NULL)`
      : `CREATE TABLE IF NOT EXISTS ${GRANT_WRITES_TABLE} (id VARCHAR(191) NOT NULL PRIMARY KEY, written_at BIGINT NOT NULL)`);
  })().catch((error) => {
    made = null;
    throw error;
  });
  return made;
}

/** For tests: the table is created again by the next write. */
export function forgetGrantWritesTable(): void {
  made = null;
}

export async function recordGrantWrite(batch: Batch, id: string): Promise<void> {
  if (typeof id !== "string" || !id || id.length > GRANT_ID_MAX) throw new Error(`${String(id).slice(0, GRANT_ID_MAX)} is not a grant id`);
  await ensureGrantWrites();
  batch.add({
    sql: sqlite()
      ? `INSERT OR IGNORE INTO ${GRANT_WRITES_TABLE} (id, written_at) VALUES (?, ?)`
      : `INSERT IGNORE INTO ${GRANT_WRITES_TABLE} (id, written_at) VALUES (?, ?)`,
    values: [id, Date.now()],
    // A row already there changes nothing: the transaction is undone whole.
    mustChange: true,
  });
}

/** How long a grant_writes row is kept: far past any grant's TTL (cluster/grants.ts GRANT_TTL_MS, 10 minutes). */
export const GRANT_WRITES_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export async function pruneGrantWrites(): Promise<void> {
  try {
    await query(`DELETE FROM ${GRANT_WRITES_TABLE} WHERE written_at < ?`, [Date.now() - GRANT_WRITES_KEEP_MS]);
  } catch (error) {
    log.warn(`Old ${GRANT_WRITES_TABLE} rows could not be deleted (they are tried again at the next cluster start): ${error}`);
  }
}

export function grantWrittenBefore(error: unknown): boolean {
  return error instanceof GuardError && error.statement === 0;
}
