export interface CorpseItem {
  index: number;
  itemName: string;
  quantity: number;
  quality: string;
  iconUrl: string;
}

export interface CorpseLoot {
  creatureId: number;
  items: CorpseItem[];
  taken: Set<number>;
  copper: number;
  /** Usernames (lowercase) allowed to take items. */
  owners: Set<string>;
  /** Usernames (lowercase) that receive a share of the money. */
  moneyShare: string[];
  /** Personal loot (inside a dungeon copy): one record per member, keyed by lowercase username. `items`/`copper` are unused then. */
  personal?: Map<string, PersonalRecord>;
}

export interface PersonalRecord {
  items: CorpseItem[];
  taken: Set<number>;
  copper: number;
}

export interface LootTakeResult {
  taken: CorpseItem[];
  /** username -> copper awarded */
  copper: Map<string, number>;
  empty: boolean;
  /** Set when the take was from a personal record: whose. */
  personalOf?: string;
}

function recordEmpty(r: PersonalRecord): boolean {
  return r.copper <= 0 && r.items.every((i) => r.taken.has(i.index));
}

/** Split copper evenly; the looter receives any remainder. */
export function splitCopper(total: number, recipients: string[], looter: string): Map<string, number> {
  const out = new Map<string, number>();
  if (total <= 0) return out;
  const people = recipients.length > 0 ? recipients : [looter];
  const each = Math.floor(total / people.length);
  let remainder = total - each * people.length;
  for (const name of people) out.set(name, each);
  if (remainder > 0) {
    const key = people.includes(looter) ? looter : people[0];
    out.set(key, (out.get(key) ?? 0) + remainder);
    remainder = 0;
  }
  for (const [k, v] of out) if (v <= 0) out.delete(k);
  return out;
}

export class CorpseLootStore {
  private corpses = new Map<number, CorpseLoot>();
  /** party key -> round-robin cursor */
  private rotation = new Map<string, number>();

  pickOwner(groupKey: string | null, eligible: string[]): string | null {
    if (eligible.length === 0) return null;
    if (!groupKey || eligible.length === 1) return eligible[0];
    const sorted = [...eligible].sort();
    const cursor = this.rotation.get(groupKey) ?? 0;
    this.rotation.set(groupKey, cursor + 1);
    return sorted[cursor % sorted.length];
  }

  create(creatureId: number, items: CorpseItem[], copper: number, owners: string[], moneyShare: string[]): CorpseLoot | null {
    if (items.length === 0 && copper <= 0) return null;
    const loot: CorpseLoot = {
      creatureId,
      items,
      taken: new Set(),
      copper: Math.max(0, Math.floor(copper)),
      owners: new Set(owners.map((o) => o.toLowerCase())),
      moneyShare: moneyShare.map((m) => m.toLowerCase()),
    };
    this.corpses.set(creatureId, loot);
    return loot;
  }

  get(creatureId: number): CorpseLoot | undefined {
    return this.corpses.get(creatureId);
  }

  has(creatureId: number): boolean {
    return this.corpses.has(creatureId);
  }

  /** A corpse where each member has their own loot. Null when every record is empty. */
  createPersonal(creatureId: number, perUser: Map<string, { items: CorpseItem[]; copper: number }>): CorpseLoot | null {
    const personal = new Map<string, PersonalRecord>();
    for (const [name, rec] of perUser) {
      personal.set(name.toLowerCase(), { items: rec.items, taken: new Set(), copper: Math.max(0, Math.floor(rec.copper)) });
    }
    if ([...personal.values()].every(recordEmpty)) return null;
    const loot: CorpseLoot = { creatureId, items: [], taken: new Set(), copper: 0, owners: new Set(personal.keys()), moneyShare: [], personal };
    this.corpses.set(creatureId, loot);
    return loot;
  }

  canLoot(creatureId: number, username: string): boolean {
    const loot = this.corpses.get(creatureId);
    if (!loot) return false;
    const who = username.toLowerCase();
    if (loot.personal) {
      const rec = loot.personal.get(who);
      return !!rec && !recordEmpty(rec);
    }
    return loot.owners.has(who);
  }

  /** Items still on the corpse (the caller's own record when the corpse is personal). */
  remaining(creatureId: number, username?: string): CorpseItem[] {
    const loot = this.corpses.get(creatureId);
    if (!loot) return [];
    if (loot.personal) {
      const rec = username ? loot.personal.get(username.toLowerCase()) : undefined;
      return rec ? rec.items.filter((i) => !rec.taken.has(i.index)) : [];
    }
    return loot.items.filter((i) => !loot.taken.has(i.index));
  }

  /** Money on the corpse the caller can take (their own record when personal). */
  copperOf(creatureId: number, username: string): number {
    const loot = this.corpses.get(creatureId);
    if (!loot) return 0;
    if (loot.personal) return loot.personal.get(username.toLowerCase())?.copper ?? 0;
    return loot.copper;
  }

  private takePersonal(loot: CorpseLoot, looter: string, indices: number[] | null): LootTakeResult | null {
    const rec = loot.personal!.get(looter);
    if (!rec || recordEmpty(rec)) return null;
    const taken: CorpseItem[] = [];
    for (const item of rec.items) {
      if (rec.taken.has(item.index)) continue;
      if (indices && !indices.includes(item.index)) continue;
      rec.taken.add(item.index);
      taken.push(item);
    }
    const copper = new Map<string, number>();
    if (rec.copper > 0) copper.set(looter, rec.copper);
    rec.copper = 0;
    const empty = [...loot.personal!.values()].every(recordEmpty);
    if (empty) this.corpses.delete(loot.creatureId);
    return { taken, copper, empty, personalOf: looter };
  }

  /** Take specific item indices (or all when null) plus any money. */
  take(creatureId: number, username: string, indices: number[] | null): LootTakeResult | null {
    const loot = this.corpses.get(creatureId);
    const looter = username.toLowerCase();
    if (!loot || !loot.owners.has(looter)) return null;
    if (loot.personal) return this.takePersonal(loot, looter, indices);

    const taken: CorpseItem[] = [];
    for (const item of loot.items) {
      if (loot.taken.has(item.index)) continue;
      if (indices && !indices.includes(item.index)) continue;
      loot.taken.add(item.index);
      taken.push(item);
    }
    const copper = splitCopper(loot.copper, loot.moneyShare, looter);
    loot.copper = 0;

    const empty = loot.items.every((i) => loot.taken.has(i.index));
    if (empty) this.corpses.delete(creatureId);
    return { taken, copper, empty };
  }

  /** Put back what a take took, on the corpse it was taken from: its writes were not kept. */
  restore(loot: CorpseLoot, result: LootTakeResult): void {
    if (loot.personal && result.personalOf) {
      const rec = loot.personal.get(result.personalOf);
      if (rec) {
        for (const item of result.taken) rec.taken.delete(item.index);
        for (const share of result.copper.values()) rec.copper += share;
      }
      this.corpses.set(loot.creatureId, loot);
      return;
    }
    for (const item of result.taken) loot.taken.delete(item.index);
    for (const share of result.copper.values()) loot.copper += share;
    this.corpses.set(loot.creatureId, loot);
  }

  remove(creatureId: number): void {
    this.corpses.delete(creatureId);
  }
}
