import log from "../modules/logger";
import type { ClusterStore } from "./store";

export interface DirectoryEntry {
  nodeId: string;
  playerId: string;
  epoch: number;
  map: string;
}

const entryKey = (username: string) => `cells:dir:${username.toLowerCase()}`;
const nodeKey = (nodeId: string) => `cells:dirnode:${nodeId}`;
const epochKey = (username: string) => `cells:direpoch:${username.toLowerCase()}`;

/** The most set members one repair pass checks, and how many it reads at once. */
export const REPAIR_BATCH = 200;
/** The most names `owed` keeps; the oldest goes first (the repair covers what it forgets). */
const OWED_MAX = 1000;
const REPAIR_PARALLEL = 20;

export class PlayerDirectory {
  private owed = new Map<string, Set<string>>();
  private repairFrom = 0;

  constructor(private store: ClusterStore, readonly nodeId: string) {}

  async get(username: string): Promise<DirectoryEntry | null> {
    const raw = await this.store.get(entryKey(username));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as DirectoryEntry;
    } catch {
      return null;
    }
  }

  async claim(
    username: string, playerId: string, map: string, onSwap?: (previous: DirectoryEntry | null) => void,
  ): Promise<{ entry: DirectoryEntry; previous: DirectoryEntry | null }> {
    const name = username.toLowerCase();
    for (let attempt = 0; attempt < 5; attempt++) {
      const previous = await this.get(name);
      const epoch = await this.store.incrBy(epochKey(name), 1);
      const entry: DirectoryEntry = { nodeId: this.nodeId, playerId, epoch, map };
      if (!(await this.store.swapIfEpoch(entryKey(name), previous?.epoch ?? 0, JSON.stringify(entry)))) continue;
      onSwap?.(previous);
      if (previous && previous.nodeId !== this.nodeId) {
        const owes = this.owed.get(name) ?? new Set<string>();
        owes.add(previous.nodeId);
        this.owed.delete(name);
        this.owed.set(name, owes);
        if (this.owed.size > OWED_MAX) this.owed.delete(this.owed.keys().next().value as string);
      }
      for (const other of [...(this.owed.get(name) ?? [])]) {
        if ((await this.get(name))?.nodeId !== other) await this.dropName(other, name);
        this.owed.get(name)?.delete(other);
      }
      this.owed.delete(name);
      await this.store.addToSet(nodeKey(this.nodeId), name);
      return { entry, previous };
    }
    throw new Error(`The directory entry for ${name} kept changing`);
  }

  /** At logout: only the claim with this epoch is removed. Whether it was. */
  async release(username: string, epoch: number): Promise<boolean> {
    const name = username.toLowerCase();
    this.owed.delete(name);
    if (!(await this.store.deleteIfEpoch(entryKey(name), epoch))) {
      if ((await this.get(name))?.nodeId !== this.nodeId) await this.dropName(this.nodeId, name);
      return false;
    }
    if ((await this.get(name))?.nodeId !== this.nodeId) await this.dropName(this.nodeId, name);
    return true;
  }

  async lift(username: string, floor: number, entry: DirectoryEntry): Promise<number | null> {
    const name = username.toLowerCase();
    let epoch = await this.store.incrBy(epochKey(name), 1);
    if (epoch <= floor) epoch = await this.store.incrBy(epochKey(name), floor - epoch + 1);
    const lifted: DirectoryEntry = { ...entry, epoch };
    return (await this.store.swapIfEpoch(entryKey(name), entry.epoch, JSON.stringify(lifted))) ? epoch : null;
  }

  async sweepNode(nodeId: string, stillDead?: () => Promise<boolean>): Promise<number> {
    if (stillDead) return this.sweepDeadRun(nodeId, stillDead);
    let removed = 0;
    for (const name of await this.playersOn(nodeId)) {
      const entry = await this.get(name);
      if (entry?.nodeId === nodeId && (await this.store.deleteIfEpoch(entryKey(name), entry.epoch))) removed++;
      await this.store.removeFromSet(nodeKey(nodeId), name);
    }
    return removed;
  }

  private async sweepDeadRun(nodeId: string, stillDead: () => Promise<boolean>): Promise<number> {
    const held: Array<[string, number]> = [];
    const leftover: string[] = [];
    for (const name of await this.playersOn(nodeId)) {
      const entry = await this.get(name);
      if (entry?.nodeId === nodeId) held.push([name, entry.epoch]);
      else leftover.push(name);
    }
    for (const name of leftover) await this.dropName(nodeId, name);
    if (held.length === 0 || !(await stillDead())) return 0;
    let removed = 0;
    for (const [name, epoch] of held) {
      if (!(await this.store.deleteIfEpoch(entryKey(name), epoch))) continue;
      removed++;
      await this.dropName(nodeId, name);
    }
    return removed;
  }

  private async dropName(nodeId: string, name: string): Promise<void> {
    await this.store.removeFromSet(nodeKey(nodeId), name);
    if ((await this.get(name))?.nodeId === nodeId) await this.store.addToSet(nodeKey(nodeId), name);
  }

  async repairIndex(): Promise<number> {
    const names = (await this.playersOn(this.nodeId)).sort();
    if (names.length === 0) { this.repairFrom = 0; return 0; }
    if (this.repairFrom >= names.length) this.repairFrom = 0;
    const batch = names.slice(this.repairFrom, this.repairFrom + REPAIR_BATCH);
    this.repairFrom = batch.length < REPAIR_BATCH ? 0 : this.repairFrom + REPAIR_BATCH;
    let dropped = 0;
    for (let i = 0; i < batch.length; i += REPAIR_PARALLEL) {
      const part = batch.slice(i, i + REPAIR_PARALLEL);
      const entries = await Promise.all(part.map((name) => this.get(name)));
      for (let j = 0; j < part.length; j++) {
        if (entries[j]?.nodeId === this.nodeId) continue;
        // dropName reads the entry again and keeps a claim made since.
        await this.dropName(this.nodeId, part[j]);
        if ((await this.get(part[j]))?.nodeId === this.nodeId) continue;
        dropped++;
        log.info(`Directory set of ${this.nodeId} dropped ${part[j]}: its entry ${entries[j] ? `names ${entries[j]!.nodeId}` : "is missing"}`);
      }
    }
    return dropped;
  }

  /** The usernames a node holds: for clearing up after a node dies. */
  playersOn(nodeId: string): Promise<string[]> {
    return this.store.members(nodeKey(nodeId));
  }
}
