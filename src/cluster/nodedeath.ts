import log from "../modules/logger";
import type { ClusterBus } from "./bus";
import { deadKey, type NodeDeadMessage, type Tombstone } from "./coordinator";
import type { ClusterStore } from "./store";

export const DEAD_CHECK_MS = 1_000;
// Runs remembered as handled; the oldest go first.
export const HANDLED_KEEP = 256;
// How many times a failed step is tried again before it is given up.
export const RETRY_LIMIT = 5;

const nodeInfoKey = (nodeId: string) => `cells:nodeinfo:${nodeId}`;

/** The `startedAt` a JSON record names, or null when it names none (or cannot be parsed). */
function startedAtOf(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw)?.startedAt;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export interface NodeDeathDeps {
  self: string;
  startedAt: number;
  /** ghosts.dropPeer */
  dropMirrors(peer: string): number;
  /** spawner.releaseAwayHeldBy: away slots `peer` held, respawned here. How many. */
  releaseAwayHeldBy(peer: string): number;
  /** spawner.dropForeignFrom: creatures here whose home is `home`, despawned. How many. */
  dropForeignFrom(home: string): number;
  /** Kicks this node's players and exits. Called at most once. */
  fence(why: string): void;
  adopt?(nodeId: string, startedAt: number): void;
  /** A confirmed notice: the run's players are gone. `restarted`: the node is back, and what it holds now is its new run's. */
  playersLost?(peer: string, restarted: boolean): void;
}

type Step = "mirrors" | "away" | "foreign";

interface Pending {
  message: NodeDeadMessage;
  steps: Set<Step>;
  // How many passes had a step fail (a read that fails is not one).
  failures: number;
  // Whether the last nodeinfo read failed (logged once).
  readFailed: boolean;
  // Whether the store confirmed the notice (see the top of the file). False: its record could not be read yet.
  confirmed: boolean;
}

/** What the store says of a notice: it confirms it, denies it, or could not be read. */
type Verdict = "confirmed" | "denied" | "unread";

function messageOf(data: any): NodeDeadMessage | null {
  if (!data || typeof data !== "object") return null;
  if (typeof data.nodeId !== "string" || !data.nodeId) return null;
  if (typeof data.startedAt !== "number" || !Number.isFinite(data.startedAt)) return null;
  return { nodeId: data.nodeId, startedAt: data.startedAt, restarted: data.restarted === true };
}

function remember(set: Set<string>, key: string): void {
  set.add(key);
  if (set.size > HANDLED_KEEP) set.delete(set.values().next().value as string);
}

export class NodeDeath {
  private fenced = false;
  private handled = new Set<string>();
  // Runs ("node|startedAt") told restarted, or found to have a newer run: a death notice for them is a restart.
  private restartedRuns = new Set<string>();
  // Notices under way (the nodeinfo read is awaited), by their own key.
  private running = new Set<string>();
  // Notices with steps that failed, or not yet confirmed because the store could not be read, by their own key.
  private pending = new Map<string, Pending>();
  private retrying = false;

  constructor(private store: Pick<ClusterStore, "get">, private deps: NodeDeathDeps) {}

  isFenced(): boolean {
    return this.fenced;
  }

  attach(bus: Pick<ClusterBus, "on">): void {
    bus.on("node-dead", (data) => { void this.onNodeDead(data); });
  }

  async onNodeDead(data: unknown): Promise<void> {
    if (this.fenced) return;
    const message = messageOf(data);
    if (!message) return;
    if (message.nodeId === this.deps.self && !message.restarted && message.startedAt === this.deps.startedAt) {
      await this.fenceIfConfirmed(message);
      return;
    }
    // Any other notice about this node is about a run of it that is over: it has no steps here, only the adoption.
    const key = `${message.nodeId}|${message.startedAt}|${message.restarted}`;
    if (this.running.has(key)) return;
    if (this.handled.has(key)) {
      this.adopt(message);
      return;
    }
    // A resent notice with failed steps (or one not yet confirmed) tries again now.
    await this.handle(key, message, this.pending.get(key));
  }

  private async fenceIfConfirmed(message: NodeDeadMessage): Promise<void> {
    const verdict = await this.verdict(message);
    if (this.fenced) return;
    // Guard (test "a node-dead naming this run fences only when the tombstone names the run").
    if (verdict === "confirmed") {
      this.fence("the coordinator took this node's blocks");
      return;
    }
    if (verdict === "denied") log.warn(`A node-dead names run ${message.startedAt} of this node (${this.deps.self}), but no tombstone does: it is ignored`);
    else log.warn(`A node-dead names run ${message.startedAt} of this node (${this.deps.self}), but its tombstone could not be read: not fenced on it; the tombstone watch fences once it reads one`);
  }

