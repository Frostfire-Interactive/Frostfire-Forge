import log from "../modules/logger";
import type { ClusterStore } from "./store";

export const LAYER_POOL = 4;
const seqKey = (map: string) => `cells:layerseq:${map}`;
const bare = (map: string) => map.replace(/\.json$/, "");

export class LayerNumbers {
  private pools = new Map<string, number[]>();
  private fetching = new Set<string>();

  constructor(private store: ClusterStore, private poolSize = LAYER_POOL) {}

  /** Reserves numbers for every map before the first player arrives. */
  async prefill(maps: string[]): Promise<void> {
    await Promise.all(maps.map((map) => this.refill(bare(map))));
  }

  /** A reserved number for a new layer of the map, or null when none is ready yet. */
  take(map: string): number | null {
    const name = bare(map);
    const pool = this.pools.get(name);
    const number = pool?.shift() ?? null;
    // Refilled at half: a burst of new layers has the other half to use while Redis answers.
    if (!pool || pool.length <= this.poolSize / 2) void this.refill(name);
    return number;
  }

  private async refill(name: string): Promise<void> {
    if (this.fetching.has(name)) return;
    let pool = this.pools.get(name);
    if (!pool) this.pools.set(name, (pool = []));
    const wanted = this.poolSize - pool.length;
    if (wanted <= 0) return;
    this.fetching.add(name);
    try {
      const last = await this.store.incrBy(seqKey(name), wanted);
      for (let taken = last - wanted + 1; taken <= last; taken++) pool.push(taken + 1);
    } catch (error) {
      log.error(`Could not reserve layer numbers for map ${name}: ${error}`);
    } finally {
      this.fetching.delete(name);
    }
  }
}
