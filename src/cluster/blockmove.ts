import log from "../modules/logger";
import { blockParts, type BlockMove, type BlockPart } from "./blockparts";
import type { BlockOwner } from "./blocks";
import { MAX_CALL_BODY_BYTES, neverRan, type CallOutcome, type LinkCalls } from "./linkcalls";
import { bareMap } from "./mirrors";
import { MOVES_KEY, MoveOrders, isOpen, moveKey, type MoveOrder, type MoveState } from "./moveorders";
import type { ClusterStore } from "./store";

export const BLOCK_MOVE = "BLOCK_MOVE";
/** How long the old owner waits for the new owner's answer. Below MOVE_SEND_TIMEOUT_MS (coordinator.ts). */
export const BLOCK_MOVE_TIMEOUT_MS = 20_000;
/** How often the old owner tries again to read an order it could not read. */
export const DECIDE_RETRY_MS = 1_000;
export const DECIDE_FOR_MS = 30_000;
export const UNDECIDED_HOLD_MS = 240_000;
/** The old owner asks the new owner whether it took an order in, before it puts back parts it may have sent. */
export const BLOCK_MOVE_HELD = "BLOCK_MOVE_HELD";
export const HELD_ASK_TIMEOUT_MS = 3_000;
/** The old owner asks the new owner, before it takes anything out of the block, whether it is there and ready. */
export const BLOCK_MOVE_PROBE = "BLOCK_MOVE_PROBE";
export const MOVE_PROBE_TIMEOUT_MS = 2_500;
export const MOVE_PROBE_MAX_MS = 10_000;
/** How many ticks of its own lag the old owner allows the probe answer. */
export const PROBE_LAG_FACTOR = 8;
/** The probe wait for a sender with event-loop lag `lagMs`: max(base, 8 x lag), at most MOVE_PROBE_MAX_MS (never below base). */
export function probeDeadlineMs(lagMs: number, base: number = MOVE_PROBE_TIMEOUT_MS): number {
  const lag = Number.isFinite(lagMs) && lagMs > 0 ? lagMs : 0;
  return Math.max(base, Math.min(MOVE_PROBE_MAX_MS, PROBE_LAG_FACTOR * lag));
}
/** How many orders held undecided free the node for another order. A further hold keeps it busy until one is decided. */
export const MAX_FREEING_HOLDS = 1;
/** How many orders the new owner remembers taking in, and refusing after a question. Oldest forgotten first. */
export const HELD_KEEP = 4096;

export type OrderEnd = "too-big" | "busy" | "unreachable" | "held" | "not-started";
/** What a swap writes on the order with its state: why it closed, and the parts the new owner was sent. */
export interface OrderNotes { reason?: OrderEnd; parts?: string[] }
export interface EndedOrder extends MoveOrder, OrderNotes {}

export interface BlockMoveBody { order: MoveOrder; parts: Record<string, unknown> }
export interface BlockMoveAnswer { ok: boolean; reason?: string }
/** BLOCK_MOVE_PROBE: whether the new owner may take a block in now. */
export interface ProbeAnswer { ready: boolean }
/** BLOCK_MOVE_HELD: whether the new owner took the order in. null: its take is under way; ask again. */
export interface HeldAnswer { held: boolean | null }
interface Asked { run: number | null }
type Whereabouts = "free" | "held" | "unknown";
/** How a run ended on the old owner: sent, put back, too big and put back, not started, or lost (logged by name). */
export type MoveEnd = "sent" | "restored" | "too-big" | "skipped" | "lost";

export class BlockMoveOrders extends MoveOrders {
  constructor(private readonly orderStore: ClusterStore, private readonly clock: () => number = Date.now) {
    super(orderStore, clock);
  }

  async swapWith(id: string, from: MoveState, to: MoveState, notes: OrderNotes): Promise<EndedOrder | null> {
    const order = await this.get(id);
    if (!order || order.state !== from) return null;
    const next: EndedOrder = { ...order, ...notes, state: to, epoch: order.epoch + 1, at: this.clock() };
    return (await this.orderStore.swapIfEpoch(moveKey(id), order.epoch, JSON.stringify(next))) ? next : null;
  }

