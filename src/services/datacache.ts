import log from "../modules/logger";

/** How long "there is no such row" is believed before the database is asked again. */
const MISS_MS = 60_000;

const copy = <T>(value: T): T => (value === null || typeof value !== "object" ? value : structuredClone(value));

interface Store {
  getRow(hash: string, key: string): Promise<any>;
  setRow(hash: string, key: string, value: any): Promise<void>;
  dropRow(hash: string, key: string): Promise<void>;
  dropRows(hash: string): Promise<void>;
  getList(key: string): Promise<any[] | null>;
  setList(key: string, rows: any[]): Promise<void>;
  dropList(key: string): Promise<void>;
  clear(names: string[]): Promise<void>;
}

function memoryStore(): Store {
  const hashes = new Map<string, Map<string, any>>();
  const lists = new Map<string, any[]>();
  return {
    getRow: async (hash, key) => hashes.get(hash)?.get(key),
    setRow: async (hash, key, value) => {
      if (!hashes.has(hash)) hashes.set(hash, new Map());
      hashes.get(hash)!.set(key, value);
    },
    dropRow: async (hash, key) => { hashes.get(hash)?.delete(key); },
    dropRows: async (hash) => { hashes.delete(hash); },
    getList: async (key) => lists.get(key) ?? null,
    setList: async (key, rows) => { lists.set(key, rows); },
    dropList: async (key) => { lists.delete(key); },
    clear: async () => {
      hashes.clear();
      lists.clear();
    },
  };
}

function sharedStore(): Store {
  const service = import("./assetCache").then((module) => module.default);
  return {
    getRow: async (hash, key) => (await service).getNested(hash, key),
    setRow: async (hash, key, value) => (await service).setNested(hash, key, value),
    dropRow: async (hash, key) => (await service).removeNested(hash, key),
    dropRows: async (hash) => (await service).remove(hash),
    getList: async (key) => (await service).get(key),
    setList: async (key, rows) => (await service).set(key, rows),
    dropList: async (key) => (await service).remove(key),
    clear: async (names) => {
      for (const name of names) await (await service).remove(name);
    },
  };
}

export function usesSharedCache(env: Record<string, string | undefined> = process.env): boolean {
  return env.CACHE?.toLowerCase() === "redis";
}

const store: Store = usesSharedCache() ? sharedStore() : memoryStore();

export interface RowCache<T> {
  /** What is held under `key`, loaded the first time it is asked for. A copy: changing it changes nothing. */
  get(key: string | number): Promise<T | null>;
  /** After writing the database: what is now held under `key` (null: no row). */
  set(key: string | number, value: T | null): Promise<void>;
  patch(key: string | number, columns: Partial<T>): Promise<void>;
  /** Forget `key`, so the next get loads it again. For rows something else may have written. */
  drop(key: string | number): Promise<void>;
  /** Forget every key. For a write that does not say which rows it changed. */
  clear(): Promise<void>;
}

export interface TableCache<T> {
  /** Every row. Copies: changing them changes nothing. */
  all(): Promise<T[]>;
  /** The first row `match` accepts. */
  find(match: (row: T) => boolean): Promise<T | null>;
  /** Every row `match` accepts. Copies, of those rows only. */
  filter(match: (row: T) => boolean): Promise<T[]>;
  /** After writing the database: add `row`, in place of the row `same` accepts if there is one. */
  put(row: T, same: (row: T) => boolean): Promise<void>;
  /** After writing the database: take out every row `match` accepts. */
  remove(match: (row: T) => boolean): Promise<void>;
  /** Read the whole table again. If that fails, the rows held are forgotten and the next read tries again. */
  reload(): Promise<void>;
  drop(): Promise<void>;
}

const caching = Bun.isMainThread;

const names: string[] = [];
const rowCaches = new Map<string, RowCache<any>>();
const tableCaches = new Map<string, TableCache<any>>();
const playerCaches: RowCache<any>[] = [];
const tables: TableCache<any>[] = [];
/** What clearCaches also has to empty: the in-flight state of each row cache. */
const resets: Array<() => void> = [];

