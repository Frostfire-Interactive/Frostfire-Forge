// src/cluster/inflight.ts
import { AsyncLocalStorage } from "node:async_hooks";

interface Run {
  id: string;
  live: boolean;
  parent: Run | undefined;
}

const counts = new Map<string, number>();
const inside = new AsyncLocalStorage<Run>();

/** Run one packet of player `id`, counted as in flight until it ends, thrown or not. */
export async function trackPacket<T>(id: string, fn: () => Promise<T>): Promise<T> {
  // Ended packets are skipped, so a chain of packets each started from the last one does not grow without end.
  let parent = inside.getStore();
  while (parent && !parent.live) parent = parent.parent;
  const run: Run = { id, live: true, parent };
  counts.set(id, (counts.get(id) ?? 0) + 1);
  try {
    return await inside.run(run, fn);
  } finally {
    run.live = false;
    const left = (counts.get(id) ?? 1) - 1;
    if (left > 0) counts.set(id, left);
    else counts.delete(id);
  }
}

export function packetsInFlight(id: string): number {
  return counts.get(id) ?? 0;
}

/** How many packets of `id` that are still running this call was started inside (the call's own packets). */
function ownPackets(run: Run | undefined, id: string): number {
  let own = 0;
  for (let r = run; r; r = r.parent) if (r.live && r.id === id) own++;
  return own;
}

export async function waitIdle(id: string, ms: number, pollMs = 10): Promise<boolean> {
  const run = inside.getStore();
  const deadline = Date.now() + ms;
  while (packetsInFlight(id) > ownPackets(run, id)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return true;
}
