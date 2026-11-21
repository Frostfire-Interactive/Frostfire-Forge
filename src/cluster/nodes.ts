import log from "../modules/logger";
import type { ClusterStore } from "./store";

export interface NodeInfo {
  nodeId: string;
  regionId: string;
  publicHost: string;
  port: number;
  wtPort: number;
  useSSL: boolean;
  startedAt: number;
  /** Where neighbours dial this node's link listener (spec §1, NODE_LINK_HOST / NODE_LINK_PORT). Absent or 0: no links. */
  linkHost?: string;
  linkPort?: number;
  /** Base64 SHA-256 of the link certificate, pinned by the dialer; "" when it cannot be pinned (CA-signed). */
  certHash?: string;
}

export interface LoadReport {
  nodeId: string;
  at: number;
  players: number;
  /** The awake creatures (observed or in combat) this node counts in its blocks' load, not all it holds. */
  creatures: number;
  /** Every live creature in this node's registry, mirrors and corpses left out. Not load: a count to check against (cluster-chaos.ts). */
  creaturesTotal?: number;
  /** Load per block, players + 0.1 x awake creatures (spec §2), key `${map}|${bx},${by}`. */
  blocks: Record<string, number>;
  lagMs?: number;
  /** The process's memory in MB (resident set). What the control panel's readings add up across the nodes. */
  memoryMb?: number;
}

/** How often the loop-lag meter looks, and how far back its worst value reaches. */
export const LAG_SAMPLE_MS = 250;
export const LAG_WINDOW_MS = 5_000;

export class LoopLagMeter {
  private readonly samples: Array<{ at: number; lag: number }> = [];
  private last: number;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.last = this.now();
  }

  /** Starts sampling. The returned timer is cleared with clearInterval. */
  start(): ReturnType<typeof setInterval> {
    this.last = this.now();
    const timer = setInterval(() => this.sample(), LAG_SAMPLE_MS);
    (timer as any).unref?.();
    return timer;
  }

  /** One look: the delay of this firing against its schedule. */
  sample(): void {
    const at = this.now();
    this.samples.push({ at, lag: Math.max(0, at - this.last - LAG_SAMPLE_MS) });
    this.last = at;
    this.trim(at);
  }

  /** The worst delay in the window, in whole ms. */
  max(): number {
    // A loop that is blocked right now has not fired yet: the time since the last firing counts too.
    const at = this.now();
    this.trim(at);
    let worst = Math.max(0, at - this.last - LAG_SAMPLE_MS);
    for (const sample of this.samples) if (sample.lag > worst) worst = sample.lag;
    return Math.round(worst);
  }

  private trim(at: number): void {
    while (this.samples.length > 0 && at - this.samples[0]!.at > LAG_WINDOW_MS) this.samples.shift();
  }
}

// Beat every second or so: three missed beats and the node is dead.
export const ALIVE_TTL_MS = 3000;

const NODES_KEY = "cells:nodes";
const infoKey = (nodeId: string) => `cells:nodeinfo:${nodeId}`;
const aliveKey = (nodeId: string) => `cells:alive:${nodeId}`;
const loadKey = (nodeId: string) => `cells:load:${nodeId}`;

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

const UNKNOWN_RUN_BEAT = "1";

export const LEASE_MARGIN_MS = 500;

export const tombstoneKey = (nodeId: string) => `cells:dead:${nodeId}`;

export class NodeRegistry {
  // What each node announced through this registry; its run is written as the value of its beat.
  private announced = new Map<string, NodeInfo>();
  // When the last good beat of each node was sent (the lease, see leaseValid).
  private lastGoodBeat = new Map<string, number>();
  // The node this registry last announced or beat for: the one leaseValid() answers for.
  private self: string | null = null;
  // The runs that found themselves taken over or superseded (see taken()), by node id: the startedAt of the run.
  private takenRuns = new Map<string, number>();
  // Whether the last look at the node's own announcement failed (logged once per run of failures).
  private checkFailed = false;

  constructor(private store: ClusterStore, private now: () => number = () => performance.now()) {}

  async announce(info: NodeInfo): Promise<void> {
    this.self = info.nodeId;
    // A run announced here by its own node is a fresh start, unless it is the run already found taken.
    if (this.takenRuns.get(info.nodeId) !== info.startedAt) this.takenRuns.delete(info.nodeId);
    this.announced.set(info.nodeId, info);
    await this.store.set(infoKey(info.nodeId), JSON.stringify(info));
    await this.store.addToSet(NODES_KEY, info.nodeId);
  }

