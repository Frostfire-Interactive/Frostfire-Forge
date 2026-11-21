import log from "../modules/logger";
import type { IdAllocator } from "./ids";

let world: IdAllocator | null = null;
let local = 0;

const NO_IDS_LOG_EVERY_MS = 10_000;
const noIdsLoggedAt = new Map<string, number>();

/** Called by startCluster: from now on ids come from the node's allocator. Null detaches it. */
export function useWorldIds(ids: IdAllocator | null): void {
  if (ids && local > 0) {
    log.warn(`[Cluster] World ids attached after ${local} local entity id(s) were handed out: those may collide with world ids`);
  }
  world = ids;
}

export function nextEntityId(): number {
  return world ? world.next() : ++local;
}

/** Logs a failed id request as an error at most once per 10 s per call site (`site`). */
export function logNoIds(site: string, message: string, now: number = Date.now()): void {
  const last = noIdsLoggedAt.get(site);
  if (last !== undefined && now - last < NO_IDS_LOG_EVERY_MS) return;
  noIdsLoggedAt.set(site, now);
  log.error(message);
}

/** For tests: the local counter starts again and the allocator is let go. */
export function resetEntityIds(): void {
  world = null;
  local = 0;
  noIdsLoggedAt.clear();
}
