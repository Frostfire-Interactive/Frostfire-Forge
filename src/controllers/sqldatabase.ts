import log from "../modules/logger";
import path from "node:path";
import { GuardError, type TransactionStatement } from "./sqltransaction";

export { GuardError, type TransactionStatement };

const MAX_DB_WORKER_POOL_SIZE = 64;
const parsedDbWorkerPoolSize = parseInt(process.env.DB_WORKER_POOL_SIZE || "", 10);
const WORKER_POOL_SIZE = Number.isInteger(parsedDbWorkerPoolSize) && parsedDbWorkerPoolSize > 0
  ? Math.min(parsedDbWorkerPoolSize, MAX_DB_WORKER_POOL_SIZE)
  : 8;
const workerPool: Worker[] = [];
const pendingQueries = new Map<string, { resolve: (value: any) => void; reject: (error: any) => void }>();
let nextWorkerId = 0;
let queryIdCounter = 0;
let workersReady = 0;

async function initializeWorkerPool(): Promise<void> {
  log.info("Initializing database worker pool...");
  const workerPath = path.join(import.meta.dir, "sqldatabase.worker.ts");

  return new Promise((resolve, reject) => {
    const initTimeout = setTimeout(() => {
      reject(new Error("Worker pool initialization timeout"));
    }, 60000);

    for (let i = 0; i < WORKER_POOL_SIZE; i++) {
      const worker = new Worker(workerPath);

      worker.onmessage = (event: MessageEvent) => {
        const { type, id, result, error, guard } = event.data;

        if (type === 'ready') {
          workersReady++;
          if (workersReady === WORKER_POOL_SIZE) {
            clearTimeout(initTimeout);
            log.success(`Database worker pool initialized with ${WORKER_POOL_SIZE} workers`);
            resolve();
          }
          return;
        }

        if (type === 'error') {
          clearTimeout(initTimeout);
          reject(new Error(error));
          return;
        }

        const pending = pendingQueries.get(id);
        if (pending) {
          pendingQueries.delete(id);
          if (typeof guard === "number") {
            pending.reject(new GuardError(guard));
          } else if (error) {
            pending.reject(new Error(error));
          } else {
            pending.resolve(result);
          }
        }
      };

      worker.onerror = (error) => {
        log.error(`Database worker error: ${error.message}`);
        clearTimeout(initTimeout);
        reject(error);
      };

      workerPool.push(worker);
    }
  });
}

await initializeWorkerPool();

function getNextWorker(): Worker {
  const worker = workerPool[nextWorkerId];
  nextWorkerId = (nextWorkerId + 1) % WORKER_POOL_SIZE;
  return worker;
}

/** How long a query is waited for here, unless setQueryTimeout says otherwise (cluster/tradesettle.ts counts on it). */
const CLIENT_QUERY_TIMEOUT_MS = 30000;
let queryTimeoutMs: number | undefined;

export function setQueryTimeout(ms: number): void {
  queryTimeoutMs = ms;
}

/** Hands `work` to the next worker and waits for its answer. */
function ask<T>(work: { sql: string; values: any[] } | { transaction: TransactionStatement[]; openBy?: number }): Promise<T> {
  return new Promise((resolve, reject) => {
    const queryId = `query_${++queryIdCounter}_${Date.now()}`;
    const worker = getNextWorker();

    const waitMs = queryTimeoutMs === undefined ? CLIENT_QUERY_TIMEOUT_MS : queryTimeoutMs + 5000;
    const timeout = setTimeout(() => {
      pendingQueries.delete(queryId);
      reject(new Error(`Query timeout after ${Math.round(waitMs / 1000)} seconds`));
    }, waitMs);

    pendingQueries.set(queryId, {
      resolve: (value: any) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (error: any) => {
        clearTimeout(timeout);
        reject(error);
      }
    });

    worker.postMessage(queryTimeoutMs === undefined ? { id: queryId, ...work } : { id: queryId, ...work, queryTimeout: queryTimeoutMs });
  });
}

export default async function query<T>(sql: string, values?: any[]): Promise<T[]> {
  return ask<T[]>({ sql, values: values || [] });
}

export async function transaction(statements: TransactionStatement[], options: { openBy?: number } = {}): Promise<any[]> {
  if (statements.length === 0) return [];
  return ask<any[]>(options.openBy === undefined ? { transaction: statements } : { transaction: statements, openBy: options.openBy });
}

/** Resolves once every query sent so far has been answered or has timed out. */
export async function drainQueries(): Promise<void> {
  while (pendingQueries.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
