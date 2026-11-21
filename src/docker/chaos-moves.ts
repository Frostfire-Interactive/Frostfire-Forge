// Which owner changes of a chaos window the rebalancer made itself (cluster-chaos.ts). Pure: the script reads Redis.

/** A move order as the coordinator stores it (sealed, but its fields read as plain JSON). */
export interface Order { id: string; state: string; map: string; bx: number; by: number; from: string; to: string }
export interface Owner { nodeId: string }

/** An order whose block the coordinator has committed to the new owner (it says "done" once it has, "sent" just before). */
const committed = (order: Order | undefined) => order?.state === "sent" || order?.state === "done";

export function ownerChanges(
  before: ReadonlyMap<string, Owner>,
  after: ReadonlyMap<string, Owner>,
  ordersBefore: ReadonlyMap<string, Order>,
  ordersAfter: ReadonlyMap<string, Order>,
): { changed: string[]; unexplained: string[] } {
  const explained = new Set<string>();
  for (const order of ordersAfter.values()) {
    if (committed(order) && ordersBefore.get(order.id)?.state !== "done") explained.add(`${order.map}|${order.bx},${order.by}|${order.to}`);
  }
  const changed = [...before].filter(([key, owner]) => after.get(key)?.nodeId !== owner.nodeId).map(([key]) => key);
  return { changed, unexplained: changed.filter((key) => !explained.has(`${key}|${after.get(key)?.nodeId}`)) };
}

export function creatureTotal(loads: ReadonlyArray<{ creatures?: number; creaturesTotal?: number } | null>): number | null {
  let total = 0;
  for (const load of loads) {
    if (!load || typeof load.creaturesTotal !== "number") return null;
    total += load.creaturesTotal;
  }
  return total;
}
