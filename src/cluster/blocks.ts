import AOI_CONFIG from "../config/aoi.json";
import log from "../modules/logger";
import type { ClusterBus } from "./bus";
import type { ClusterStore } from "./store";

// Read with a fallback: aoi.json is generated, so an older file may not have the key yet.
export const BLOCK_SIZE_PX: number = (AOI_CONFIG as { BLOCK_SIZE_PX?: number }).BLOCK_SIZE_PX ?? 4096;

export interface BlockOwner {
  nodeId: string;
  epoch: number;
  since: number;
}

export interface MapBlocks {
  epoch: number;
  owners: Record<string, BlockOwner>;
}

export const blockKey = (bx: number, by: number) => `${bx},${by}`;

/** A map's size in blocks (a MapExtent has it). */
export interface BlockExtent {
  blocksX: number;
  blocksY: number;
}

export function blockAt(x: number, y: number, extent?: BlockExtent): { bx: number; by: number } {
  const block = (px: number, count: number | undefined) => {
    const at = Number.isFinite(px) ? Math.max(0, Math.floor(px / BLOCK_SIZE_PX)) : 0;
    return count && count > 0 ? Math.min(at, count - 1) : at;
  };
  return { bx: block(x, extent?.blocksX), by: block(y, extent?.blocksY) };
}

/** What the store holds for a map: "corrupt" is a value that is not a table (bad JSON, or JSON of the wrong shape). */
export type StoredBlocks = { state: "absent" } | { state: "corrupt" } | { state: "ok"; table: MapBlocks };

const BARE_CAP = 256;
const bareMemo = new Map<string, string>();
/** How many names the bare memo holds (for the tests: it is capped at BARE_CAP). */
export const bareMemoSize = (): number => bareMemo.size;
const bare = (map: string): string => {
  if (!map.endsWith(".json")) return map;
  let name = bareMemo.get(map);
  if (name === undefined) {
    name = map.slice(0, -5);
    if (bareMemo.size >= BARE_CAP) bareMemo.clear();
    bareMemo.set(map, name);
  }
  return name;
};
/** A map's block table key. The one helper for it: the sealed store (storeseal.ts) and the coordinator use it too. */
export const blockTableKey = (map: string) => `cells:blocks:${bare(map)}`;
/** A map's epoch counter (nextEpoch). Not sealed: a number, read and raised by INCRBY. */
export const blockEpochKey = (map: string) => `cells:blocksepoch:${bare(map)}`;
const tableKey = blockTableKey;
const epochKey = blockEpochKey;
/** What ownersOf returns for a map not loaded: one shared object, so a caller that compares tables by identity sees no change. */
const NO_OWNERS: Readonly<Record<string, BlockOwner>> = Object.freeze({});
const empty = (): MapBlocks => ({ epoch: 0, owners: {} });

function parseTable(raw: string): MapBlocks | null {
  try {
    const table = JSON.parse(raw);
    if (typeof table?.epoch !== "number") return null;
    const owners = table.owners;
    if (typeof owners !== "object" || owners === null || Array.isArray(owners)) return null;
    for (const owner of Object.values(owners)) {
      if (typeof owner !== "object" || owner === null || typeof (owner as BlockOwner).nodeId !== "string") return null;
    }
    return table as MapBlocks;
  } catch {
    return null;
  }
}

export class BlockTable {
  private cache = new Map<string, MapBlocks>();
  private extents = new Map<string, BlockExtent>();
  private bus: ClusterBus | null = null;
  private listeners = new Set<(map: string) => void>();
  /** The maps with a read of their table under way, and how many reads. */
  private reading = new Map<string, number>();
  /** Maps forgotten while a read of their table was under way: that read is not kept. */
  private forgottenWhileRead = new Set<string>();

  constructor(private store: ClusterStore) {}

  /** The maps' sizes in blocks: `ownerOf` then puts a position on or past a map's far edge in its edge block. */
  useExtents(extents: Array<BlockExtent & { name: string }>): void {
    for (const extent of extents) this.extents.set(bare(extent.name), { blocksX: extent.blocksX, blocksY: extent.blocksY });
  }

  /** Drops a closed map from the cache and the extents; no listener is told. */
  forget(map: string): void {
    const name = bare(map);
    this.cache.delete(name);
    this.extents.delete(name);
    if (this.reading.has(name)) this.forgottenWhileRead.add(name);
  }

