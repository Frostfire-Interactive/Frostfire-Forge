import log from "../modules/logger";
import { BlockTable, blockEpochKey, blockKey, blockTableKey, type BlockOwner, type MapBlocks, type StoredBlocks } from "./blocks";
import type { ClusterBus } from "./bus";
import { PlayerDirectory } from "./directory";
import { MapCatalogue, type MapExtent } from "./maps";
// Types only: blockmove.ts loads the block parts, which this standalone process must not load.
import { BlockMoveOrders, type EndedOrder } from "./blockmove";
import { MOVES_KEY, isOpen, moveKey } from "./moveorders";
import { ALIVE_TTL_MS, LEASE_MARGIN_MS, NodeRegistry, type LoadReport, type NodeInfo } from "./nodes";
import { NODE_COOLDOWN_MS, REBALANCE_EVERY_MS, planRebalance } from "./rebalance";
import { splitBlocks } from "./split";
import type { ClusterStore } from "./store";
import { refusedRecord } from "./storeseal";

/** Held by the leading coordinator; a node that sees it leaves unowned blocks to it (cluster/index.ts). */
export const LOCK_KEY = "cells:coordinator";
const LOCK_EPOCH_KEY = "cells:coordinator:epoch";
// A node missing from this many full passes in a row, and for at least deadConfirmMs since the first, is dead.
const DEAD_PASSES = 2;
const DEAD_CONFIRM_MS = 2000;
export const DEAD_KEY_PREFIX = "cells:dead:";
export const deadKey = (nodeId: string) => `${DEAD_KEY_PREFIX}${nodeId}`;
/** How long a tombstone stays: long past any stall a node could come back from. */
export const TOMBSTONE_TTL_MS = 600_000;

/** Left where a dead node's blocks were taken from: the node, if it was only stalled, finds it and stops. */
export interface Tombstone { nodeId: string; startedAt: number; at: number }
export interface NodeDeadMessage { nodeId: string; startedAt: number; restarted: boolean }
/** An order its old owner has not started in this long is aborted: the bus message was lost, or the node is gone. */
export const MOVE_START_TIMEOUT_MS = 30_000;
/** An order started this long ago and not taken by its new owner is aborted; the old owner puts the state back. */
export const MOVE_SEND_TIMEOUT_MS = 60_000;
export const ORDER_KEEP_MS = 300_000;
export const MOVE_BACKOFF_MS = 60_000;
export const MOVE_BACKOFF_MAX_MS = 600_000;
/** The rest after the block's `fails`th consecutive abort. */
export const moveBackoffMs = (fails: number) => Math.min(MOVE_BACKOFF_MAX_MS, MOVE_BACKOFF_MS * 2 ** Math.max(0, fails - 1));
const RUN_KEY_PREFIX = "cells:noderun:";
const runKey = (nodeId: string) => `${RUN_KEY_PREFIX}${nodeId}`;
interface NodeRun { startedAt: number; live: boolean }
// The settle wait when only expectedNodes is set: a node that never starts cannot hold back the split for good.
const SETTLE_CAP_MS = 60_000;
const NEVER_LIVE_GRACE_MS = 60_000;
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

export interface CoordinatorOptions {
  id?: string;
  lockTtlMs?: number;
  tickMs?: number;
  now?: () => number;
  monotonic?: () => number;
  expectedNodes?: number;
  settleMs?: number;
  /** How long a node must have been missing (over at least two passes) before its blocks are taken over. Default 2000. */
  deadConfirmMs?: number;
  /** How often the leader looks for overloaded nodes (rebalance.ts). Default 10 s; 0 turns rebalancing off. */
  rebalanceEveryMs?: number;
  /** The wait for a lease to lapse before a takeover writes (see takeOver). Tests record it instead. */
  sleep?: (ms: number) => Promise<void>;
}

export class Coordinator {
  private registry: NodeRegistry;
  private catalogue: MapCatalogue;
  private blocks: BlockTable;
  private id: string;
  private lockTtlMs: number;
  private tickMs: number;
  private now: () => number;
  private monotonic: () => number;

  private leader = false;
  // Our hold of the lock, kept while a renewal fails on an error: the next one may still find it ours.
  private lock: { value: string; epoch: number } | null = null;
  private locking: Promise<void> | null = null;
  private ticking: Promise<void> | null = null;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  // Maps whose stored table could not be read: logged once, left alone until it reads again.
  private unreadable = new Set<string>();
  // Maps (by table key) whose table this coordinator run has read: one missing later was deleted, not never written.
  private readonly tablesSeen = new Set<string>();
  // Maps whose table is missing although they were split before: logged once, until the table reads again.
  private readonly missingLogged = new Set<string>();
  private bus: ClusterBus;
  private deadConfirmMs: number;
  // Announced owners seen not live: since when (monotonic), in how many full passes in a row, and which run is judged.
  private missing = new Map<string, { since: number; passes: number; run: NodeRun }>();
  private idle = new Map<string, { since: number; passes: number; startedAt: number }>();
  // Owners never announced, already warned about.
  private warned = new Set<string>();
  // Nodes whose takeover waits for a table that cannot be read, already warned about.
  private heldBack = new Set<string>();
  // A cache of the runs in the store (RUN_KEY_PREFIX), dropped when this coordinator gains the lead.
  private runs = new Map<string, NodeRun>();
  private holdCause: string | null = null;
  private holding = false;
  private holdSince = 0;
  private holdPasses = 0;
  private expectedNodes: number | undefined;
  private settleMs: number;
  // When this coordinator first saw a live node; and whether the settle rule has been met.
  private firstLiveAt: number | null = null;
  private settled = false;
  // The live count when the 60 s cap (not the nodes) met the rule; read and cleared by that pass.
  private capped: number | null = null;
  private orders: BlockMoveOrders;
  private rebalanceEveryMs: number;
  private sleep: (ms: number) => Promise<void>;
  private rebalancedAt = Number.NEGATIVE_INFINITY;
  private tooBigLogged = new Set<string>();
  private moveFails = new Map<string, { fails: number; until: number; from: string; to: string; pair: boolean }>();
  private busyRests = new Map<string, { until: number; from: string; to: string }>();
  private pairRests = new Map<string, { until: number; from: string; to: string }>();
  private moveCounted = new Set<string>();

