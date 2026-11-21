import { transaction, type TransactionStatement } from "../controllers/sqldatabase";
import log from "../modules/logger";
import { turns } from "./datacache";

/** A queue of work, one piece at a time for a key. `turns()` makes one. */
type Queue = <T>(key: string, work: () => Promise<T>) => Promise<T>;

export interface Batch {
  hold(queue: Queue, player: string): Promise<void>;
  pending<T extends object>(owner: object, player: string, start: () => Promise<T>): Promise<T>;
  /** A statement of the transaction. `answered` is handed its result, once the transaction is kept. */
  add(statement: TransactionStatement, answered?: (result: any) => void): void;
  /** Run once the transaction is kept, in the order asked: where a system puts what it has pending into the rows it holds. */
  kept(step: () => unknown): void;
  undone(step: () => unknown): void;
  after(step: () => unknown): void;
  openBy(deadline: number): void;
}

// One batch at a time for a player.
const oneAtATime = turns();

export type ClusterPlayerLock = <T>(players: string[], work: (check: () => Promise<void>) => Promise<T>) => Promise<T>;
let clusterLock: ClusterPlayerLock | null = null;

/** Answers the lock set before, so a test can put it back. */
export function setClusterPlayerLock(lock: ClusterPlayerLock | null): ClusterPlayerLock | null {
  const previous = clusterLock;
  clusterLock = lock;
  return previous;
}

const lower = (player: string) => String(player).toLowerCase();

// The errors of batches that threw before their transaction was sent (see nothingWritten).
const unsent = new WeakSet<object>();

export function nothingWritten(error: unknown): boolean {
  return typeof error === "object" && error !== null && unsent.has(error);
}

export async function atomically<T>(players: string[], work: (batch: Batch) => Promise<T>): Promise<T> {
  const names = [...new Set(players.map(lower))].sort();
  const afterSteps: Array<() => unknown> = [];
  const progress = { sent: false };
  const run = names.reduceRight<() => Promise<T>>(
    (inner, name) => () => oneAtATime(name, inner),
    () => (clusterLock
      ? clusterLock(names, (check) => carryOut(names, work, afterSteps, progress, check))
      : carryOut(names, work, afterSteps, progress)),
  );
  let result: T;
  try {
    result = await run();
  } catch (error) {
    if (progress.sent) throw error;
    // Guard (test "an error from before the transaction is told apart from one after it").
    const marked = typeof error === "object" && error !== null ? error : new Error(String(error));
    unsent.add(marked);
    throw marked;
  }
  for (const step of afterSteps) {
    try {
      await step();
    } catch (error) {
      log.error(`A step left for after a batch failed: ${error}`);
    }
  }
  return result;
}

async function carryOut<T>(
  names: string[],
  work: (batch: Batch) => Promise<T>,
  afterSteps: Array<() => unknown>,
  progress: { sent: boolean },
  check?: () => Promise<void>,
): Promise<T> {
  const statements: TransactionStatement[] = [];
  const answers: Array<((result: any) => void) | undefined> = [];
  const keptSteps: Array<() => unknown> = [];
  const undoneSteps: Array<() => unknown> = [];
  const leftForAfter: Array<() => unknown> = [];
  const held = new Map<Queue, Map<string, Promise<void>>>();
  const states = new Map<object, Map<string, Promise<object>>>();
  let openDeadline: number | undefined;

  let end!: () => void;
  const ended = new Promise<void>((resolve) => { end = resolve; });

  const batch: Batch = {
    async hold(queue, player) {
      const name = lower(player);
      if (!names.includes(name)) throw new Error(`A batch changed the rows of ${name}, a player it did not name.`);
      if (!held.has(queue)) held.set(queue, new Map());
      const mine = held.get(queue)!;
      // Asked for once; whoever asks again waits for the same turn to be taken.
      if (!mine.has(name)) {
        mine.set(name, new Promise<void>((taken) => {
          void queue(name, () => {
            taken();
            return ended;
          });
        }));
      }
      await mine.get(name);
    },
    pending<S extends object>(owner: object, player: string, start: () => Promise<S>): Promise<S> {
      const name = lower(player);
      if (!states.has(owner)) states.set(owner, new Map());
      const mine = states.get(owner)!;
      if (!mine.has(name)) mine.set(name, start());
      return mine.get(name) as Promise<S>;
    },
    add(statement, answered) {
      statements.push(statement);
      answers.push(answered);
    },
    kept(step) { keptSteps.push(step); },
    undone(step) { undoneSteps.push(step); },
    after(step) { leftForAfter.push(step); },
    openBy(deadline) {
      openDeadline = openDeadline === undefined ? deadline : Math.min(openDeadline, deadline);
    },
  };

  const undo = async () => { for (const step of undoneSteps) await step(); };

  try {
    const result = await work(batch);

    let results: any[] = [];
    if (statements.length > 0) {
      try {
        if (check) await check();
        progress.sent = true;
        // Guard (test "a batch hands its earliest open-by deadline to the transaction, and none when it set none").
        results = openDeadline === undefined ? await transaction(statements) : await transaction(statements, { openBy: openDeadline });
      } catch (error) {
        await undo();
        throw error;
      }
    }
    answers.forEach((answered, index) => answered?.(results[index]));

    const failures: unknown[] = [];
    for (const step of keptSteps) {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      await undo();
      throw failures[0];
    }
    afterSteps.push(...leftForAfter);
    return result;
  } finally {
    end();
  }
}
