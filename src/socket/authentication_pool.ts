import { Worker } from "worker_threads";
import assetCache from "../services/assetCache";
import log from "../modules/logger";
import { AuthDispatcher, authWorkerEnv } from "./authdispatch";

const MAX_AUTH_POOL_SIZE = 64;
const parsedAuthPoolSize = parseInt(process.env.AUTH_POOL_SIZE || "", 10);
const AUTH_POOL_SIZE = Number.isInteger(parsedAuthPoolSize) && parsedAuthPoolSize > 0
  ? Math.min(parsedAuthPoolSize, MAX_AUTH_POOL_SIZE)
  : 8;

const prepareAssets = async () => {
    const items = await assetCache.get("items");
    const maps = await assetCache.get("maps");
    const mounts = await assetCache.get("mounts");
    const spells = await assetCache.get("spells");

    return {
        items: items ? JSON.stringify(items) : null,
        maps: maps ? JSON.stringify(maps) : null,
        mounts: mounts ? JSON.stringify(mounts) : null,
        spells: spells ? JSON.stringify(spells) : null,
    };
};

const pool = new AuthDispatcher<Worker>({
    size: AUTH_POOL_SIZE,
    create: (assets) => new Worker(new URL("authentication.ts", import.meta.url), {
        workerData: { assets },
        env: authWorkerEnv(process.env),
    }),
    debug: (message) => log.debug(message),
    error: (message) => log.error(message),
});
let initializing: Promise<void> | null = null;

async function initPool(): Promise<void> {
    if (pool.started) return;
    initializing ??= prepareAssets().then((assets) => {
        pool.start(assets);
        log.info(`[AUTH POOL] ${pool.size} workers ready`);
    }).catch((error) => {
        initializing = null;
        throw error;
    });
    await initializing;
}

export async function getAuthPool(): Promise<AuthDispatcher<Worker>> {
    await initPool();
    return pool;
}

export function resetAuthWorker(): void {
    pool.stop();
    initializing = null;
}

export async function refreshAuthSpells(): Promise<void> {
    if (!pool.started) return;
    const spells = await assetCache.get("spells");
    pool.refresh("spells", spells ? JSON.stringify(spells) : null);
}

export async function refreshAuthItems(): Promise<void> {
    if (!pool.started) return;
    const items = await assetCache.get("items");
    pool.refresh("items", items ? JSON.stringify(items) : null);
}

export async function refreshAuthMounts(): Promise<void> {
    if (!pool.started) return;
    const mounts = await assetCache.get("mounts");
    pool.refresh("mounts", mounts ? JSON.stringify(mounts) : null);
}

export function followListsSavedElsewhere(
    cache: { onChange(key: string, listener: (elsewhere: boolean) => void): void },
    lists: Record<string, () => Promise<void>>,
): void {
    for (const [key, refresh] of Object.entries(lists)) {
        cache.onChange(key, (elsewhere) => {
            if (!elsewhere) return;
            refresh().catch((error) => log.error(`Could not hand the ${key} saved on another node to the login workers: ${error}`));
        });
    }
}
followListsSavedElsewhere(assetCache, { spells: refreshAuthSpells, items: refreshAuthItems, mounts: refreshAuthMounts });