  async advanceToSent(base: MoveOrder, notes: OrderNotes): Promise<EndedOrder | null> {
    const order = await this.get(base.id);
    if (order?.state === "sent" || order?.state === "done") return order;
    const next: EndedOrder = { ...(order ?? base), ...notes, state: "sent", epoch: (order ?? base).epoch + 1, at: this.clock() };
    // A gone order is an absent key, epoch 0: one that reads gone because its seal fails is not written over.
    if (!(await this.orderStore.swapIfEpoch(moveKey(base.id), order?.epoch ?? 0, JSON.stringify(next)))) return null;
    if (!order) await this.orderStore.addToSet(MOVES_KEY, base.id);
    return next;
  }
}

export interface BlockMoverDeps {
  self: string;
  orders: Pick<BlockMoveOrders, "get" | "swap" | "swapWith" | "all" | "advanceToSent">;
  calls: Pick<LinkCalls, "call" | "handle">;
  /** The block's owner in this node's table; null when it has none or the map is not known. */
  ownerOf(map: string, bx: number, by: number): BlockOwner | null;
  canOwn?: () => boolean;
  /** The parts, lowest order first. blockParts unless a test gives others. */
  parts?: () => Array<BlockPart<any>>;
  /** The run (startedAt) node `nodeId` announced; null when it has no announcement. Without it, no tombstone counts. */
  runOf?(nodeId: string): Promise<number | null>;
  /** The run the coordinator's tombstone for node `nodeId` names; null when there is none. */
  buriedRun?(nodeId: string): Promise<number | null>;
  timeoutMs?: number;
  retryMs?: number;
  decideForMs?: number;
  /** How much longer the old owner holds what it could not decide, before it loses it. Default UNDECIDED_HOLD_MS. */
  undecidedHoldMs?: number;
  /** How long the old owner waits for a BLOCK_MOVE_HELD answer. Default HELD_ASK_TIMEOUT_MS. */
  askTimeoutMs?: number;
  /** How long the old owner waits for the new owner's BLOCK_MOVE_PROBE answer. Default MOVE_PROBE_TIMEOUT_MS. */
  probeTimeoutMs?: number;
  /** This node's event-loop lag in ms (the lagMs its load report carries); it lengthens the probe wait. Absent: 0. */
  lagMs?: () => number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Taken { part: BlockPart<any>; data: unknown }
interface Given { blockEpoch: number; orderId: string; lost?: { move: BlockMove; taken: Taken[] }; asked?: Asked; heldWarned?: boolean; deciding?: boolean }

const givenKey = (map: string, bx: number, by: number) => `${bareMap(map)}|${bx},${by}`;
const toMove = (order: MoveOrder): BlockMove => ({ id: order.id, map: order.map, bx: order.bx, by: order.by, from: order.from, to: order.to });
const where = (move: Pick<BlockMove, "map" | "bx" | "by">) => `block ${move.bx},${move.by} of map ${move.map}`;
const named = (taken: Taken[]) => taken.map((entry) => entry.part.name).join(", ") || "nothing";
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Adds `id` to a bounded set, the oldest forgotten first (HELD_KEEP).
function remember(set: Set<string>, id: string): void {
  set.delete(id);
  set.add(id);
  while (set.size > HELD_KEEP) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

function outcomeText(outcome: CallOutcome<BlockMoveAnswer> | null): string {
  if (!outcome) return "the call could not be made";
  if (outcome.ok) return `refused: ${outcome.answer?.reason ?? "no reason given"}`;
  return neverRan(outcome) ? `not run (${outcome.why})` : `${outcome.why}, it may have run`;
}

export class BlockMover {
  /** Orders this node is carrying out as the old owner: a second bus message for one of them does nothing. */
  private readonly inFlight = new Set<string>();
  /** The one order this node is sending a block for; another one meanwhile is aborted. */
  private sending: string | null = null;
  /** Blocks this node sent (or lost at the deadline), by givenKey, until it knows where they went. */
  private readonly given = new Map<string, Given>();
  /** New owner: the orders this node took in (its swap to "sent" landed), by id. Its own memory, not the store's. */
  private readonly took = new Set<string>();
  /** New owner: the orders whose take is under way (between the claim and the swap's answer). */
  private readonly taking = new Map<string, Promise<EndedOrder | null>>();
  /** New owner: the orders it told the old owner it did not take. It never takes them in after that. */
  private readonly refused = new Set<string>();
  private readonly parts: () => Array<BlockPart<any>>;
  private readonly timeoutMs: number;
  private readonly retryMs: number;
  private readonly decideForMs: number;
  private readonly undecidedHoldMs: number;
  private readonly askTimeoutMs: number;
  private readonly probeTimeoutMs: number;
  /** Old owner: the orders held undecided now (close, the hold), by id. */
  private readonly holding = new Set<string>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: BlockMoverDeps) {
    this.parts = deps.parts ?? blockParts;
    this.timeoutMs = deps.timeoutMs ?? BLOCK_MOVE_TIMEOUT_MS;
    this.retryMs = deps.retryMs ?? DECIDE_RETRY_MS;
    this.decideForMs = deps.decideForMs ?? DECIDE_FOR_MS;
    this.undecidedHoldMs = deps.undecidedHoldMs ?? UNDECIDED_HOLD_MS;
    this.askTimeoutMs = deps.askTimeoutMs ?? HELD_ASK_TIMEOUT_MS;
    this.probeTimeoutMs = deps.probeTimeoutMs ?? MOVE_PROBE_TIMEOUT_MS;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? wait;
  }

  /** Answers BLOCK_MOVE, BLOCK_MOVE_PROBE and BLOCK_MOVE_HELD on this node. The returned function stops it. */
  start(): () => void {
    const offs = [
      this.deps.calls.handle(BLOCK_MOVE, (body, from) => this.accept(body, from)),
      this.deps.calls.handle(BLOCK_MOVE_HELD, (body) => this.heldHere(body)),
      this.deps.calls.handle(BLOCK_MOVE_PROBE, () => this.probeHere()),
    ];
    return () => {
      for (const off of offs) off();
    };
  }

  /** The bus message `block-move { id }`, from the coordinator. */
  onBusMessage(data: unknown): void {
    const id = (data as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || id === "") return;
    void this.run(id).catch((error) => log.error(`Move order ${id} could not be started on ${this.deps.self}: ${error}`));
  }

  givenAway(map: string, bx: number, by: number): boolean {
    const key = givenKey(map, bx, by);
    const entry = this.given.get(key);
    if (!entry) return false;
    return !this.releaseIfMoved(key, entry, this.deps.ownerOf(bareMap(map), bx, by));
  }

  /** How many blocks this node holds as given away. One fewer after a review: a block is this node's again. */
  givenCount(): number {
    return this.given.size;
  }

  async seed(): Promise<number> {
    let seeded = 0;
    for (const order of await this.deps.orders.all()) {
      if (order.from !== this.deps.self || !isOpen(order)) continue;
      this.give(order, undefined, order.state === "ordered" ? undefined : { run: await this.announcedRun(order.to) });
      seeded++;
    }
    if (seeded > 0) log.warn(`${this.deps.self} holds ${seeded} block(s) of open move orders as given away until their orders close`);
    return seeded;
  }

  async review(): Promise<void> {
    for (const [key, entry] of [...this.given]) {
      let order: MoveOrder | null;
      try {
        order = await this.deps.orders.get(entry.orderId);
      } catch (error) {
        log.warn(`Move order ${entry.orderId} cannot be read (${error}): ${key} stays given away`);
        return;
      }
      // A block whose move is still being decided is the move's to settle (close): it puts the parts back itself.
      if (entry.deciding || order?.state !== "aborted" || this.given.get(key) !== entry) continue;
      if (entry.asked) {
        const whereabouts = await this.whereIs(toMove(order), entry.asked);
        if (this.given.get(key) !== entry) continue;
        if (whereabouts === "held") {
          if (!entry.heldWarned) {
            entry.heldWarned = true;
            log.error(`Move order ${entry.orderId} reads aborted, but ${order.to} took it in: the order record was rolled back. ${key} stays given away, and the order is written forward to sent`);
          }
          // One try per review; the next review tries again.
          await this.forward(order, {}, null);
        }
        if (whereabouts !== "free") continue;
      }
      // The parts of a lost move first, while the block is still given away: nothing spawns there meanwhile.
      if (entry.lost) await this.lostAborted(entry.lost.move, entry.lost.taken);
      if (this.given.get(key) !== entry) continue;
      this.given.delete(key);
      log.info(`Move order ${entry.orderId} was aborted: ${this.deps.self} holds ${key} again`);
    }
  }

  // `deciding`: the move is still being decided (close), so review leaves the block alone and the move releases it.
  private give(order: MoveOrder, lost?: Taken[], asked?: Asked | null, deciding = false): void {
    this.given.set(givenKey(order.map, order.bx, order.by), {
      blockEpoch: order.blockEpoch,
      orderId: order.id,
      ...(deciding ? { deciding } : {}),
      ...(lost ? { lost: { move: toMove(order), taken: lost } } : {}),
      ...(asked ? { asked } : {}),
    });
  }

  private async whereIs(move: BlockMove, asked: Asked): Promise<Whereabouts> {
    let outcome: CallOutcome<HeldAnswer> | null = null;
    try {
      outcome = await this.deps.calls.call<HeldAnswer>(move.to, BLOCK_MOVE_HELD, { id: move.id }, { timeoutMs: this.askTimeoutMs });
    } catch (error) {
      log.warn(`Move order ${move.id}: asking ${move.to} whether it took ${where(move)} in threw: ${error}`);
    }
    if (outcome?.ok) {
      if (outcome.answer?.held === false) return "free";
      if (outcome.answer?.held === true) return "held";
      return "unknown";
    }
    return (await this.buried(move.to, asked)) ? "free" : "unknown";
  }

  private async buried(nodeId: string, asked: Asked): Promise<boolean> {
    if (asked.run === null || !this.deps.buriedRun) return false;
    try {
      const dead = await this.deps.buriedRun(nodeId);
      if (dead === null) return false;
      const current = (await this.deps.runOf?.(nodeId)) ?? null;
      return dead >= Math.max(asked.run, current ?? asked.run);
    } catch (error) {
      log.warn(`The tombstone of ${nodeId} cannot be read (${error})`);
      return false;
    }
  }

  // The run node `nodeId` announced, or null when it cannot be read.
  private async announcedRun(nodeId: string): Promise<number | null> {
    try {
      return (await this.deps.runOf?.(nodeId)) ?? null;
    } catch {
      return null;
    }
  }

  /** New owner: the BLOCK_MOVE_HELD handler. An order not taken in here is refused here from now on. */
  heldHere(body: unknown): HeldAnswer {
    const id = (body as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || id === "") return { held: null };
    if (this.took.has(id)) return { held: true };
    if (this.taking.has(id)) return { held: null };
    remember(this.refused, id);
    return { held: false };
  }

  probeHere(): ProbeAnswer {
    return { ready: this.deps.canOwn ? this.deps.canOwn() : true };
  }

  // How long the probe waits: the base, or 8 x this node's own loop lag when that is longer, up to MOVE_PROBE_MAX_MS.
  private probeWaitMs(): number {
    let lag = 0;
    try {
      lag = this.deps.lagMs?.() ?? 0;
    } catch {
      lag = 0;
    }
    return probeDeadlineMs(lag, this.probeTimeoutMs);
  }

  private async probe(move: BlockMove, waitMs: number): Promise<boolean> {
    try {
      const outcome = await this.deps.calls.call<ProbeAnswer>(move.to, BLOCK_MOVE_PROBE, { id: move.id }, { timeoutMs: waitMs });
      return outcome.ok && outcome.answer?.ready === true;
    } catch (error) {
      log.warn(`Move order ${move.id}: probing ${move.to} for ${where(move)} threw: ${error}`);
      return false;
    }
  }

  // Tells each part the state is held `forMs` more (BlockPart.hold).
  private async holdOn(move: BlockMove, taken: Taken[], forMs: number): Promise<void> {
    for (const { part, data } of taken) {
      try {
        await part.hold?.(move, data, forMs);
      } catch (error) {
        log.error(`Move order ${move.id}: the ${part.name} of ${where(move)} could not be told to hold on to what was taken out on ${this.deps.self}: ${error}`);
      }
    }
  }

  // The block held given away while its move was decided is this node's again: its parts are put back.
  private release(order: MoveOrder): void {
    const key = givenKey(order.map, order.bx, order.by);
    const entry = this.given.get(key);
    if (entry?.deciding && entry.orderId === order.id) this.given.delete(key);
  }

  // Highest order first, as a restore.
  private async lostAborted(move: BlockMove, taken: Taken[]): Promise<void> {
    for (const { part, data } of [...taken].reverse()) {
      try {
        await part.lostAborted?.(move, data);
      } catch (error) {
        log.error(`Move order ${move.id}: the ${part.name} of ${where(move)} could not put back what other nodes hold of it on ${this.deps.self}: ${error}`);
      }
    }
  }

  // Only once the table shows the block at a higher epoch than this node gave it away at. True when released.
  private releaseIfMoved(key: string, entry: Given, owner: BlockOwner | null): boolean {
    if (!owner || owner.epoch <= entry.blockEpoch) return false;
    this.given.delete(key);
    return true;
  }

  /** Old owner: carries order `id` out. One run per order at a time; a second bus message for it does nothing. */
  async run(id: string): Promise<MoveEnd> {
    if (this.inFlight.has(id)) return "skipped";
    this.inFlight.add(id);
    try {
      return await this.carryOut(id);
    } finally {
      this.inFlight.delete(id);
      if (this.sending === id) this.sending = null;
    }
  }

  // Whether this node holds the order's block at the order's epoch, by its own table.
  private holds(order: MoveOrder): BlockOwner | null | true {
    const owner = this.deps.ownerOf(order.map, order.bx, order.by);
    return owner?.nodeId === this.deps.self && owner.epoch === order.blockEpoch ? true : owner;
  }

  private async carryOut(id: string): Promise<MoveEnd> {
    const { self, orders } = this.deps;
    const order = await orders.get(id);
    if (!order || order.state !== "ordered") return "skipped";
    if (order.from !== self) {
      log.warn(`Move order ${id} names ${order.from} as the old owner, not ${self}: left alone`);
      return "skipped";
    }
    if (this.givenAway(order.map, order.bx, order.by)) {
      await orders.swapWith(id, "ordered", "aborted", { reason: "held" });
      log.warn(`Move order ${id}: ${where(order)} is still given away by an earlier move from ${self}: aborted`);
      return "skipped";
    }
    // One outgoing move at a time. The check and the claim run with no await between them.
    if (this.sending !== null) {
      await orders.swapWith(id, "ordered", "aborted", { reason: "busy" });
      log.warn(`Move order ${id}: ${self} is already sending a block (order ${this.sending}): aborted`);
      return "skipped";
    }
    this.sending = id;
    const held = this.holds(order);
    if (held !== true) {
      await orders.swap(id, "ordered", "aborted");
      log.warn(`Move order ${id}: ${self} does not hold ${where(order)} at epoch ${order.blockEpoch} (it has ${held ? `${held.nodeId} at ${held.epoch}` : "no owner"}): aborted`);
      return "skipped";
    }
    // The start is one swap: an order the coordinator aborted meanwhile is not started.
    const sending = await orders.swap(id, "ordered", "sending");
    if (!sending) return "skipped";
    const probeWait = this.probeWaitMs();
    let deadline = this.now() + this.timeoutMs + this.decideForMs;
    const move = toMove(sending);
    // Checked again at "sending": the table may have changed while the start was written. Nothing is taken out yet.
    const still = this.holds(sending);
    if (still !== true) {
      log.warn(`Move order ${id}: ${where(move)} left ${self} while the order started (it has ${still ? `${still.nodeId} at ${still.epoch}` : "no owner"}): closed`);
      const end = await this.close(sending, [], deadline);
      return end === "restored" ? "skipped" : end;
    }
    // Nothing is taken out until the new owner answers a small call: a stalled link is found here, with nothing frozen.
    const answered = await this.probe(move, probeWait);
    deadline = this.now() + this.timeoutMs + this.decideForMs;
    if (!answered) {
      log.warn(`Move order ${id}: ${move.to} did not answer the probe in ${probeWait} ms (or is not ready): ${where(move)} stays on ${self}, nothing was taken out`);
      const end = await this.close(sending, [], deadline, "unreachable");
      return end === "restored" ? "skipped" : end;
    }
    const taken: Taken[] = [];
    try {
      for (const part of this.parts()) {
        const data = await part.collect(move);
        taken.push({ part, data });
      }
    } catch (error) {
      log.error(`Move order ${id}: a part of ${where(move)} could not be collected (${error}): what was collected is put back`);
      return this.close(sending, taken, deadline);
    }
    const body: BlockMoveBody = { order: sending, parts: Object.fromEntries(taken.map((entry) => [entry.part.name, entry.data])) };
    // The new owner's run as announced now, before the call: the run that may take the parts in.
    const asked: Asked = { run: await this.announcedRun(move.to) };
    let outcome: CallOutcome<BlockMoveAnswer> | null = null;
    try {
      outcome = await this.deps.calls.call<BlockMoveAnswer>(move.to, BLOCK_MOVE, body, { timeoutMs: this.timeoutMs });
    } catch (error) {
      log.error(`Move order ${id}: the call to ${move.to} threw: ${error}`);
    }
    if (outcome?.ok && outcome.answer?.ok) {
      this.give(sending, undefined, asked);
      await this.finish(move, taken);
      log.info(`${self} sent ${where(move)} to ${move.to} (order ${id}): ${named(taken)}`);
      return "sent";
    }
    if (outcome && !outcome.ok && outcome.why === "too-big") {
      const bytes = Buffer.byteLength(JSON.stringify(body) ?? "");
      log.warn(`Move order ${id}: the ${named(taken)} of ${where(move)} is ${bytes} bytes, over the ${MAX_CALL_BODY_BYTES} one call carries: it stays on ${self}`);
      return this.close(sending, taken, deadline, "too-big");
    }
    log.warn(`Move order ${id}: ${move.to} did not confirm ${where(move)} (${outcomeText(outcome)}): the order decides`);
    const reached = outcome?.ok !== true && !(outcome && neverRan(outcome));
    return this.close(sending, taken, deadline, undefined, reached ? asked : null);
  }

  private async close(sending: MoveOrder, taken: Taken[], deadline: number, reason?: OrderEnd, asked: Asked | null = null): Promise<MoveEnd> {
    const { self, orders } = this.deps;
    const move = toMove(sending);
    let warned = false;
    let askWarned = false;
    let holding = false;
    try {
      for (;;) {
        try {
          const aborted = reason
            ? await orders.swapWith(move.id, "sending", "aborted", { reason })
            : await orders.swap(move.id, "sending", "aborted");
          const order = aborted ?? await orders.get(move.id);
          if (order?.state === "sent" || order?.state === "done") {
            this.give(sending, undefined, asked);
            await this.finish(move, taken);
            log.info(`${self} sent ${where(move)} to ${move.to} (order ${move.id}, confirmed by the order): ${named(taken)}`);
            return "sent";
          }
          if (order?.state === "aborted") {
            const whereabouts = asked ? await this.whereIs(move, asked) : "free";
            if (whereabouts === "free") {
              await this.restore(move, taken);
              this.release(sending);
              return aborted && reason === "too-big" ? "too-big" : "restored";
            }
            if (whereabouts === "held") {
              log.error(`Move order ${move.id} reads aborted, but ${move.to} took ${where(move)} in: the order record was rolled back. ${self} keeps it given away, and writes the order forward to sent`);
              this.give(sending, undefined, asked);
              await this.finish(move, taken);
              await this.forward(sending, { parts: taken.map((entry) => entry.part.name) }, this.now() + this.decideForMs);
              return "sent";
            }
            if (!askWarned) {
              askWarned = true;
              log.warn(`Move order ${move.id} is aborted, but ${move.to} cannot say whether it took ${where(move)} in: ${self} holds what it took out until it can, or its tombstone is found`);
            }
          } else if (!order) {
            log.error(`Move order ${move.id} is gone before ${self} knew how it ended: the ${named(taken)} of ${where(move)} it took out is lost`);
            await this.lose(sending, taken, asked);
            return "lost";
          }
        } catch (error) {
          if (!warned) {
            warned = true;
            log.warn(`Move order ${move.id} cannot be read (${error}): ${self} holds what it took out of ${where(move)} until it can`);
          }
        }
        if (this.now() >= deadline) {
          if (taken.length === 0) {
            log.warn(`Move order ${move.id} could not be read in time, but nothing was taken out of ${where(move)}: ${self} lets it go`);
            return "skipped";
          }
          if (this.now() < deadline + this.undecidedHoldMs) {
            if (!holding) {
              holding = true;
              this.give(sending, undefined, asked, true);
              this.holding.add(move.id);
              if (this.sending === move.id && this.holding.size <= MAX_FREEING_HOLDS) this.sending = null;
              await this.holdOn(move, taken, deadline + this.undecidedHoldMs + this.askTimeoutMs + this.retryMs - this.now());
              log.warn(`Move order ${move.id} is not decided yet: ${self} keeps holding the ${named(taken)} of ${where(move)} for up to ${this.undecidedHoldMs} ms more, the block stays frozen`);
            }
          } else {
            log.error(`Move order ${move.id} could not be decided in time: the ${named(taken)} of ${where(move)} that ${self} took out is lost`);
            await this.lose(sending, taken, asked);
            return "lost";
          }
        }
        await this.sleep(this.retryMs);
      }
    } finally {
      this.holding.delete(move.id);
    }
  }

  private async forward(order: MoveOrder, notes: OrderNotes, until: number | null): Promise<boolean> {
    let warned = false;
    for (;;) {
      try {
        if (await this.deps.orders.advanceToSent(order, notes)) {
          log.warn(`Move order ${order.id} is written forward to sent: ${order.to} holds ${where(order)}, and the coordinator commits it there`);
          return true;
        }
      } catch (error) {
        if (!warned) {
          warned = true;
          log.warn(`Move order ${order.id} cannot be written forward (${error}): trying again`);
        }
      }
      if (until === null || this.now() >= until) {
        if (until !== null) log.error(`Move order ${order.id} could not be written forward to sent: ${this.deps.self} holds ${where(order)} given away until its table moves on, but a restart before then would serve it while ${order.to} does`);
        return false;
      }
      await this.sleep(this.retryMs);
    }
  }

  private async lose(sending: MoveOrder, taken: Taken[], asked: Asked | null): Promise<void> {
    this.give(sending, taken, asked);
    const move = toMove(sending);
    for (const { part, data } of taken) {
      try {
        await part.lost?.(move, data);
      } catch (error) {
        log.error(`Move order ${move.id}: the ${part.name} of ${where(move)} could not drop what it lost on ${this.deps.self}: ${error}`);
      }
    }
  }

  // Highest order first: the reverse of collect.
  private async restore(move: BlockMove, taken: Taken[]): Promise<void> {
    for (const { part, data } of [...taken].reverse()) {
      try {
        await part.restore(move, data);
      } catch (error) {
        log.error(`Move order ${move.id}: the ${part.name} of ${where(move)} could not be put back on ${this.deps.self}, and is lost: ${error}`);
      }
    }
    log.warn(`Move order ${move.id}: ${where(move)} stays on ${this.deps.self}, and what was taken out is put back (${named(taken)})`);
  }

  private async finish(move: BlockMove, taken: Taken[]): Promise<void> {
    for (const { part, data } of taken) {
      try {
        await part.sent?.(move, data);
      } catch (error) {
        log.error(`Move order ${move.id}: the ${part.name} of ${where(move)} could not finish after it was sent: ${error}`);
      }
    }
  }

  /** New owner: the BLOCK_MOVE handler. */
  async accept(body: unknown, from: string): Promise<BlockMoveAnswer> {
    const { self, orders } = this.deps;
    const sent = body as Partial<BlockMoveBody> | null;
    const id = sent?.order?.id;
    const parts = sent?.parts;
    if (typeof id !== "string" || !parts || typeof parts !== "object" || Array.isArray(parts)) return { ok: false, reason: "malformed" };
    const order = await orders.get(id);
    if (!order) return { ok: false, reason: "no such order" };
    // Only the old owner the order names may hand this node a block, and only one the order sends here.
    if (order.from !== from || order.to !== self) return { ok: false, reason: "not this pair" };
    if (this.took.has(id)) return { ok: true };
    if (order.state === "sent" || order.state === "done") return { ok: false, reason: "taken in by another run" };
    if (order.state !== "sending") return { ok: false, reason: `the order is ${order.state}` };
    if (this.deps.canOwn && !this.deps.canOwn()) return { ok: false, reason: "this node may not own blocks now" };
    const owner = this.deps.ownerOf(order.map, order.bx, order.by);
    if (owner?.nodeId !== order.from || owner.epoch !== order.blockEpoch) {
      return { ok: false, reason: `the block is not ${order.from}'s at epoch ${order.blockEpoch} here` };
    }
    if (this.took.has(id)) return { ok: true };
    if (this.refused.has(id)) return { ok: false, reason: "the old owner was told it was not taken in" };
    // A second call while the take is under way answers as the take ends, and takes nothing in.
    const under = this.taking.get(id);
    if (under) return (await under.catch(() => null)) ? { ok: true } : { ok: false, reason: "the order was closed" };
    const take = orders.swapWith(id, "sending", "sent", { parts: Object.keys(parts) });
    this.taking.set(id, take);
    let taken: EndedOrder | null;
    try {
      taken = await take;
      if (taken) remember(this.took, id);
    } finally {
      this.taking.delete(id);
    }
    if (!taken) return { ok: false, reason: "the order was closed" };
    // The stored order's block: the body's is only what the sender says.
    const move = toMove(taken);
    const known = new Set<string>();
    for (const part of this.parts()) {
      known.add(part.name);
      if (!Object.hasOwn(parts, part.name)) continue;
      try {
        await part.accept(move, (parts as Record<string, unknown>)[part.name], from);
      } catch (error) {
        log.error(`Move order ${id}: ${self} could not take in the ${part.name} of ${where(move)} from ${from}, and it is lost: ${error}`);
      }
    }
    for (const name of Object.keys(parts)) {
      if (!known.has(name)) log.error(`Move order ${id}: ${self} has no part ${name}: the ${name} of ${where(move)} from ${from} is lost`);
    }
    log.info(`${self} took ${where(move)} in from ${from} (order ${id})`);
    return { ok: true };
  }
}
