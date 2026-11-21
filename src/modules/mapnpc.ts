/** The sheets an NPC is drawn from, as the npcs table names them. */
const SHEETS = [
  "sprite_body", "sprite_head", "sprite_helmet", "sprite_shoulderguards", "sprite_neck",
  "sprite_hands", "sprite_chest", "sprite_feet", "sprite_legs", "sprite_weapon",
] as const;

const DIRECTIONS = ["up", "down", "left", "right", "upleft", "upright", "downleft", "downright"];

/** Placed NPCs' ids start here, going down: far below the particle emitters of the maps, which count down from -1. */
export const PLACED_NPC_BASE = 1_000_000_000;

export function placedNpcId(map: string, name: string): number {
  let hash = 0x811c9dc5;
  for (const char of `${map.replace(".json", "")}/${name}`) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return -(PLACED_NPC_BASE + (hash % PLACED_NPC_BASE));
}

/** The NPC a map object places. Null when it has no name (its id is made from it) or does not say where it stands. */
export function placedNpc(mapName: string, obj: any): Npc | null {
  const name = String(obj?.name ?? "").trim();
  const x = Math.floor(Number(obj?.x)), y = Math.floor(Number(obj?.y));
  if (!name || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const given = new Map<string, unknown>((Array.isArray(obj?.properties) ? obj.properties : []).map((p: any) => [String(p?.name ?? "").toLowerCase(), p?.value]));
  const text = (key: string): string | null => {
    const value = given.get(key);
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const sheets = Object.fromEntries(SHEETS.map((key) => [key, text(key)])) as Record<(typeof SHEETS)[number], string | null>;
  const type = text("sprite_type");
  const direction = (text("direction") || "down").toLowerCase();
  return {
    id: placedNpcId(mapName, name),
    last_updated: null,
    map: mapName.replace(".json", ""),
    name,
    position: { x, y, direction: DIRECTIONS.includes(direction) ? direction : "down" },
    hidden: given.get("hidden") === true,
    script: null,
    dialog: text("dialog"),
    gossip: text("gossip"),
    particles: "" as unknown as Particle[], // none, in the form of a database row
    quest_giver: false,
    innkeeper: given.get("innkeeper") === true,
    // with no type said, one with a sheet is drawn from it
    sprite_type: type === "none" || type === "static" || type === "animated" ? type : sheets.sprite_body || sheets.sprite_head ? "animated" : "none",
    ...sheets,
  };
}
