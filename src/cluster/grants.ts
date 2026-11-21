import { randomUUID } from "node:crypto";
import log from "../modules/logger";
import { registerPlayerAction, runOnPlayer } from "./deliver";
import type { ClusterStore } from "./store";

export const GRANT_TTL_MS = 600_000;
/** When the owner checks a parked grant, from the park: past the call timeout (10 s), so an answer that came is claimed. */
export const GRANT_RECOVER_DELAYS_MS: readonly number[] = [12_000, 30_000, 60_000];
/** How long a check that failed on the store waits to run again. */
export const GRANT_STORE_RETRY_MS = 30_000;
/** How many times the adoption of a dead run's grants is tried before it is given up. */
export const GRANT_ADOPT_TRIES = 5;
/** The most item rows one grant holds (a corpse or chest holds fewer). */
export const MAX_GRANT_ITEMS = 64;

/** The most grant ids remembered for the once-per-grant re-park warn; past it the memory starts over. */
const REPARKED_KEEP = 4096;
const MAX_COUNT = 2_147_483_647;
const MAX_ID = 128;

export const grantKey = (id: string) => `cells:grant:${id}`;
export const grantedKey = (id: string) => `cells:granted:${id}`;
/** The ids of the grants one run of a node parked and still checks. */
export const runGrantsKey = (nodeId: string, startedAt: number) => `cells:grants:${nodeId}|${startedAt}`;
/** Which node adopts a dead run's grants: the first to set it. */
export const grantAdoptKey = (nodeId: string, startedAt: number) => `cells:grant-adopt:${nodeId}|${startedAt}`;

export interface GrantItem { itemName: string; quantity: number }
export interface HandOver { username: string; items: GrantItem[]; copper: number; call: string }
export interface ParkedGrant extends HandOver {
  id: string;
  owner: string;
  at: number;
  /** The run of `owner` that parked it (its startedAt), or 0 when that run is not known: adoption takes it only from that run's list. */
  run?: number;
}
/** Writes a grant for its player: `player` is the player on this node, or null to write their rows only. Throws when it cannot. */
export type GrantWriter = (grant: ParkedGrant, player: any | null) => Promise<void>;
export interface GrantDeps {
  runOnPlayer(username: string, action: string, args: unknown): Promise<boolean>;
  now(): number;
}
export interface GrantOptions { delays?: readonly number[]; storeRetryMs?: number; ttlMs?: number }
export interface GrantAttachOptions {
  /** The run of this node (its startedAt): the grants it parks are listed under it. None: they are not listed. */
  run?: number;
  /** Whether this node may act as owner now (its lease is valid and its run not taken). Default: always. */
  mayAct?: () => boolean;
}

const lower = (value: unknown) => String(value ?? "").toLowerCase();
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT;
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_ID;

/** What a grant holds, as one line ("2 x Bone, 11 copper"). */
export function describeGrant(grant: Pick<HandOver, "items" | "copper">): string {
  const parts = grant.items.map((item) => `${item.quantity} x ${item.itemName}`);
  if (grant.copper > 0) parts.push(`${grant.copper} copper`);
  return parts.join(", ") || "nothing";
}

export function handOverOf(answer: Record<string, unknown>): { items: GrantItem[]; copper: number } {
  const rows: any[] = Array.isArray(answer.items)
    ? answer.items
    : answer.item && typeof answer.item === "object"
      ? [answer.item]
      : typeof answer.item === "string"
        ? [{ itemName: answer.item, quantity: answer.quantity }]
        : [];
  const items = rows.slice(0, MAX_GRANT_ITEMS).map((row) => ({
    itemName: String(row?.itemName ?? row?.item ?? ""),
    quantity: Math.max(1, Math.floor(Number(row?.quantity) || 1)),
  })).filter((item) => item.itemName);
  const copper = Math.max(0, Math.floor(Number(answer.copper) || 0));
  return { items, copper };
}

async function wroteNothing(error: unknown): Promise<boolean> {
  try {
    return (await import("../services/batch")).nothingWritten(error);
  } catch {
    return false;
  }
}