  private async verdict(message: NodeDeadMessage): Promise<Verdict> {
    const own = message.nodeId === this.deps.self && message.startedAt === this.deps.startedAt;
    try {
      const dead = startedAtOf(await this.store.get(deadKey(message.nodeId)));
      if (dead === message.startedAt) return "confirmed";
      if (!own && dead !== null && dead > message.startedAt) return "confirmed";
      if (!message.restarted || own) return "denied";
      const announced = startedAtOf(await this.store.get(nodeInfoKey(message.nodeId)));
      return announced !== null && announced > message.startedAt ? "confirmed" : "denied";
    } catch {
      return "unread";
    }
  }

  /** The adoption of a confirmed notice's grants. Never for this node's own run, which it checks itself. */
  private adopt(message: NodeDeadMessage): void {
    if (this.fenced || !this.deps.adopt) return;
    if (message.nodeId === this.deps.self && message.startedAt === this.deps.startedAt) return;
    try {
      this.deps.adopt(message.nodeId, message.startedAt);
    } catch (error) {
      log.error(`The hand-overs of run ${message.startedAt} of node ${message.nodeId} could not be adopted: ${error}`);
    }
  }

  /** The steps a notice owes when first handled: none for this node's own last run, the foreign creatures for a restart. */
  private firstSteps(message: NodeDeadMessage): Set<Step> {
    if (message.nodeId === this.deps.self) return new Set();
    return new Set<Step>(message.restarted || this.restartedRuns.has(`${message.nodeId}|${message.startedAt}`) ? ["foreign"] : ["mirrors", "away", "foreign"]);
  }

  /** Tries the failed steps of every notice again, once each. Bounded by RETRY_LIMIT per notice. */
  async retry(): Promise<void> {
    if (this.retrying || this.fenced) return;
    this.retrying = true;
    try {
      for (const [key, pending] of [...this.pending]) {
        if (this.fenced) return;
        // A resent copy may have finished (or replaced) this notice meanwhile: its old steps are not run again.
        if (this.pending.get(key) !== pending) continue;
        if (!this.running.has(key)) await this.handle(key, pending.message, pending);
      }
    } finally {
      this.retrying = false;
    }
  }

  async check(): Promise<boolean> {
    if (this.fenced) return true;
    let tombstone: Tombstone | null = null;
    try {
      const raw = await this.store.get(deadKey(this.deps.self));
      tombstone = raw ? JSON.parse(raw) : null;
    } catch {
      // Redis away, or not a tombstone: nothing is known, so nothing is done.
      return false;
    }
    if (!tombstone || tombstone.startedAt !== this.deps.startedAt) return false;
    this.fence("this node's tombstone was found");
    return true;
  }

  start(everyMs = DEAD_CHECK_MS): () => void {
    let checking = false;
    const timer = setInterval(() => {
      if (checking || this.fenced) return;
      checking = true;
      this.check().then(() => this.retry()).finally(() => { checking = false; });
    }, everyMs);
    (timer as any).unref?.();
    return () => clearInterval(timer);
  }

