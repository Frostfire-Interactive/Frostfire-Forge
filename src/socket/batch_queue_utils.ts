/** Detach and return a receiver's pending batch entry. Sync, hence atomic. */
export function claimBatchEntry<K, V>(
  queue: Map<string, Map<K, V>>,
  receiverId: string
): Map<K, V> | undefined {
  const entry = queue.get(receiverId);
  if (entry === undefined) return undefined;
  queue.delete(receiverId);
  return entry;
}

export function requeueSpawnBatch(
  queue: Map<string, Map<string, any>>,
  receiverId: string,
  unprocessed: Map<string, any> | undefined
): void {
  const arrived = queue.get(receiverId);
  if ((!unprocessed || unprocessed.size === 0) && !arrived) return;
  if (arrived && (!unprocessed || unprocessed.size === 0)) return;
  const merged = new Map<string, any>();
  if (unprocessed) {
    for (const [k, v] of unprocessed) merged.set(k, v);
  }
  if (arrived) {
    for (const [k, v] of arrived) merged.set(k, v);
  }
  if (merged.size > 0) {
    queue.set(receiverId, merged);
  } else {
    queue.delete(receiverId);
  }
}

/** Detach and return a receiver's pending despawn set. Sync, hence atomic. */
export function claimDespawnEntry(
  queue: Map<string, Set<string>>,
  receiverId: string
): Set<string> | undefined {
  const entry = queue.get(receiverId);
  if (entry === undefined) return undefined;
  queue.delete(receiverId);
  return entry;
}

/** Restore an unsent despawn set, unioned with ids that arrived mid-flush. */
export function requeueDespawnEntry(
  queue: Map<string, Set<string>>,
  receiverId: string,
  unprocessed: Set<string> | undefined
): void {
  const arrived = queue.get(receiverId);
  if ((!unprocessed || unprocessed.size === 0) && !arrived) return;
  if (arrived && (!unprocessed || unprocessed.size === 0)) return;
  const merged = new Set<string>();
  if (unprocessed) {
    for (const id of unprocessed) merged.add(id);
  }
  if (arrived) {
    for (const id of arrived) merged.add(id);
  }
  if (merged.size > 0) {
    queue.set(receiverId, merged);
  } else {
    queue.delete(receiverId);
  }
}

/** Receivers whose spawn batches are flushed at the same time. */
export const SPAWN_FLUSH_CONCURRENCY = 8;
/** Spawns one receiver gets per flush, and the most when its queue is long (above SPAWN_BACKLOG). */
export const SPAWNS_PER_FLUSH = 10;
export const SPAWNS_PER_FLUSH_BACKLOG = 50;
export const SPAWN_BACKLOG = 100;

/** How many of a receiver's `queued` spawns go out in one flush: more when it is far behind, so a long queue drains. */
export function spawnsPerFlush(queued: number): number {
  return queued > SPAWN_BACKLOG ? SPAWNS_PER_FLUSH_BACKLOG : SPAWNS_PER_FLUSH;
}

export async function runBounded<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
  mayStart: () => boolean = () => true
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && (next === 0 || mayStart())) await task(items[next++]!);
  };
  const results = await Promise.allSettled(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  for (const result of results) if (result.status === "rejected") throw result.reason;
}

/** Sets `key`, and drops the oldest entries first while `map` holds more than `max` (a Map iterates in insertion order). */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size <= max) return;
  for (const oldest of map.keys()) {
    if (map.size <= max) break;
    map.delete(oldest);
  }
}

export const SPAWN_FLUSH_BUDGET_MS = 12;

export async function flushSpawnQueue(
  queue: Map<string, Map<string, any>>,
  flushOne: (receiverId: string, claimed: Map<string, any>) => Promise<void>,
  concurrency: number,
  budgetMs: number = SPAWN_FLUSH_BUDGET_MS,
  now: () => number = () => performance.now()
): Promise<void> {
  const began = now();
  await runBounded(
    Array.from(queue.keys()),
    concurrency,
    async (receiverId) => {
      const claimed = claimBatchEntry(queue, receiverId);
      if (!claimed || claimed.size === 0) return;
      try {
        await flushOne(receiverId, claimed);
      } catch (error) {
        // A claimed batch is never lost to an exception: put it back so the next pass retries.
        requeueSpawnBatch(queue, receiverId, claimed);
      }
    },
    () => now() - began < budgetMs
  );
}