/** A parked grant as the store holds it, or null when it is not one. `id`: the id it was read under, which it must name. */
function grantOf(raw: string | null, id?: string): ParkedGrant | null {
  if (!raw) return null;
  let value: any;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || !isId(value.id) || typeof value.username !== "string" || !value.username || !isCount(value.copper)) return null;
  // Guard (test "a grant record read under another id is not that grant").
  if (id !== undefined && value.id !== id) return null;
  if (!Array.isArray(value.items) || value.items.length > MAX_GRANT_ITEMS) return null;
  const items: GrantItem[] = [];
  for (const item of value.items) {
    if (!item || typeof item.itemName !== "string" || !item.itemName || !isCount(item.quantity) || item.quantity < 1) return null;
    items.push({ itemName: item.itemName, quantity: item.quantity });
  }
  return {
    id: value.id, username: value.username, items, copper: value.copper, call: String(value.call ?? ""),
    owner: String(value.owner ?? ""), at: Number(value.at) || 0, run: Number.isFinite(value.run) ? value.run : 0,
  };
}

interface Pending {
  grant: ParkedGrant;
  timer: ReturnType<typeof setTimeout> | null;
  /** A take of it threw: it may have run, so a grant found gone after that may be lost, not claimed. */
  takeFailed: boolean;
}

export class Grants {
  private store: ClusterStore | null = null;
  private generation = 0;
  private self = "";
  /** The list of grants this run parked, or null when the run is not known. */
  private runKey: string | null = null;
  /** This node's run (its startedAt), written on each grant it parks; 0 when not known. */
  private run = 0;
  private mayAct: () => boolean = () => true;
  private writer: GrantWriter | null = null;
  /** The grants parked again here, whose re-park was logged at warn once (parkAgain). */
  private reparked = new Set<string>();
  /** The grants this node parked and still checks, by id: the next check's timer, and whether a take of it failed on the store. */
  private pending = new Map<string, Pending>();
  private readonly delays: readonly number[];
  private readonly storeRetryMs: number;
  private readonly ttlMs: number;

  constructor(private readonly deps: GrantDeps, opts: GrantOptions = {}) {
    this.delays = opts.delays ?? GRANT_RECOVER_DELAYS_MS;
    this.storeRetryMs = opts.storeRetryMs ?? GRANT_STORE_RETRY_MS;
    this.ttlMs = opts.ttlMs ?? GRANT_TTL_MS;
  }

  attach(store: ClusterStore, self: string, opts: GrantAttachOptions = {}): void {
    // detach counts the generation on.
    this.detach();
    this.store = store;
    this.self = self;
    this.runKey = opts.run === undefined ? null : runGrantsKey(self, opts.run);
    this.run = opts.run ?? 0;
    this.mayAct = opts.mayAct ?? (() => true);
  }

  detach(): void {
    for (const { grant, timer } of this.pending.values()) {
      if (timer) clearTimeout(timer);
      log.warn(`Hand-over ${grant.id} for ${grant.username} is no longer checked here: ${describeGrant(grant)} is given only if its asker claims it before it runs out (${this.ttlMs} ms after it was parked)`);
    }
    this.pending.clear();
    this.generation++;
    this.store = null;
    this.runKey = null;
    this.run = 0;
    this.mayAct = () => true;
  }

  attached(): boolean {
    return this.store !== null;
  }

  /** Answers the writer set before. grantwriter.ts sets the engine's when it loads. */
  setWriter(writer: GrantWriter | null): GrantWriter | null {
    const previous = this.writer;
    this.writer = writer;
    return previous;
  }

  newId(): string {
    return `${this.self || "node"}:${randomUUID()}`;
  }

