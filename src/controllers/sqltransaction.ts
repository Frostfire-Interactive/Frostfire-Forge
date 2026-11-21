import { sqlWrapper } from "./sqlescape";

export interface TransactionStatement {
  sql: string;
  values?: any[];
  mustChange?: boolean;
}

/** A statement marked `mustChange` changed no rows. Nothing was kept. */
export class GuardError extends Error {
  /** Which statement of the list, counted from 0. */
  statement: number;

  constructor(statement: number) {
    super(`Transaction undone: statement ${statement} changed no rows`);
    this.name = "GuardError";
    this.statement = statement;
  }
}

/** The transaction never opened, so no statement was sent: it may be tried again. */
export class NotStartedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotStartedError";
  }
}

/** The transaction could not open by its open-by deadline: nothing was sent, and it is not tried again. */
export class LateError extends Error {
  /** The deadline (ms since the epoch). */
  openBy: number;

  constructor(openBy: number) {
    super(`Transaction not opened: its open-by deadline passed ${Math.max(0, Date.now() - openBy)} ms ago`);
    this.name = "LateError";
    this.openBy = openBy;
  }
}

export async function runWithRetries<T>(attempt: () => Promise<T>, maxRetries: number, retryDelay: number): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof NotStartedError) || tries >= maxRetries) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
}

/** Bun reports the rows a write changed as `affectedRows` on MySQL and as `count` elsewhere. */
function changedRows(result: any): number {
  return typeof result?.affectedRows === "number" ? result.affectedRows : result?.count ?? 0;
}

function inTime<T>(work: Promise<T>, left: number, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Transaction timeout after ${timeoutMs}ms`)), Math.max(left, 0));
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export async function runTransaction(db: any, statements: TransactionStatement[], engine: DatabaseEngine, timeoutMs = 15000, openBy?: number): Promise<any[]> {
  if (statements.length === 0) return [];

  // Built before the transaction opens: a list that cannot be built is refused whole.
  const texts = statements.map((statement) => sqlWrapper(statement.sql, statement.values || [], engine));
  // Guard (test "a transaction past its open-by deadline does not ask for a connection").
  if (openBy !== undefined && Date.now() > openBy) throw new LateError(openBy);
  let started = false;

  const work = async (tx: any) => {
    started = true;
    if (openBy !== undefined && Date.now() > openBy) throw new LateError(openBy);
    const deadline = Date.now() + timeoutMs;
    const results: any[] = [];
    for (let i = 0; i < texts.length; i++) {
      const result = await inTime(tx.unsafe(texts[i]), deadline - Date.now(), timeoutMs);
      if (statements[i].mustChange && changedRows(result) === 0) throw new GuardError(i);
      results.push(result);
    }
    return results;
  };

  try {
    return await (engine === "sqlite" ? db.begin("immediate", work) : db.begin(work));
  } catch (error: any) {
    if (!started) throw new NotStartedError(error?.message || String(error));
    throw error;
  }
}