  async beat(nodeId: string): Promise<void> {
    this.self = nodeId;
    const info = this.announced.get(nodeId);
    if (info === undefined) {
      // A beat from a node that never announced here: nothing to check, no run to name.
      const sentAt = this.now();
      await this.store.set(aliveKey(nodeId), UNKNOWN_RUN_BEAT, ALIVE_TTL_MS);
      this.lastGoodBeat.set(nodeId, sentAt);
      return;
    }
    if (this.takenRuns.get(nodeId) === info.startedAt) return;
    const sentAt = this.now();
    let stored: NodeInfo | null = null;
    let lost = false;
    try {
      stored = parse<NodeInfo>(await this.store.get(infoKey(nodeId)));
      const listed = (await this.store.members(NODES_KEY)).includes(nodeId);
      lost = !listed || !stored || stored.startedAt !== info.startedAt;
      this.checkFailed = false;
    } catch (error) {
      // Tried again on the next beat; the beat itself goes on, and its own write tells whether the store is away.
      if (!this.checkFailed) log.warn(`Cluster node ${nodeId} could not check its announcement: ${error}`);
      this.checkFailed = true;
    }
    let tombstone: boolean | null;
    try {
      tombstone = await this.tombstoned(nodeId, info.startedAt);
    } catch {
      tombstone = null;
    }
    const held = this.lastGoodBeat.has(nodeId);
    const lapsed = !this.leaseValid(nodeId);
    if (tombstone === true) return this.take(nodeId, info.startedAt, "its tombstone was found");
    if (stored && stored.startedAt > info.startedAt) return this.take(nodeId, info.startedAt, `run ${stored.startedAt} announced under its id`);
    if (lost && held && lapsed) return this.take(nodeId, info.startedAt, "it was forgotten after its lease ran out");
    if (tombstone === null) {
      // Not known whether the run was taken: the beat is written, as before, but the lease is not extended.
      await this.store.set(aliveKey(nodeId), String(info.startedAt), ALIVE_TTL_MS);
      return;
    }
    if (lost) await this.announce(info);
    await this.store.set(aliveKey(nodeId), String(info.startedAt), ALIVE_TTL_MS);
    this.lastGoodBeat.set(nodeId, sentAt);
  }

  // Latches the run as taken and ends its lease now.
  private take(nodeId: string, startedAt: number, why: string): void {
    this.lastGoodBeat.delete(nodeId);
    if (this.takenRuns.get(nodeId) === startedAt) return;
    this.takenRuns.set(nodeId, startedAt);
    log.warn(`Cluster node ${nodeId} is taken over: ${why}`);
  }

  taken(nodeId?: string): boolean {
    const id = nodeId ?? this.self;
    return id !== null && this.takenRuns.has(id);
  }

  leaseValid(nodeId?: string): boolean {
    const id = nodeId ?? this.self;
    const last = id === null ? undefined : this.lastGoodBeat.get(id);
    return last !== undefined && this.now() - last <= ALIVE_TTL_MS + LEASE_MARGIN_MS;
  }

  // Whether a tombstone names this run. One that cannot be parsed names nothing; one that cannot be read throws.
  private async tombstoned(nodeId: string, startedAt: number): Promise<boolean> {
    return parse<{ startedAt?: unknown }>(await this.store.get(tombstoneKey(nodeId)))?.startedAt === startedAt;
  }

  report(load: LoadReport): Promise<void> {
    return this.store.set(loadKey(load.nodeId), JSON.stringify(load), ALIVE_TTL_MS);
  }

  /** Announced nodes that are beating, by node id. */
  async live(): Promise<NodeInfo[]> {
    const live: NodeInfo[] = [];
    for (const nodeId of (await this.store.members(NODES_KEY)).sort()) {
      if (!(await this.store.get(aliveKey(nodeId)))) continue;
      const info = await this.info(nodeId);
      if (info) live.push(info);
    }
    return live;
  }

  /** Whether the node's beat is current, read fresh. */
  async isAlive(nodeId: string): Promise<boolean> {
    return (await this.store.get(aliveKey(nodeId))) !== null;
  }

  async isAliveAs(nodeId: string, startedAt: number): Promise<boolean> {
    const value = await this.store.get(aliveKey(nodeId));
    return value === String(startedAt) || value === UNKNOWN_RUN_BEAT;
  }

  async info(nodeId: string): Promise<NodeInfo | null> {
    return parse<NodeInfo>(await this.store.get(infoKey(nodeId)));
  }

  /** Reports of live nodes only: a dead node's last report must not count. With `region`, of that region's nodes. */
  async loads(region?: string): Promise<LoadReport[]> {
    const loads: LoadReport[] = [];
    for (const node of await this.live()) {
      if (region !== undefined && node.regionId !== region) continue;
      const load = parse<LoadReport>(await this.store.get(loadKey(node.nodeId)));
      if (load) loads.push(load);
    }
    return loads;
  }

  /** Graceful shutdown. The info stays so old tickets still route. */
  async retire(nodeId: string): Promise<void> {
    this.lastGoodBeat.delete(nodeId);
    await this.store.del(aliveKey(nodeId));
    await this.store.del(loadKey(nodeId));
  }

  /** Every node ever announced and not forgotten, live or not. */
  known(): Promise<string[]> {
    return this.store.members(NODES_KEY);
  }

  async forgetRun(nodeId: string, startedAt: number): Promise<boolean> {
    const current = parse<NodeInfo>(await this.store.get(infoKey(nodeId)));
    if (current && current.startedAt !== startedAt) return false;
    const taken = await this.store.take(infoKey(nodeId));
    const takenInfo = parse<NodeInfo>(taken);
    if (taken !== null && takenInfo && takenInfo.startedAt !== startedAt) {
      // Tried twice: a put-back that fails leaves a live new run unknown until it announces again.
      try {
        await this.store.set(infoKey(nodeId), taken);
      } catch {
        await this.store.set(infoKey(nodeId), taken);
      }
      return false;
    }
    await this.store.removeFromSet(NODES_KEY, nodeId);
    // An announce writes its info before it joins the set: an info found now is a new run, whose set entry belongs.
    if (await this.store.get(infoKey(nodeId))) {
      await this.store.addToSet(NODES_KEY, nodeId);
      return false;
    }
    await this.store.del(aliveKey(nodeId));
    await this.store.del(loadKey(nodeId));
    return true;
  }
}