  async park(handOver: HandOver, id?: string): Promise<string | null> {
    const store = this.store;
    if (!store) return null;
    if (id !== undefined && !isId(id)) {
      log.error(`${handOver.call} for ${handOver.username} (${describeGrant(handOver)}) could not be parked again: ${String(id).slice(0, MAX_ID)} is not a grant id`);
      return null;
    }
    const grant: ParkedGrant = { ...handOver, id: id ?? this.newId(), owner: this.self, at: this.deps.now(), run: this.run };
    try {
      await store.set(grantKey(grant.id), JSON.stringify(grant), this.ttlMs);
    } catch (error) {
      log.error(`${handOver.call} for ${handOver.username} (${describeGrant(handOver)}) could not be parked, so a lost answer loses it: ${error}`);
      return null;
    }
    // Every later line about this grant names only its id: this one ties the id to what it holds.
    log.info(`Hand-over ${grant.id} (${grant.call}) parked for ${grant.username}: ${describeGrant(grant)}`);
    const before = this.pending.get(grant.id);
    if (before?.timer) clearTimeout(before.timer);
    const entry: Pending = { grant, timer: null, takeFailed: false };
    this.pending.set(grant.id, entry);
    this.schedule(store, entry, 0, this.delays[0] ?? 0);
    await this.list(store, grant);
    return grant.id;
  }

  async adoptFrom(nodeId: string, startedAt: number, attempt = 1): Promise<number> {
    const store = this.store;
    const generation = this.generation;
    if (!store || !Number.isFinite(startedAt)) return 0;
    const runKey = runGrantsKey(nodeId, startedAt);
    // This run's own list is not adopted: its grants are checked here already.
    if (this.runKey === runKey) return 0;
    let adopted = 0;
    try {
      if (!this.mayAct()) throw new Error("this node does not hold its lease");
      const adoptKey = grantAdoptKey(nodeId, startedAt);
      // A try that won before and then failed finds its own name there.
      if (!(await store.setIfAbsent(adoptKey, this.self, this.ttlMs)) && (await store.get(adoptKey)) !== this.self) return 0;
      for (const id of await store.members(runKey)) {
        if (this.generation !== generation) return adopted;
        if (this.pending.has(id)) continue;
        // Gone: claimed, recovered or written already (or a record that is not sealed, which the store logged).
        const grant = grantOf(await store.get(grantKey(id)), id);
        if (!grant) continue;
        if (grant.owner !== nodeId || grant.run !== startedAt) {
          log.warn(`Hand-over ${grant.id} is listed under run ${startedAt} of node ${nodeId}, but was parked by run ${grant.run} of node ${grant.owner}: not adopted from that list`);
          continue;
        }
        const entry: Pending = { grant, timer: null, takeFailed: false };
        this.pending.set(grant.id, entry);
        this.schedule(store, entry, 0, this.delays[0] ?? 0);
        log.warn(`Hand-over ${grant.id} for ${grant.username} (${describeGrant(grant)}), parked by run ${startedAt} of node ${nodeId}, is checked here now`);
        await this.list(store, grant);
        adopted++;
      }
      await store.del(runKey);
    } catch (error) {
      if (attempt >= GRANT_ADOPT_TRIES) {
        log.error(`The hand-overs parked by run ${startedAt} of node ${nodeId} were not adopted (${error}): any not adopted yet are checked by no one, and are given only if their askers claim them before they run out`);
        return adopted;
      }
      log.warn(`The hand-overs parked by run ${startedAt} of node ${nodeId} could not be adopted (${error}): tried again in ${this.storeRetryMs} ms`);
      const timer = setTimeout(() => {
        // Guard (test "a stop and an attach again with the same store does not run an old adoption retry").
        if (this.generation === generation) void this.adoptFrom(nodeId, startedAt, attempt + 1);
      }, this.storeRetryMs);
      (timer as any).unref?.();
    }
    return adopted;
  }

  /** Lists the grant under this run, for adoption should the run end. A grant not listed is still checked here. */
  private async list(store: ClusterStore, grant: ParkedGrant): Promise<void> {
    const runKey = this.runKey;
    if (!runKey) return;
    try {
      await store.addToSet(runKey, grant.id);
      await store.expire(runKey, this.ttlMs);
    } catch (error) {
      log.warn(`Hand-over ${grant.id} for ${grant.username} (${describeGrant(grant)}) could not be listed for adoption (${error}): should this node die, it is given only if its asker claims it`);
    }
  }

