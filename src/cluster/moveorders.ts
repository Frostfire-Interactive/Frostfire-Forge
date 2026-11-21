import type { ClusterStore } from "./store";

export type MoveState = "ordered" | "sending" | "sent" | "aborted" | "done";

export interface MoveOrder {
  id: string;
  /** The order's revision: each change of state raises it (swapIfEpoch). */
  epoch: number;
  state: MoveState;
  /** Bare map name. */
  map: string;
  bx: number;
  by: number;
  from: string;
  to: string;
  /** The block's owner epoch when the order was made: the commit is refused if the owner changed since. */
  blockEpoch: number;
  at: number;
}

export type NewMove = Pick<MoveOrder, "map" | "bx" | "by" | "from" | "to" | "blockEpoch">;

export const MOVES_KEY = "cells:moves";
export const moveKey = (id: string) => `cells:move:${id}`;

const STATES: ReadonlySet<string> = new Set(["ordered", "sending", "sent", "aborted", "done"]);

/** Still to be carried out or committed. */
export function isOpen(order: MoveOrder): boolean {
  return order.state !== "done" && order.state !== "aborted";
}

function parse(raw: string | null): MoveOrder | null {
  if (!raw) return null;
  let value: any;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const int = (n: unknown) => typeof n === "number" && Number.isInteger(n);
  if (!value || typeof value.id !== "string" || !int(value.epoch) || !STATES.has(value.state)) return null;
  if (typeof value.map !== "string" || !int(value.bx) || !int(value.by)) return null;
  if (typeof value.from !== "string" || typeof value.to !== "string" || !int(value.blockEpoch) || !int(value.at)) return null;
  return value as MoveOrder;
}

export class MoveOrders {
  constructor(private store: ClusterStore, private now: () => number = Date.now) {}

  async create(move: NewMove): Promise<MoveOrder> {
    const order: MoveOrder = { id: crypto.randomUUID(), epoch: 1, state: "ordered", ...move, at: this.now() };
    // An absent key has epoch 0: this writes only a new order.
    if (!(await this.store.swapIfEpoch(moveKey(order.id), 0, JSON.stringify(order)))) {
      throw new Error(`Move order ${order.id} already exists`);
    }
    await this.store.addToSet(MOVES_KEY, order.id);
    return order;
  }

  async get(id: string): Promise<MoveOrder | null> {
    return parse(await this.store.get(moveKey(id)));
  }

  async swap(id: string, from: MoveState, to: MoveState): Promise<MoveOrder | null> {
    const order = await this.get(id);
    if (!order || order.state !== from) return null;
    const next: MoveOrder = { ...order, state: to, epoch: order.epoch + 1, at: this.now() };
    return (await this.store.swapIfEpoch(moveKey(id), order.epoch, JSON.stringify(next))) ? next : null;
  }

  /** Every listed order. An id whose order is gone is taken off the list. */
  async all(): Promise<MoveOrder[]> {
    const orders: MoveOrder[] = [];
    for (const id of (await this.store.members(MOVES_KEY)).sort()) {
      const raw = await this.store.get(moveKey(id));
      if (raw === null) {
        await this.store.removeFromSet(MOVES_KEY, id);
        continue;
      }
      const order = parse(raw);
      if (order) orders.push(order);
    }
    return orders;
  }

  async remove(id: string): Promise<void> {
    await this.store.del(moveKey(id));
    await this.store.removeFromSet(MOVES_KEY, id);
  }
}