  private async handle(key: string, message: NodeDeadMessage, again?: Pending): Promise<void> {
    const peer = message.nodeId;
    const run = `${peer}|${message.startedAt}`;
    this.running.add(key);
    try {
      if (!again?.confirmed) {
        const verdict = await this.verdict(message);
        if (this.fenced) return;
        if (verdict === "denied") {
          this.pending.delete(key);
          log.warn(`A node-dead for run ${message.startedAt} of node ${peer}${message.restarted ? " (restarted)" : ""} is not confirmed by the store (no tombstone${message.restarted ? " or later announcement" : ""} names it): it is ignored`);
          return;
        }
        if (verdict === "unread") {
          if (!again) log.error(`A node-dead for run ${message.startedAt} of node ${peer} could not be checked against the store: it waits, and is checked again`);
          this.keepPending(key, { message, steps: again?.steps ?? this.firstSteps(message), failures: again?.failures ?? 0, readFailed: false, confirmed: false });
          return;
        }
        this.adopt(message);
      }
      let restarted = message.restarted || this.restartedRuns.has(run);
      const owed = new Set<Step>(again?.confirmed ? again.steps : this.firstSteps(message));
      let readFailed = false;
      if (!restarted && (owed.has("mirrors") || owed.has("away"))) {
        try {
          const raw = await this.store.get(nodeInfoKey(peer));
          // A record that cannot be parsed counts as none, not as an outage: an outage keeps the notice waiting.
          let current: unknown = null;
          try {
            current = raw ? JSON.parse(raw)?.startedAt : null;
          } catch {
            current = null;
          }
          if (typeof current === "number" && current !== message.startedAt) restarted = true;
        } catch (error) {
          readFailed = true;
          if (!again?.readFailed) log.error(`Reading the announcement of node ${peer} failed, its mirrors and away slots wait: ${error}`);
        }
      }
      if (this.fenced) return;
      if (restarted) {
        remember(this.restartedRuns, run);
        owed.delete("mirrors");
        owed.delete("away");
      }
      if (!again?.confirmed && peer !== this.deps.self) this.deps.playersLost?.(peer, restarted);
      // Already handled as a restart (the notice itself, or a death notice downgraded to one).
      const effective = `${peer}|${message.startedAt}|${restarted}`;
      if (effective !== key && this.handled.has(effective)) {
        this.settle(key, message, new Set(), false, again);
        return;
      }
      const failed = new Set<Step>();
      let mirrors = 0;
      let away = 0;
      let foreign = 0;
      let ran = 0;
      for (const step of owed) {
        if (readFailed && step !== "foreign") continue;
        ran++;
        if (step === "mirrors") mirrors = this.step(failed, step, `Dropping the mirrors of dead node ${peer}`, () => this.deps.dropMirrors(peer));
        else if (step === "away") away = this.step(failed, step, `Releasing the away slots dead node ${peer} held`, () => this.deps.releaseAwayHeldBy(peer));
        else foreign = this.step(failed, step, `Dropping the creatures of dead node ${peer}`, () => this.deps.dropForeignFrom(peer));
      }
      const what = restarted ? "restarted" : "is dead";
      if (ran > 0) log.warn(`Node ${peer} ${what}: ${mirrors} mirror(s), ${away} away slot(s) and ${foreign} foreign creature(s) dropped`);
      // What is still owed: the steps that failed, and the ones that waited for the read.
      const rest = new Set<Step>(failed);
      if (readFailed) for (const step of owed) if (step !== "foreign") rest.add(step);
      this.settle(key, message, rest, readFailed, again, failed.size > 0, effective);
    } finally {
      this.running.delete(key);
    }
  }

  private settle(key: string, message: NodeDeadMessage, owed: Set<Step>, readFailed: boolean, again: Pending | undefined, stepFailed = false, effective?: string): void {
    if (owed.size === 0) {
      this.pending.delete(key);
      remember(this.handled, key);
      if (effective) remember(this.handled, effective);
      return;
    }
    const failures = (again?.failures ?? 0) + (stepFailed ? 1 : 0);
    if (stepFailed && failures > RETRY_LIMIT) {
      this.pending.delete(key);
      remember(this.handled, key);
      log.error(`Gave up on the steps of node-dead for ${message.nodeId} run ${message.startedAt} that failed ${RETRY_LIMIT} times: ${[...owed].join(", ")}`);
      return;
    }
    this.keepPending(key, { message, steps: owed, failures, readFailed, confirmed: true });
  }

  private keepPending(key: string, entry: Pending): void {
    this.pending.delete(key);
    this.pending.set(key, entry);
    if (this.pending.size <= HANDLED_KEEP) return;
    let drop: string | undefined;
    for (const [k, p] of this.pending) {
      if (!p.confirmed) { drop = k; break; }
    }
    drop ??= this.pending.keys().next().value as string;
    const dropped = this.pending.get(drop)!;
    this.pending.delete(drop);
    log.error(`Too many node-dead notices wait: the one for run ${dropped.message.startedAt} of node ${dropped.message.nodeId} is dropped (${dropped.confirmed ? `its steps ${[...dropped.steps].join(", ")} are not done` : "it was never confirmed"})`);
  }

  private fence(why: string): void {
    if (this.fenced) return;
    this.fenced = true;
    log.error(`Cluster node ${this.deps.self} is fenced: ${why}`);
    try {
      this.deps.fence(why);
    } catch (error) {
      log.error(`Fencing cluster node ${this.deps.self} failed: ${error}`);
    }
  }

  private step(failed: Set<Step>, step: Step, what: string, run: () => number): number {
    try {
      return run();
    } catch (error) {
      failed.add(step);
      log.error(`${what} failed: ${error}`);
      return 0;
    }
  }
}