export interface Turns {
  /** Run `work` once everything asked of `key` before it has finished, well or badly. */
  <T>(key: string | number, work: () => Promise<T>): Promise<T>;
  /** How many keys have work running or waiting. */
  readonly busy: number;
}

export function turns(): Turns {
  const last = new Map<string, Promise<unknown>>();
  const take = <T>(key: string | number, work: () => Promise<T>): Promise<T> => {
    const k = String(key).toLowerCase();
    const mine = (last.get(k) ?? Promise.resolve()).then(work, work);
    last.set(k, mine);
    const done = () => { if (last.get(k) === mine) last.delete(k); };
    mine.then(done, done);
    return mine;
  };
  return Object.defineProperty(take, "busy", { get: () => last.size }) as Turns;
}

export function rowCache<T>(name: string, load: (key: string) => Promise<T | null | undefined>, options: { perPlayer?: boolean } = {}): RowCache<T> {
  const hash = `rows:${name}`;
  const loading = new Map<string, Promise<T | null>>();
  // Raised by every set, patch and drop, so a load that started before one of them does not put older rows back.
  const written = new Map<string, number>();
  // Raised by clear, which is a drop of every key.
  let cleared = 0;
  const keyOf = (key: string | number) => (options.perPlayer ? String(key).toLowerCase() : String(key));
  const touch = (k: string) => written.set(k, (written.get(k) ?? 0) + 1);
  /** Changes whenever `k` is written or dropped. */
  const mark = (k: string) => (written.get(k) ?? 0) + cleared;
  const held = (value: T | null) => (value === null ? { v: null, until: Date.now() + MISS_MS } : { v: value });

  const cache: RowCache<T> = {
    async get(key) {
      const k = keyOf(key);
      if (!caching) return (await load(k)) ?? null;
      for (;;) {
        const entry = await store.getRow(hash, k);
        if (entry && (entry.until === undefined || entry.until > Date.now())) return copy(entry.v as T | null);

        const other = loading.get(k);
        if (other) {
          // Someone is loading it: wait for them, then look again.
          await other.catch(() => {});
          continue;
        }

        const before = mark(k);
        const mine = (async () => {
          const value = (await load(k)) ?? null;
          if (mark(k) === before) await store.setRow(hash, k, held(value));
          return value;
        })().finally(() => loading.delete(k));
        loading.set(k, mine);
        const value = await mine;
        // Written while it loaded: what was written is newer than what was read.
        if (mark(k) !== before) continue;
        return copy(value);
      }
    },
    async set(key, value) {
      if (!caching) return;
      const k = keyOf(key);
      touch(k);
      await store.setRow(hash, k, held(copy(value)));
    },
    async patch(key, columns) {
      if (!caching) return;
      const k = keyOf(key);
      touch(k);
      const mine = mark(k);
      const entry = await store.getRow(hash, k);
      if (!entry) return;
      if (mark(k) === mine && entry.v !== null && typeof entry.v === "object" && !Array.isArray(entry.v)) {
        await store.setRow(hash, k, held({ ...entry.v, ...copy(columns) }));
        if (mark(k) === mine) return;
      }
      touch(k);
      await store.dropRow(hash, k);
    },
    async drop(key) {
      if (!caching) return;
      const k = keyOf(key);
      touch(k);
      await store.dropRow(hash, k);
    },
    async clear() {
      if (!caching) return;
      cleared++;
      await store.dropRows(hash);
    },
  };

  names.push(hash);
  rowCaches.set(name, cache);
  resets.push(() => loading.clear());
  if (options.perPlayer) playerCaches.push(cache);
  return cache;
}