  /** Takes a settled grant off this run's list. A failure leaves an id whose grant is gone, which adoption skips. */
  private unlist(store: ClusterStore, id: string): void {
    const runKey = this.runKey;
    if (!runKey) return;
    void store.removeFromSet(runKey, id).catch(() => {});
  }

  private settle(store: ClusterStore, entry: Pending): void {
    if (!this.current(entry)) return;
    this.pending.delete(entry.grant.id);
    this.unlist(store, entry.grant.id);
  }

  async claim(id: string, handed?: Pick<HandOver, "items" | "copper">): Promise<boolean> {
    const store = this.store;
    if (!store) {
      log.warn(`Hand-over ${id} could not be claimed: the cluster store is not attached, so its owner gives it later`);
      return false;
    }
    try {
      return (await store.take(grantKey(id))) !== null;
    } catch (error) {
      log.error(`Hand-over ${id} could not be claimed (${error}): ${handed ? describeGrant(handed) : "what it holds"} may be lost, if the store took it before it failed; else its owner gives it later`);
      return false;
    }
  }

  async firstApply(id: string): Promise<boolean> {
    const store = this.store;
    if (!store) return true;
    return await store.setIfAbsent(grantedKey(id), "1", this.ttlMs);
  }

  async unapply(id: string): Promise<void> {
    try {
      await this.store?.del(grantedKey(id));
    } catch (error) {
      log.error(`Money grant ${id} keeps its once-only mark after a failed write, so a second send of it is not given: ${error}`);
    }
  }

  /** cells-grant-recover, on the player's node. */
  async recoverHere(player: any, args: unknown): Promise<void> {
    const id = (args as any)?.id;
    if (!isId(id)) return;
    const grant = await this.takeGrant(id);
    if (!grant) return;
    // The bus runs an action on the player it names: one for someone else is written to that player's rows.
    await this.write(grant, lower(grant.username) === lower(player?.username) ? player : null);
  }

  private current(entry: Pending): boolean {
    return this.pending.get(entry.grant.id) === entry;
  }

  private schedule(store: ClusterStore, entry: Pending, step: number, ms: number): void {
    // Detached meanwhile (detach logged it, and the store it was parked in is no longer this node's to check), or stale.
    if (!this.current(entry) || this.store !== store) return;
    const timer = setTimeout(() => {
      entry.timer = null;
      void this.check(store, entry, step);
    }, ms);
    (timer as any).unref?.();
    entry.timer = timer;
  }

  private async check(store: ClusterStore, entry: Pending, step: number): Promise<void> {
    if (this.store !== store || !this.current(entry)) return;
    const grant = entry.grant;
    // A node that may not act as owner (its lease lapsed, or its run was taken) writes nothing: checked again later.
    if (!this.mayAct()) {
      this.retryLater(store, entry, step, "this node does not hold its lease");
      return;
    }
    let held: string | null;
    try {
      held = await store.get(grantKey(grant.id));
    } catch (error) {
      this.retryLater(store, entry, step, error);
      return;
    }
    if (held === null) {
      if (entry.takeFailed) log.error(`Hand-over ${grant.id} for ${grant.username} may be lost: ${describeGrant(grant)} (a take of it here failed on the store, and it is gone now)`);
      this.settle(store, entry);
      return;
    }
    // Still held: a take here that failed did not run, so a later "gone" is a claim, not a loss.
    entry.takeFailed = false;
    const last = step >= this.delays.length - 1;
    if (!last) {
      let sent = false;
      try {
        sent = await this.deps.runOnPlayer(grant.username, "cells-grant-recover", { id: grant.id });
      } catch (error) {
        log.error(`Hand-over ${grant.id} for ${grant.username}: the recover action could not be sent: ${error}`);
      }
      if (sent) {
        this.schedule(store, entry, step + 1, this.delays[step + 1]! - this.delays[step]!);
        return;
      }
    }
    // The player is on no node, or the action did not take it: written to the rows from here.
    let taken: string | null;
    try {
      taken = await store.take(grantKey(grant.id));
    } catch (error) {
      entry.takeFailed = true;
      this.retryLater(store, entry, step, error);
      return;
    }
    this.settle(store, entry);
    const parked = grantOf(taken, grant.id);
    if (!parked) {
      // Taken by someone else between the read and the take (nothing to do), or a value that is not a grant.
      if (taken !== null) log.error(`Hand-over ${grant.id} for ${grant.username} is lost: ${describeGrant(grant)} (the store held a value that is not a grant)`);
      return;
    }
    log.warn(`Hand-over ${parked.id} for ${parked.username} (${describeGrant(parked)}) was not claimed: it is written to their rows from here`);
    await this.write(parked, null);
  }

