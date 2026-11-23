import { bareName } from "../systems/dungeons/copykey";
import type { ClusterStore } from "./store";

/** 30 s picking, 30 s waiting, 5 s casting, 60 s prompting, and 5 s of slack. */
export const CLAIM_TTL_MS = 130_000;

export const stoneKey = (map: string, name: string) => `${bareName(map)}/${name}`;

const stoneClaim = (stone: string) => `summon:stone:${stone}`;
const targetClaim = (target: string) => `summon:target:${target.toLowerCase()}`;

/** One summon per stone and one per target, across the cluster (in this process without a store). */
export class SummonClaims {
  private held = new Map<string, { by: string; expires: number }>();

  constructor(private store: ClusterStore | null, private now: () => number = Date.now) {}

  /** In a cluster: from now on claims are kept in the store (null: in this process again). */
  attach(store: ClusterStore | null): void {
    this.store = store;
  }

  async claim(stoneKey: string, target: string, by: string): Promise<"ok" | "stone" | "target"> {
    if (!(await this.take(stoneClaim(stoneKey), by))) return "stone";
    if (!(await this.take(targetClaim(target), by))) {
      await this.drop(stoneClaim(stoneKey), by);
      return "target";
    }
    return "ok";
  }

  /** Frees the claims `by` holds; one held by someone else stays. */
  async release(stoneKey: string, target: string, by: string): Promise<void> {
    await this.drop(stoneClaim(stoneKey), by);
    await this.drop(targetClaim(target), by);
  }

  async targetBusy(target: string): Promise<boolean> {
    return (await this.read(targetClaim(target))) !== null;
  }

  private async take(key: string, by: string): Promise<boolean> {
    if (this.store) return this.store.setIfAbsent(key, by, CLAIM_TTL_MS);
    if (this.live(key)) return false;
    this.held.set(key, { by, expires: this.now() + CLAIM_TTL_MS });
    return true;
  }

  private async read(key: string): Promise<string | null> {
    if (this.store) return this.store.get(key);
    return this.live(key)?.by ?? null;
  }

  private async drop(key: string, by: string): Promise<void> {
    if ((await this.read(key)) !== by) return;
    if (this.store) await this.store.del(key);
    else this.held.delete(key);
  }

  private live(key: string): { by: string; expires: number } | null {
    const claim = this.held.get(key);
    if (!claim) return null;
    if (this.now() > claim.expires) {
      this.held.delete(key);
      return null;
    }
    return claim;
  }
}

export const summonClaims = new SummonClaims(null);