/** A whole table, read at startup (loadTables) and kept in step by whatever writes it. */
export function tableCache<T>(name: string, load: () => Promise<T[]>): TableCache<T> {
  const key = `rows:${name}`;
  // One change at a time: each reads the list, changes it and stores it.
  let last: Promise<unknown> = Promise.resolve();
  const inTurn = <R>(work: () => Promise<R>): Promise<R> => {
    const run = last.then(work, work);
    last = run.catch(() => {});
    return run;
  };
  const fill = async (): Promise<T[]> => {
    const rows = (await load()) ?? [];
    await store.setList(key, rows);
    return rows;
  };
  /** The rows as held. Not asked of the database unless the table was never read (a test, or a table added while running). */
  const rows = async (): Promise<T[]> => {
    if (!caching) return (await load()) ?? [];
    return (await store.getList(key)) ?? (await inTurn(async () => (await store.getList(key)) ?? (await fill())));
  };

  const cache: TableCache<T> = {
    async all() {
      return copy(await rows());
    },
    async find(match) {
      const row = (await rows()).find(match);
      return row === undefined ? null : copy(row);
    },
    async filter(match) {
      return copy((await rows()).filter(match));
    },
    async put(row, same) {
      if (!caching) return;
      await rows();
      await inTurn(async () => {
        const held = await store.getList(key);
        // Dropped in the meantime: the next read loads the table, this change with it.
        if (!held) return;
        const list = [...held];
        const at = list.findIndex(same);
        if (at === -1) list.push(copy(row));
        else list[at] = copy(row);
        await store.setList(key, list);
      });
    },
    async remove(match) {
      if (!caching) return;
      await rows();
      await inTurn(async () => {
        const held = await store.getList(key);
        if (!held) return;
        await store.setList(key, held.filter((row: T) => !match(row)));
      });
    },
    async reload() {
      if (!caching) return;
      await inTurn(async () => {
        try {
          await fill();
        } catch (error) {
          // The rows held are no longer known to be right and could not be read again: the next read tries.
          await store.dropList(key);
          throw error;
        }
      });
    },
    async drop() {
      if (!caching) return;
      await inTurn(() => store.dropList(key));
    },
  };

  names.push(key);
  tableCaches.set(name, cache);
  tables.push(cache);
  return cache;
}

export async function dropRows(name: string, key: string | number): Promise<void> {
  await rowCaches.get(name)?.drop(key);
}

export async function dropAllRows(name: string): Promise<void> {
  await rowCaches.get(name)?.clear();
}

/** The same for a whole table: read `name` again. */
export async function reloadTable(name: string): Promise<void> {
  await tableCaches.get(name)?.reload();
}

export async function loadTables(): Promise<void> {
  const read = await Promise.allSettled(tables.map((table) => table.reload()));
  for (const result of read) {
    if (result.status === "rejected") log.error(`A cached table could not be read at startup: ${result.reason}`);
  }
}

export type LoginGate = (username: string) => Promise<unknown> | undefined;
let loginGate: LoginGate | null = null;

/** Sets the login gate. Answers the one set before, so a test can put it back. */
export function setLoginGate(gate: LoginGate | null): LoginGate | null {
  const previous = loginGate;
  loginGate = gate;
  return previous;
}

export async function refreshPlayer(username: string): Promise<void> {
  if (!username) return;
  // Guard (test "a login reads the player's mark before it reads their rows").
  const gate = loginGate?.(username);
  if (gate) {
    try {
      await gate;
    } catch (error) {
      log.error(`The login gate of ${username} failed: ${error}`);
    }
  }
  await Promise.all(playerCaches.map((cache) => cache.drop(username)));
  const read = await Promise.allSettled(playerCaches.map((cache) => cache.get(username)));
  for (const result of read) {
    if (result.status === "rejected") log.error(`Rows of ${username} could not be read at login: ${result.reason}`);
  }
}

/** Disconnect: stop holding this player's rows. */
export async function forgetPlayer(username: string): Promise<void> {
  if (!username) return;
  await Promise.all(playerCaches.map((cache) => cache.drop(username)));
}

/** Empty every cache, so the next read of anything loads it again. For tests, which change what the database holds behind the caches. */
export async function clearCaches(): Promise<void> {
  for (const reset of resets) reset();
  await store.clear(names);
}
