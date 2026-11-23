import { clusterStore } from "../../cluster/index";
import type { ClusterStore } from "../../cluster/store";
import type { CopyRecord } from "./types";

export interface CopyBook {
    all(): Promise<CopyRecord[]>;
    list(dungeonId: number): Promise<CopyRecord[]>;
    get(key: string): Promise<CopyRecord | null>;
    put(c: CopyRecord): Promise<void>;
    remove(key: string): Promise<void>;
    /** Runs `work` while no other entry or patch of the dungeon's copies runs, on any node. Not re-entrant. */
    locked<T>(dungeonId: number, work: () => Promise<T>): Promise<T>;
}

const INDEX = "dungeon:copies";
const recordKey = (key: string) => `dungeon:copy:${key}`;
const lockKey = (dungeonId: number) => `dungeon:lock:${dungeonId}`;

/** How long a node may hold a dungeon's lock before others may take it (a node that died holding it). */
export const COPY_LOCK_MS = 30_000;
const COPY_LOCK_RETRY_MS = 25;

/** Work run one after another per dungeon in this process. */
function chained(): <T>(dungeonId: number, work: () => Promise<T>) => Promise<T> {
    const chains = new Map<number, Promise<unknown>>();
    return <T>(dungeonId: number, work: () => Promise<T>): Promise<T> => {
        const mine = (chains.get(dungeonId) ?? Promise.resolve()).then(work, work);
        chains.set(dungeonId, mine);
        const done = () => { if (chains.get(dungeonId) === mine) chains.delete(dungeonId); };
        mine.then(done, done);
        return mine;
    };
}

export function memoryCopyBook(): CopyBook {
    const copies = new Map<string, CopyRecord>();
    const clone = (c: CopyRecord): CopyRecord => ({ ...c, entered: [...c.entered] });
    return {
        async all() { return [...copies.values()].map(clone); },
        async list(dungeonId) { return [...copies.values()].filter((c) => c.dungeonId === dungeonId).map(clone); },
        async get(key) { const c = copies.get(key); return c ? clone(c) : null; },
        async put(c) { copies.set(c.key, clone(c)); },
        async remove(key) { copies.delete(key); },
        locked: chained(),
    };
}

/** The store's lock of a dungeon: taken when free or expired, given back only by its holder. */
async function storeLocked<T>(store: ClusterStore, dungeonId: number, work: () => Promise<T>, wait: (ms: number) => Promise<void>): Promise<T> {
    const token = crypto.randomUUID();
    while (!(await store.setIfAbsent(lockKey(dungeonId), token, COPY_LOCK_MS))) await wait(COPY_LOCK_RETRY_MS);
    try {
        return await work();
    } finally {
        if ((await store.get(lockKey(dungeonId)).catch(() => null)) === token) await store.del(lockKey(dungeonId)).catch(() => {});
    }
}

export function storeCopyBook(store: ClusterStore, wait: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms)): CopyBook {
    const get = async (key: string): Promise<CopyRecord | null> => {
        const raw = await store.get(recordKey(key));
        if (raw === null) return null;
        try { return JSON.parse(raw) as CopyRecord; } catch { return null; }
    };
    const all = async (): Promise<CopyRecord[]> => {
        const found = await Promise.all((await store.members(INDEX)).map(get));
        return found.filter((c): c is CopyRecord => c !== null);
    };
    return {
        all,
        async list(dungeonId) { return (await all()).filter((c) => c.dungeonId === dungeonId); },
        get,
        async put(c) {
            await store.set(recordKey(c.key), JSON.stringify(c));
            await store.addToSet(INDEX, c.key);
        },
        async remove(key) {
            await store.del(recordKey(key));
            await store.removeFromSet(INDEX, key);
        },
        locked: (dungeonId, work) => storeLocked(store, dungeonId, work, wait),
    };
}

const memory = memoryCopyBook();

export function copyBook(): CopyBook {
    const store = clusterStore();
    return store ? storeCopyBook(store) : memory;
}