  onChange(listener: (map: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  attach(bus: ClusterBus): void {
    this.bus = bus;
    bus.on("blocks-changed", async (data: { map?: string }) => {
      // A map with no table that is not held here is one closed here (a late message) or never opened: nothing is kept for it.
      if (data?.map) await this.reload(bare(data.map), true);
    });
  }

  async load(map: string): Promise<MapBlocks> {
    const name = bare(map);
    return this.cache.get(name) ?? (await this.reload(name));
  }

  /** The block a position is in, clamped to the map's extent once `useExtents` has given it. */
  blockOf(map: string, x: number, y: number): { bx: number; by: number } {
    return blockAt(x, y, this.extents.get(bare(map)));
  }

  /** From the cache only; null for an unloaded map or an unowned block. */
  ownerOf(map: string, x: number, y: number): BlockOwner | null {
    const { bx, by } = this.blockOf(map, x, y);
    return this.cache.get(bare(map))?.owners[blockKey(bx, by)] ?? null;
  }

  /** The owners of a map's blocks as cached, {} when the map is not known (sync; for mirror and link decisions). */
  ownersOf(map: string): Readonly<Record<string, BlockOwner>> {
    return this.cache.get(bare(map))?.owners ?? NO_OWNERS;
  }

  /** The map's size in blocks if `useExtents` was given it. */
  extentOf(map: string): BlockExtent | undefined {
    return this.extents.get(bare(map));
  }

  /** The cached table's epoch, 0 when the map is not cached. */
  epochOf(map: string): number {
    return this.cache.get(bare(map))?.epoch ?? 0;
  }

  /** The maps whose tables are cached. */
  maps(): string[] {
    return [...this.cache.keys()];
  }

  ownedBy(nodeId: string, map: string): string[] {
    const owners = this.cache.get(bare(map))?.owners ?? {};
    return Object.keys(owners).filter((key) => owners[key]?.nodeId === nodeId);
  }

  /** Coordinator only. */
  async write(map: string, table: MapBlocks): Promise<void> {
    const name = bare(map);
    await this.store.set(tableKey(name), JSON.stringify(table));
    // A copy: the caller may go on changing its object.
    this.keep(name, structuredClone(table));
    // The sender gets the message too (toWorld); the reload is cheap and harmless.
    await this.bus?.toWorld("blocks-changed", { map: name });
  }

  async writeIfEpoch(map: string, expectedEpoch: number, table: MapBlocks): Promise<boolean> {
    const name = bare(map);
    if (!(await this.store.swapIfEpoch(tableKey(name), expectedEpoch, JSON.stringify(table)))) return false;
    this.keep(name, structuredClone(table));
    await this.bus?.toWorld("blocks-changed", { map: name });
    return true;
  }

  async nextEpoch(map: string, current: number): Promise<number> {
    const key = epochKey(bare(map));
    const epoch = await this.store.incrBy(key, 1);
    return epoch > current ? epoch : await this.store.incrBy(key, current + 1 - epoch);
  }

  async epochCounter(map: string): Promise<number | null> {
    const raw = await this.store.get(epochKey(bare(map)));
    return raw === null ? null : Number(raw);
  }

  async preload(maps: string[]): Promise<void> {
    for (const map of maps) await this.load(map);
  }

  async refresh(maps?: string[]): Promise<void> {
    await Promise.all((maps ?? [...this.cache.keys()]).map((map) => this.reload(bare(map))));
  }

  /** The stored table, read fresh, telling an absent table from one that cannot be read. Leaves the cache alone. */
  async readStored(map: string): Promise<StoredBlocks> {
    const raw = await this.store.get(tableKey(bare(map)));
    if (raw === null) return { state: "absent" };
    const table = parseTable(raw);
    return table ? { state: "ok", table } : { state: "corrupt" };
  }

  private async reload(name: string, onlyTables = false): Promise<MapBlocks> {
    this.reading.set(name, (this.reading.get(name) ?? 0) + 1);
    let raw: string | null;
    let forgotten: boolean;
    try {
      raw = await this.store.get(tableKey(name));
    } finally {
      forgotten = this.forgottenWhileRead.has(name);
      const left = (this.reading.get(name) ?? 1) - 1;
      if (left > 0) {
        this.reading.set(name, left);
      } else {
        this.reading.delete(name);
        this.forgottenWhileRead.delete(name);
      }
    }
    const table = (raw ? parseTable(raw) : null) ?? empty();
    if (forgotten || (onlyTables && raw === null && !this.cache.has(name))) return table;
    const cached = this.cache.get(name);
    if (cached && cached.epoch > table.epoch) return cached;
    this.keep(name, table);
    return table;
  }

  private keep(name: string, table: MapBlocks): void {
    const before = this.cache.get(name)?.epoch ?? 0;
    this.cache.set(name, table);
    if (table.epoch === before) return;
    for (const listener of this.listeners) {
      try {
        listener(name);
      } catch (error) {
        log.error(`A block table listener failed for map ${name}: ${error}`);
      }
    }
  }
}