  private retryLater(store: ClusterStore, entry: Pending, step: number, error: unknown): void {
    const grant = entry.grant;
    // Stale (a re-park under the same id replaced it): the newer entry has its own checks.
    if (!this.current(entry)) return;
    if (this.deps.now() + this.storeRetryMs - grant.at < this.ttlMs) {
      log.warn(`Hand-over ${grant.id} for ${grant.username} could not be checked (${error}): checked again in ${this.storeRetryMs} ms`);
      this.schedule(store, entry, step, this.storeRetryMs);
      return;
    }
    this.pending.delete(grant.id);
    log.error(`Hand-over ${grant.id} for ${grant.username} is lost: ${describeGrant(grant)} (the store failed until it ran out: ${error})`);
  }

  private async takeGrant(id: string): Promise<ParkedGrant | null> {
    const store = this.store;
    if (!store) return null;
    let taken: string | null;
    try {
      taken = await store.take(grantKey(id));
    } catch (error) {
      // Its park line on the owner names what it holds.
      log.error(`Hand-over ${id} could not be taken (${error}): it may be lost, if the store took it before it failed; else its owner's next check has it`);
      return null;
    }
    const grant = grantOf(taken, id);
    if (!grant && taken !== null) log.error(`Hand-over ${id} is lost: the store held a value that is not a grant`);
    return grant;
  }

  private async write(grant: ParkedGrant, player: any | null): Promise<void> {
    const writer = this.writer;
    if (!writer) {
      log.error(`Hand-over ${grant.id} for ${grant.username} is lost: ${describeGrant(grant)}: no grant writer is set`);
      return;
    }
    try {
      await writer(grant, player);
    } catch (error) {
      if (await wroteNothing(error) && await this.parkAgain(grant, error)) return;
      log.error(`Hand-over ${grant.id} for ${grant.username} is lost: ${describeGrant(grant)}: ${error}`);
    }
  }

  private async parkAgain(grant: ParkedGrant, error: unknown): Promise<boolean> {
    // Guard (test "a re-parked hand-over keeps its id: a rolled-back copy of it and the re-park are written once").
    const id = await this.park({ username: grant.username, items: grant.items, copper: grant.copper, call: grant.call }, grant.id);
    if (!id) return false;
    // Guard (test "a re-park of the same hand-over warns once, then logs at info").
    const first = !this.reparked.has(id);
    if (first) {
      if (this.reparked.size >= REPARKED_KEEP) this.reparked.clear();
      this.reparked.add(id);
    }
    (first ? log.warn : log.info)(`Hand-over ${grant.id} for ${grant.username} could not be written (${error}): nothing was written, so it is parked again as hand-over ${id}`);
    return true;
  }
}

/** The node's grants. Nothing is parked until startCluster attaches the store (Task 21). */
export const grants = new Grants({ runOnPlayer, now: Date.now });

registerPlayerAction(
  "cells-grant-recover",
  (player, args) => grants.recoverHere(player, args),
  (args) => `hand-over ${String(args?.id).slice(0, MAX_ID)} stays parked for its owner's next check`,
);