  constructor(private store: ClusterStore, bus: ClusterBus, options: CoordinatorOptions = {}) {
    this.bus = bus;
    this.registry = new NodeRegistry(store);
    this.catalogue = new MapCatalogue(store);
    this.blocks = new BlockTable(store);
    // Attached so that write tells the nodes ("blocks-changed").
    this.blocks.attach(bus);
    this.id = options.id ?? `coordinator-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    this.lockTtlMs = options.lockTtlMs ?? 5000;
    this.tickMs = options.tickMs ?? 1000;
    this.now = options.now ?? Date.now;
    this.orders = new BlockMoveOrders(store, this.now);
    this.monotonic = options.monotonic ?? options.now ?? (() => performance.now());
    this.expectedNodes = options.expectedNodes;
    this.settleMs = options.settleMs ?? 0;
    this.deadConfirmMs = options.deadConfirmMs ?? DEAD_CONFIRM_MS;
    this.rebalanceEveryMs = options.rebalanceEveryMs ?? REBALANCE_EVERY_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  async start(): Promise<void> {
    if (this.timers.length > 0) return;
    const run = (what: string, work: () => Promise<void>) =>
      work().catch((error) => log.error(`Coordinator ${this.id}: ${what} failed: ${error}`));
    // Renewed five times per ttl: a renewal or two may fail without losing the lock.
    this.timers.push(setInterval(() => run("lock renewal", () => this.holdLock()), Math.max(1, Math.floor(this.lockTtlMs / 5))));
    this.timers.push(setInterval(() => run("tick", () => this.tick()), this.tickMs));
    await run("tick", () => this.tick());
  }

  /** Stops, and gives the lock up so a standby leads at once. */
  async stop(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    await this.ticking?.catch(() => {});
    await this.locking;
    const lock = this.lock;
    const wasLeader = this.leader;
    this.leader = false;
    this.lock = null;
    if (!lock) return;
    try {
      await this.store.deleteIfEpoch(LOCK_KEY, lock.epoch);
    } catch (error) {
      log.error(`Coordinator ${this.id} could not give up the lock (it runs out on its own): ${error}`);
    }
    if (wasLeader) log.info(`Coordinator ${this.id} stepped down`);
  }

  isLeader(): boolean {
    return this.leader;
  }

  /** One pass: hold (or try for) the lock, and as leader give out the blocks that have no owner. */
  tick(): Promise<void> {
    this.ticking ??= this.pass().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  private async pass(): Promise<void> {
    await this.holdLock();
    if (!this.leader) return;
    try {
      await this.assign();
    } catch (error) {
      this.lostStore(error);
      throw error;
    }
  }

  private lostStore(error: unknown): void {
    this.holdCause ??= `the store failed (${error})`;
    this.missing.clear();
    this.idle.clear();
  }

  private gainedLead(): void {
    this.holdCause ??= "it took the lead";
    this.missing.clear();
    this.idle.clear();
    this.runs.clear();
  }

  // One renewal or attempt at a time; a tick that comes during one waits for it.
  private holdLock(): Promise<void> {
    this.locking ??= this.renewOrAcquire()
      .catch((error) => {
        // Stop acting at once: without the store there is no knowing whether the lock is still ours.
        if (this.leader) log.error(`Coordinator ${this.id} could not renew the lock, standing by: ${error}`);
        this.leader = false;
        this.lostStore(error);
      })
      .finally(() => { this.locking = null; });
    return this.locking;
  }

  private async renewOrAcquire(): Promise<void> {
    if (this.lock) {
      if (await this.store.renewIfEpoch(LOCK_KEY, this.lock.epoch, this.lockTtlMs)) {
        if (!this.leader) {
          log.success(`Coordinator ${this.id} leads again`);
          this.gainedLead();
        }
        this.leader = true;
        return;
      }
      if (this.leader) log.warn(`Coordinator ${this.id} lost the lock, standing by`);
      this.leader = false;
      this.lock = null;
    }
    const epoch = await this.store.incrBy(LOCK_EPOCH_KEY, 1);
    const value = JSON.stringify({ holder: this.id, epoch });
    if (await this.store.setIfAbsent(LOCK_KEY, value, this.lockTtlMs)) {
      this.lock = { value, epoch };
      this.leader = true;
      this.gainedLead();
      log.success(`Coordinator ${this.id} leads`);
    }
  }

  // Right before a write: the lock may have run out (a stall) since it was last renewed.
  private async confirm(): Promise<boolean> {
    if (!this.leader || !this.lock) return false;
    if ((await this.store.get(LOCK_KEY)) === this.lock.value) return true;
    this.leader = false;
    log.warn(`Coordinator ${this.id} lost the lock, standing by`);
    return false;
  }

  private async assign(): Promise<void> {
    const liveNodes = await this.registry.live();
    const live = liveNodes.map((node) => node.nodeId);
    if (live.length === 0) return;
    await this.watchRestarts(liveNodes);
    await this.settleMoves(live);
    if (!this.leader) return;
    const settled = this.settledWith(live.length);
    // Set on the one pass where the cap met the rule: logged only if that pass splits an empty table.
    let capped = this.capped;
    this.capped = null;
    let waiting = false; // an empty table held back by the settle rule this pass
    const loads = await this.registry.loads();
    const absent = new Map<string, number>(); // owner not live: blocks it holds
    for (const extent of await this.catalogue.all()) {
      if (!this.leader) return;
      const stored = await this.readTable(extent.name);
      if (stored.state === "corrupt") {
        if (!this.unreadable.has(extent.name)) {
          this.unreadable.add(extent.name);
          log.error(`The block table of map ${extent.name} cannot be read: the coordinator leaves it alone until it can`);
        }
        continue;
      }
      if (this.unreadable.delete(extent.name)) log.success(`The block table of map ${extent.name} can be read again`);
      const table = stored.state === "ok" ? stored.table : { epoch: 0, owners: {} };
      for (const owner of Object.values(table.owners)) {
        if (owner?.nodeId && !live.includes(owner.nodeId)) absent.set(owner.nodeId, (absent.get(owner.nodeId) ?? 0) + 1);
      }
      // A split is final (owned blocks never move): it waits until the nodes starting with this one are live.
      if (!settled && Object.keys(table.owners).length === 0) {
        waiting = true;
        continue;
      }
      // Logged with the first empty table the cap lets through, not when nothing was waiting (a late leader).
      if (capped !== null && Object.keys(table.owners).length === 0) {
        log.info(`Coordinator ${this.id} settle cap reached: splitting over ${capped}/${this.expectedNodes} nodes`);
        capped = null;
      }
      const given = this.place(extent, table, live, loads);
      if (given.size === 0) continue;
      if (!(await this.confirm())) return;
      const next = this.withOwners(table, given, await this.blocks.nextEpoch(extent.name, table.epoch));
      // Over the table as it was read: if another (newer) leader wrote since, this one is out of date.
      if (!(await this.blocks.writeIfEpoch(extent.name, stored.state === "ok" ? stored.table.epoch : 0, next))) {
        log.warn(`The block table of map ${extent.name} changed while the coordinator was assigning: skipped until the next pass`);
        continue;
      }
      log.info(`Coordinator ${this.id} assigned blocks of map ${extent.name} (epoch ${next.epoch})`);
    }
    if (waiting) {
      const of = this.expectedNodes === undefined ? "" : `/${this.expectedNodes}`;
      const limit = this.settleLimit();
      const left = limit > 0 ? `, at most ${Math.ceil((limit - (this.now() - this.firstLiveAt!)) / 1000)} s more` : "";
      log.info(`Coordinator ${this.id} waiting for ${live.length}${of} nodes before splitting new maps${left}`);
    }
    // Only after a full pass: a pass cut short has not seen every owner.
    await this.watchDead(absent, live, loads);
    await this.rebalance(live, loads);
  }

  private async readTable(map: string): Promise<StoredBlocks> {
    const stored = await this.blocks.readStored(map);
    const key = blockTableKey(map);
    if (stored.state !== "absent") {
      this.tablesSeen.add(key);
      if (this.missingLogged.delete(key)) log.success(`The block table of map ${map} is back`);
      return stored;
    }
    if (await refusedRecord(this.store, key)) return { state: "corrupt" };
    const counter = await this.blocks.epochCounter(map);
    const seen = this.tablesSeen.has(key);
    if (!seen && (counter === null || counter === 0)) return stored;
    if (!this.missingLogged.has(key)) {
      this.missingLogged.add(key);
      const why = seen ? "this coordinator read it before" : `its epoch counter is ${counter}`;
      log.error(`The block table of map ${map} is missing, but the map was split before (${why}): it is left alone, so no block is given a second time. Put the table back from a backup; to split the map afresh, stop the cluster and delete ${key} and ${blockEpochKey(map)}`);
    }
    return { state: "corrupt" };
  }

  // The settle rule (see CoordinatorOptions): whether empty tables may be split now, with `live` nodes live.
  private settledWith(live: number): boolean {
    if (this.settled) return true;
    const now = this.now();
    this.firstLiveAt ??= now;
    const enough = this.expectedNodes !== undefined && live >= this.expectedNodes;
    const limit = this.settleLimit();
    const timeUp = limit > 0 && now - this.firstLiveAt >= limit;
    this.settled = limit <= 0 || enough || timeUp;
    // Only the cap (no settleMs of its own) is worth a line: it means an expected node never came.
    if (this.settled && !enough && this.settleMs <= 0 && this.expectedNodes !== undefined) this.capped = live;
    return this.settled;
  }

  // How long the settle rule waits at most, from the first live node: 0 when it does not wait.
  private settleLimit(): number {
    if (this.settleMs > 0) return this.settleMs;
    return this.expectedNodes === undefined ? 0 : SETTLE_CAP_MS;
  }

  private async watchRestarts(nodes: NodeInfo[]): Promise<void> {
    for (const node of nodes) {
      const run = await this.runOf(node.nodeId);
      if (run && run.startedAt === node.startedAt && run.live) continue;
      const beating = await this.registry.isAliveAs(node.nodeId, node.startedAt);
      if (run && run.startedAt === node.startedAt && !beating) continue;
      const fresh = await this.registry.info(node.nodeId);
      if (fresh?.startedAt !== node.startedAt) continue;
      if (!(await this.confirm())) return;
      if (run && run.startedAt !== node.startedAt) {
        log.warn(`Node ${node.nodeId} restarted: its last run is told dead`);
        await this.bus.toWorld("node-dead", { nodeId: node.nodeId, startedAt: run.startedAt, restarted: true } satisfies NodeDeadMessage);
      }
      // Only once the world was told: a notice that failed is sent on a later pass.
      await this.setRun(node.nodeId, { startedAt: node.startedAt, live: beating });
    }
  }

  private async runOf(nodeId: string): Promise<NodeRun | null> {
    const cached = this.runs.get(nodeId);
    if (cached) return cached;
    const raw = await this.store.get(runKey(nodeId));
    let run: NodeRun | null = null;
    try {
      const parsed = raw ? JSON.parse(raw) : null;
      if (typeof parsed?.startedAt === "number") run = { startedAt: parsed.startedAt, live: parsed.live === true };
    } catch {
      run = null;
    }
    if (run) this.runs.set(nodeId, run);
    return run;
  }

  private async setRun(nodeId: string, run: NodeRun): Promise<void> {
    await this.store.set(runKey(nodeId), JSON.stringify(run));
    this.runs.set(nodeId, run);
  }

  private async judgedRun(nodeId: string, known?: NodeInfo): Promise<NodeRun> {
    const info = known ?? (await this.registry.info(nodeId));
    const run = await this.runOf(nodeId);
    if (!run) return { startedAt: info?.startedAt ?? 0, live: false };
    if (!info || info.startedAt === run.startedAt) return run;
    log.warn(`Node ${nodeId} restarted and has not beaten yet: its last run is told dead, its blocks stay`);
    await this.bus.toWorld("node-dead", { nodeId, startedAt: run.startedAt, restarted: true } satisfies NodeDeadMessage);
    const next: NodeRun = { startedAt: info.startedAt, live: false };
    await this.setRun(nodeId, next);
    return next;
  }

  private advanceHold(clock: number): void {
    const length = ALIVE_TTL_MS + DEAD_PASSES * this.tickMs;
    if (this.holdCause !== null) {
      log.info(`Coordinator ${this.id}: ${this.holdCause}: no node is taken over for ${Math.ceil(length / 1000)} s and ${DEAD_PASSES} passes`);
      this.holdCause = null;
      this.holding = true;
      this.holdSince = clock;
      this.holdPasses = 0;
      return;
    }
    if (!this.holding) return;
    this.holdPasses++;
    if (this.holdPasses >= DEAD_PASSES && clock - this.holdSince >= length) this.holding = false;
  }

  private async watchDead(absent: Map<string, number>, live: string[], loads: LoadReport[]): Promise<void> {
    const clock = this.monotonic();
    this.advanceHold(clock);
    const known = new Set(await this.registry.known());
    let cut = false;
    for (const [nodeId, count] of absent) {
      if (!known.has(nodeId)) {
        if (!this.warned.has(nodeId)) {
          this.warned.add(nodeId);
          log.warn(`Node ${nodeId} owns ${count} block(s) but was never announced: they are left with it`);
        }
        continue;
      }
      const run = await this.judgedRun(nodeId);
      let seen = this.missing.get(nodeId);
      // Another run than the one counted so far: its count starts over.
      if (!seen || seen.run.startedAt !== run.startedAt || seen.run.live !== run.live) seen = { since: clock, passes: 0, run };
      seen.passes++;
      this.missing.set(nodeId, seen);
      const wait = seen.run.live ? this.deadConfirmMs : Math.max(this.deadConfirmMs, NEVER_LIVE_GRACE_MS);
      if (seen.passes < DEAD_PASSES || clock - seen.since < wait || this.holding) continue;
      const outcome = await this.takeOver(nodeId, seen.run.startedAt, live, loads);
      if (outcome === "done") this.missing.delete(nodeId);
      if (outcome === "cut") {
        // The lock (or the table) was lost: the other nodes wait for the next pass, but the clean-up below still runs.
        cut = true;
        break;
      }
    }
    // Back, or owning nothing any more: a later absence starts over.
    for (const nodeId of [...this.missing.keys()]) if (!absent.has(nodeId)) this.missing.delete(nodeId);
    for (const nodeId of [...this.warned]) if (!absent.has(nodeId)) this.warned.delete(nodeId);
    for (const nodeId of [...this.heldBack]) if (!absent.has(nodeId)) this.heldBack.delete(nodeId);
    if (!cut) await this.forgetLeftovers(known, live, absent);
  }

  private async forgetLeftovers(known: Set<string>, live: string[], absent: Map<string, number>): Promise<void> {
    // A table that cannot be read may still hold its blocks.
    if (this.unreadable.size > 0) return;
    const clock = this.monotonic();
    const idle = new Set<string>();
    for (const nodeId of known) {
      if (absent.has(nodeId) || live.includes(nodeId)) continue;
      const raw = await this.store.get(deadKey(nodeId));
      const info = await this.registry.info(nodeId);
      if (!raw) {
        if (info && (await this.watchIdle(nodeId, info, clock))) idle.add(nodeId);
        continue;
      }
      let tombstone: Tombstone | null = null;
      try {
        tombstone = JSON.parse(raw) as Tombstone;
      } catch {
        tombstone = null;
      }
      if (typeof tombstone?.startedAt !== "number") continue;
      if (info && info.startedAt !== tombstone.startedAt) {
        // The run kept by the takeover.
        if (await this.watchIdle(nodeId, info, clock)) idle.add(nodeId);
        continue;
      }
      if (await this.registry.isAlive(nodeId)) continue;
      if (!(await this.confirm())) return;
      if (await this.forgetNode(nodeId, tombstone.startedAt)) log.warn(`Node ${nodeId} was taken over but still announced: it is forgotten now`);
    }
    // Live again, owning blocks again, or forgotten: a later spell starts over.
    for (const nodeId of [...this.idle.keys()]) if (!idle.has(nodeId)) this.idle.delete(nodeId);
  }

  private async watchIdle(nodeId: string, info: NodeInfo, clock: number): Promise<boolean> {
    // Tells an older recorded run dead, as for an absent node: its node restarted and the new run never beat.
    const run = await this.judgedRun(nodeId, info);
    if (run.live && run.startedAt === info.startedAt) return false;
    let seen = this.idle.get(nodeId);
    if (!seen || seen.startedAt !== info.startedAt) seen = { since: clock, passes: 0, startedAt: info.startedAt };
    seen.passes++;
    this.idle.set(nodeId, seen);
    if (seen.passes < DEAD_PASSES || clock - seen.since < Math.max(this.deadConfirmMs, NEVER_LIVE_GRACE_MS) || this.holding) return true;
    // Read fresh: a beat since this pass read the registry means the run is up after all.
    if (await this.registry.isAlive(nodeId)) return true;
    if (!(await this.confirm())) return true;
    if (!(await this.forgetNode(nodeId, info.startedAt))) return true;
    log.warn(`Node ${nodeId} announced run ${info.startedAt} but never beat, and owns no block: it is forgotten`);
    return false;
  }

  private async forgetNode(nodeId: string, startedAt: number): Promise<boolean> {
    // The run first: a crash in between leaves a tombstoned node, which forgetLeftovers finishes.
    await this.store.del(runKey(nodeId));
    this.runs.delete(nodeId);
    const forgotten = await this.registry.forgetRun(nodeId, startedAt);
    this.heldBack.delete(nodeId);
    return forgotten;
  }

  private async takeOver(nodeId: string, startedAt: number, live: string[], loads: LoadReport[]): Promise<"done" | "kept" | "cut"> {
    if (await this.registry.isAlive(nodeId)) return "kept";
    if (((await this.registry.info(nodeId))?.startedAt ?? startedAt) !== startedAt) return "kept";
    // A table that cannot be read may hold blocks of the node: forgetting it would strand them there for good.
    const extents = await this.catalogue.all();
    for (const extent of extents) {
      if ((await this.readTable(extent.name)).state !== "corrupt") continue;
      if (!this.heldBack.has(nodeId)) {
        this.heldBack.add(nodeId);
        log.warn(`Node ${nodeId} is dead, but the block table of map ${extent.name} cannot be read: it is taken over once it can`);
      }
      return "kept";
    }
    if (!(await this.confirm())) return "cut";
    // First: a node that was only stalled finds it on its next beat and stops before it acts on what it lost.
    const tombstone: Tombstone = { nodeId, startedAt, at: this.now() };
    await this.store.set(deadKey(nodeId), JSON.stringify(tombstone), TOMBSTONE_TTL_MS);
    if (await this.registry.isAliveAs(nodeId, startedAt)) {
      log.warn(`Node ${nodeId} beat while it was taken over: its blocks are given out once its lease has lapsed`);
      await this.sleep(ALIVE_TTL_MS + LEASE_MARGIN_MS);
      if (!(await this.confirm())) return "cut";
    }
    const stillDead = async () => ((await this.registry.info(nodeId))?.startedAt ?? startedAt) === startedAt;
    const cleared = await new PlayerDirectory(this.store, this.id).sweepNode(nodeId, stillDead);
    // Sent again if this takeover is cut short and runs again: receivers must be idempotent.
    await this.bus.toWorld("node-dead", { nodeId, startedAt, restarted: false } satisfies NodeDeadMessage);
    // Its open move orders before its blocks: none it started is left for a new owner to take in after the refill.
    if (!(await this.settleOrdersOf(nodeId, live))) return "cut";
    let moved = 0;
    for (const extent of extents) {
      const stored = await this.readTable(extent.name);
      if (stored.state === "corrupt") return "kept";
      if (stored.state !== "ok") continue;
      const owners = { ...stored.table.owners };
      let theirs = 0;
      for (const [key, owner] of Object.entries(owners)) {
        if (owner?.nodeId !== nodeId) continue;
        delete owners[key];
        theirs++;
      }
      if (theirs === 0) continue;
      const stripped: MapBlocks = { epoch: stored.table.epoch, owners };
      const given = this.fill(extent, stripped, live, loads);
      if (!(await this.confirm())) return "cut";
      const next = this.withOwners(stripped, given, await this.blocks.nextEpoch(extent.name, stored.table.epoch));
      if (!(await this.blocks.writeIfEpoch(extent.name, stored.table.epoch, next))) {
        log.warn(`The block table of map ${extent.name} changed while node ${nodeId} was taken over: again next pass`);
        return "cut";
      }
      moved += theirs;
    }
    const forgotten = await this.forgetNode(nodeId, startedAt);
    log.warn(`Node ${nodeId} is dead: ${moved} block(s) given to its neighbours, ${cleared} player(s) cleared from the directory`);
    if (!forgotten) log.warn(`Node ${nodeId} announced a new run while it was taken over: that run is kept`);
    return "done";
  }

  private async rebalance(live: string[], loads: LoadReport[]): Promise<void> {
    if (this.rebalanceEveryMs <= 0) return;
    const clock = this.monotonic();
    if (clock - this.rebalancedAt < this.rebalanceEveryMs) return;
    this.rebalancedAt = clock;
    // Wall time for the plan: it is compared with each owner's `since`, stored by whichever coordinator gave the block.
    const now = this.now();
    const busy = new Set<string>();
    const tooBig = new Set<string>();
    const listed = ((await this.orders.all()) as EndedOrder[]).sort((a, b) => a.at - b.at);
    for (const order of listed) {
      this.countMove(order);
      if (!isOpen(order)) {
        if (order.reason === "too-big" && now - order.at <= ORDER_KEEP_MS) tooBig.add(`${order.map}|${blockKey(order.bx, order.by)}`);
        if (order.state === "done" && now - order.at < NODE_COOLDOWN_MS) {
          busy.add(order.from);
          busy.add(order.to);
        }
        continue;
      }
      busy.add(order.from);
      busy.add(order.to);
    }
    const ids = new Set(listed.map((order) => order.id));
    for (const id of [...this.moveCounted]) if (!ids.has(id)) this.moveCounted.delete(id);
    for (const id of [...this.busyRests.keys()]) if (!ids.has(id)) this.busyRests.delete(id);
    for (const id of [...this.pairRests.keys()]) if (!ids.has(id)) this.pairRests.delete(id);
    // New owners a node sends nothing to for now (planRebalance noReceiveFrom), by old owner.
    const noReceiveFrom = new Map<string, Set<string>>();
    const bar = (from: string, to: string) => {
      const set = noReceiveFrom.get(from) ?? new Set<string>();
      set.add(to);
      noReceiveFrom.set(from, set);
    };
    for (const rest of this.pairRests.values()) {
      if (now >= rest.until) continue;
      bar(rest.from, rest.to);
    }
    for (const rest of this.busyRests.values()) {
      if (now >= rest.until) continue;
      busy.add(rest.from);
      busy.add(rest.to);
    }
    for (const [key, rest] of [...this.moveFails]) {
      if (now >= rest.until + moveBackoffMs(rest.fails)) {
        this.moveFails.delete(key);
        continue;
      }
      if (now >= rest.until) continue;
      tooBig.add(key);
      if (rest.pair) bar(rest.from, rest.to);
    }
    const tables: Array<{ map: string; table: MapBlocks }> = [];
    // Whether every table was read: only then is a node that owns no block in them known to own none.
    let complete = true;
    for (const extent of await this.catalogue.all()) {
      const stored = await this.readTable(extent.name);
      if (stored.state === "ok") tables.push({ map: extent.name, table: this.withoutTooBig(extent.name, stored.table, tooBig, now) });
      if (stored.state === "corrupt") complete = false;
    }
    const liveSet = new Set(live);
    const moves = planRebalance({
      now,
      tables,
      loads: loads.filter((load) => liveSet.has(load.nodeId)),
      busy,
      noReceiveFrom,
      live: complete ? live : undefined,
    });
    for (const move of moves) {
      if (!(await this.confirm())) return;
      const order = await this.orders.create({ map: move.map, bx: move.bx, by: move.by, from: move.from, to: move.to, blockEpoch: move.blockEpoch });
      log.info(`Coordinator ${this.id} orders block ${move.bx},${move.by} of map ${move.map} from ${move.from} to ${move.to} (load ${move.load})`);
      await this.bus.toNode(move.from, "block-move", { id: order.id });
    }
  }

  private countMove(order: EndedOrder): void {
    if (isOpen(order) || this.moveCounted.has(order.id)) return;
    this.moveCounted.add(order.id);
    const key = `${order.map}|${blockKey(order.bx, order.by)}`;
    if (order.state === "done") {
      this.moveFails.delete(key);
      return;
    }
    if (order.reason === "too-big") return;
    if (order.reason === "unreachable") {
      this.pairRests.set(order.id, { until: order.at + MOVE_BACKOFF_MS, from: order.from, to: order.to });
      log.warn(`Move order ${order.id} (block ${order.bx},${order.by} of map ${order.map}, ${order.from} to ${order.to}) ended aborted, ${order.to} not answering: ${order.from} sends it nothing for ${MOVE_BACKOFF_MS} ms, the block's count is unchanged`);
      return;
    }
    if (order.reason === "busy") {
      this.busyRests.set(order.id, { until: order.at + MOVE_BACKOFF_MS, from: order.from, to: order.to });
      log.warn(`Move order ${order.id} (block ${order.bx},${order.by} of map ${order.map}, ${order.from} to ${order.to}) ended aborted, the old owner being busy: the two nodes rest ${MOVE_BACKOFF_MS} ms, the block's count is unchanged`);
      return;
    }
    const fails = (this.moveFails.get(key)?.fails ?? 0) + 1;
    const pair = order.reason !== "held";
    this.moveFails.set(key, { fails, until: order.at + moveBackoffMs(fails), from: order.from, to: order.to, pair });
    if (!pair) {
      log.warn(`Move order ${order.id} (block ${order.bx},${order.by} of map ${order.map}, ${order.from} to ${order.to}) ended aborted, the block being held by ${order.from}: the block rests ${moveBackoffMs(fails)} ms (${fails} in a row), no node rests`);
      return;
    }
    log.warn(`Move order ${order.id} (block ${order.bx},${order.by} of map ${order.map}, ${order.from} to ${order.to}) ended aborted: the block rests ${moveBackoffMs(fails)} ms, and ${order.from} sends nothing to ${order.to} meanwhile (${fails} in a row)`);
  }

  private withoutTooBig(map: string, table: MapBlocks, tooBig: ReadonlySet<string>, now: number): MapBlocks {
    let owners: Record<string, BlockOwner> | null = null;
    for (const [key, owner] of Object.entries(table.owners)) {
      if (!owner || !tooBig.has(`${map}|${key}`)) continue;
      owners ??= { ...table.owners };
      owners[key] = { ...owner, since: now };
    }
    return owners ? { epoch: table.epoch, owners } : table;
  }

  private async settleMoves(live: string[]): Promise<void> {
    const now = this.now();
    const orders = (await this.orders.all()) as EndedOrder[];
    for (const order of orders) {
      if (!this.leader) return;
      const age = now - order.at;
      const what = `Move order ${order.id} (block ${order.bx},${order.by} of map ${order.map}, ${order.from} to ${order.to})`;
      if (order.state === "sent") {
        if (!(await this.confirm())) return;
        if (await this.commitMove(order, live)) await this.orders.swap(order.id, "sent", "done");
        continue;
      }
      if (order.state === "ordered" && age > MOVE_START_TIMEOUT_MS) {
        if (!(await this.confirm())) return;
        if (await this.orders.swapWith(order.id, "ordered", "aborted", { reason: "not-started" })) log.warn(`${what} was not started in ${MOVE_START_TIMEOUT_MS} ms: aborted`);
        continue;
      }
      if (order.state === "sending" && age > MOVE_SEND_TIMEOUT_MS) {
        if (!(await this.confirm())) return;
        if (await this.orders.swap(order.id, "sending", "aborted")) {
          log.warn(`${what} was not taken by ${order.to} in ${MOVE_SEND_TIMEOUT_MS} ms: aborted, and ${order.from} puts the block's state back if it still holds it`);
        }
        continue;
      }
      if (isOpen(order)) continue;
      if (order.reason === "too-big" && !this.tooBigLogged.has(order.id)) {
        this.tooBigLogged.add(order.id);
        log.warn(`${what} was too big to send: the block stays with ${order.from}, and is not moved for ${ORDER_KEEP_MS} ms`);
      }
      if (age > ORDER_KEEP_MS) {
        if (!(await this.confirm())) return;
        if (await this.store.deleteIfEpoch(moveKey(order.id), order.epoch)) await this.store.removeFromSet(MOVES_KEY, order.id);
      }
    }
    // Logged ids of orders no longer listed: their order was removed.
    const listed = new Set(orders.map((order) => order.id));
    for (const id of [...this.tooBigLogged]) if (!listed.has(id)) this.tooBigLogged.delete(id);
  }

  private async commitMove(order: EndedOrder, live: string[]): Promise<boolean> {
    const stored = await this.readTable(order.map);
    if (stored.state !== "ok") return false;
    const key = blockKey(order.bx, order.by);
    const owner = stored.table.owners[key];
    const where = `block ${order.bx},${order.by} of map ${order.map}`;
    // A pass cut short after its write, or a takeover that gave the block to the new owner anyway.
    if (owner?.nodeId === order.to) return true;
    if (owner?.nodeId !== order.from || owner.epoch !== order.blockEpoch) {
      const parts = order.parts?.length ? order.parts.join(", ") : "its parts";
      log.error(`Move order ${order.id}: ${where} changed hands before the commit (it is ${owner ? `${owner.nodeId}'s at ${owner.epoch}` : "unowned"}): left as it is, and the ${parts} ${order.to} took in are stranded there`);
      return true;
    }
    if (await this.gone(order.to)) return await this.refillMove(order, stored.table, live);
    const epoch = await this.blocks.nextEpoch(order.map, stored.table.epoch);
    const next: MapBlocks = { epoch, owners: { ...stored.table.owners, [key]: { nodeId: order.to, epoch, since: this.now() } } };
    if (!(await this.blocks.writeIfEpoch(order.map, stored.table.epoch, next))) {
      log.warn(`The block table of map ${order.map} changed while move order ${order.id} was committed: again next pass`);
      return false;
    }
    log.info(`Coordinator ${this.id} moved ${where} from ${order.from} to ${order.to} (epoch ${epoch})`);
    return true;
  }

  private async gone(nodeId: string): Promise<boolean> {
    if (!(await this.registry.known()).includes(nodeId)) return true;
    const raw = await this.store.get(deadKey(nodeId));
    if (!raw) return false;
    let tombstone: Tombstone | null;
    try {
      tombstone = JSON.parse(raw) as Tombstone;
    } catch {
      return false;
    }
    if (typeof tombstone?.startedAt !== "number") return false;
    const info = await this.registry.info(nodeId);
    return !info || info.startedAt === tombstone.startedAt;
  }

  private async refillMove(order: EndedOrder, table: MapBlocks, live: string[]): Promise<boolean> {
    const key = blockKey(order.bx, order.by);
    const where = `block ${order.bx},${order.by} of map ${order.map}`;
    const others = live.filter((nodeId) => nodeId !== order.to);
    const owners = { ...table.owners };
    delete owners[key];
    const stripped: MapBlocks = { epoch: table.epoch, owners };
    const extent = (await this.catalogue.all()).find((map) => map.name === order.map);
    const filled = extent && others.length > 0 ? this.fill(extent, stripped, others, await this.registry.loads()).get(key) : undefined;
    const to = filled ?? (others.includes(order.from) ? order.from : undefined);
    if (!to) {
      log.warn(`Move order ${order.id}: ${order.to} is gone and no live node can take ${where}: again next pass`);
      return false;
    }
    const next = this.withOwners(stripped, new Map([[key, to]]), await this.blocks.nextEpoch(order.map, table.epoch));
    if (!(await this.blocks.writeIfEpoch(order.map, table.epoch, next))) {
      log.warn(`The block table of map ${order.map} changed while move order ${order.id} was refilled: again next pass`);
      return false;
    }
    const parts = order.parts?.length ? order.parts.join(", ") : "parts";
    log.error(`Move order ${order.id}: ${order.to} took ${where} in from ${order.from} but is gone (taken over): the block is given to ${to} instead (epoch ${next.epoch}), and the ${parts} ${order.to} took in are lost there`);
    return true;
  }

  private async settleOrdersOf(nodeId: string, live: string[]): Promise<boolean> {
    for (const listed of (await this.orders.all()) as EndedOrder[]) {
      if (listed.from !== nodeId || !isOpen(listed)) continue;
      let order: EndedOrder | null = listed;
      // A swap that fails found the order moved on (the new owner took it in): read again, and act on what it is now.
      for (let tries = 0; order && isOpen(order) && tries < 3; tries++) {
        if (!(await this.confirm())) return false;
        const what = `Move order ${order.id} (block ${order.bx},${order.by} of map ${order.map}, ${order.from} to ${order.to})`;
        if (order.state === "sent") {
          if (!(await this.commitMove(order, live))) return false;
          await this.orders.swap(order.id, "sent", "done");
          break;
        }
        if (await this.orders.swap(order.id, order.state, "aborted")) {
          log.warn(`${what} is aborted: ${nodeId} is dead, and its blocks are given out`);
          break;
        }
        order = (await this.orders.get(order.id)) as EndedOrder | null;
      }
    }
    return true;
  }

  private place(extent: MapExtent, table: MapBlocks, live: string[], loads: LoadReport[]): Map<string, string> {
    if (Object.keys(table.owners).length === 0) {
      const players = new Map<string, number>();
      for (const load of loads) {
        for (const [key, count] of Object.entries(load.blocks ?? {})) {
          const [map, block] = key.split("|");
          if (map === extent.name && block) players.set(block, (players.get(block) ?? 0) + (Number(count) || 0));
        }
      }
      return splitBlocks(extent.blocksX, extent.blocksY, live, (bx, by) => 1 + (players.get(blockKey(bx, by)) ?? 0));
    }
    return this.fill(extent, table, live, loads);
  }

  /** The table with the blocks `given` out at the map's new `epoch`. */
  private withOwners(table: MapBlocks, given: Map<string, string>, epoch: number): MapBlocks {
    // A block with no owner has no epoch to add one to: it takes the map's new epoch, which is above any it had.
    const since = this.now();
    const owners: Record<string, BlockOwner> = { ...table.owners };
    for (const [key, nodeId] of given) owners[key] = { nodeId, epoch, since };
    return { epoch, owners };
  }

  private fill(extent: MapExtent, table: MapBlocks, live: string[], loads: LoadReport[]): Map<string, string> {
    const players = new Map(loads.map((load) => [load.nodeId, load.players ?? 0]));
    const isLive = new Set(live);
    const rank = (a: [string, number], b: [string, number]) =>
      b[1] - a[1] || (players.get(a[0]) ?? 0) - (players.get(b[0]) ?? 0) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

    const given = new Map<string, string>();
    const ownerAt = (bx: number, by: number) => given.get(blockKey(bx, by)) ?? table.owners[blockKey(bx, by)]?.nodeId;
    let free: Array<[number, number]> = [];
    for (let by = 0; by < extent.blocksY; by++) {
      for (let bx = 0; bx < extent.blocksX; bx++) if (!table.owners[blockKey(bx, by)]) free.push([bx, by]);
    }

    while (free.length > 0) {
      const wave: Array<[string, string]> = [];
      for (const [bx, by] of free) {
        const around = new Map<string, number>();
        for (const [dx, dy] of NEIGHBOURS) {
          const nodeId = ownerAt(bx + dx, by + dy);
          if (nodeId && isLive.has(nodeId)) around.set(nodeId, (around.get(nodeId) ?? 0) + 1);
        }
        if (around.size > 0) wave.push([blockKey(bx, by), [...around].sort(rank)[0]![0]]);
      }
      if (wave.length === 0) {
        const [bx, by] = free[0]!;
        wave.push([blockKey(bx, by), live.map((nodeId): [string, number] => [nodeId, 0]).sort(rank)[0]![0]]);
      }
      for (const [key, nodeId] of wave) given.set(key, nodeId);
      free = free.filter(([bx, by]) => !given.has(blockKey(bx, by)));
    }
    return given;
  }
}
