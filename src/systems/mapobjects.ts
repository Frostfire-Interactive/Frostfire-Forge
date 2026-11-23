import { PORTAL_KINDS, type DungeonPortalObject, type MapChestObject, type PortalKind, type PortalLink, type PortalSpot } from "./dungeons/types";

export const CHEST_RESET_DEFAULT_MIN = 30;
export const MAP_OBJECT_LIMIT = 200;
const RESET_MAX_MIN = 1440;

const propsOf = (obj: any): Map<string, unknown> =>
  new Map((Array.isArray(obj?.properties) ? obj.properties : []).map((p: any) => [p?.name, p?.value]));

const wholeFrom = (value: unknown, min: number, max = Infinity): number | null => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : null;
};

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const layerOf = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * A chest's reset_minutes as a whole number of 1 to 1440 minutes: rounded and brought into that range, or the default
 * when it is missing or no number. `warn` is told of a value that was changed.
 */
function resetMinutesFrom(value: unknown, label: string, warn?: (message: string) => void): number {
  if (value === undefined || value === null) return CHEST_RESET_DEFAULT_MIN;
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    warn?.(`${label}: reset_minutes ${JSON.stringify(value)} is no number, so it is ${CHEST_RESET_DEFAULT_MIN}`);
    return CHEST_RESET_DEFAULT_MIN;
  }
  const minutes = Math.min(RESET_MAX_MIN, Math.max(1, Math.round(n)));
  if (minutes !== n) warn?.(`${label}: reset_minutes ${n} is not a whole number of 1 to ${RESET_MAX_MIN}, so it is ${minutes}`);
  return minutes;
}

/** A Tiled `chest` object: property loot_table (whole number, 1 or more) and reset_minutes (1 to 1440, default 30). */
export function readChestObject(obj: any, layer: string | null, warn?: (message: string) => void): MapChestObject | null {
  const props = propsOf(obj);
  const lootTableId = wholeFrom(props.get("loot_table"), 1);
  if (lootTableId === null || !finite(obj?.x) || !finite(obj?.y)) return null;
  const resetMinutes = resetMinutesFrom(props.get("reset_minutes"), String(obj.name ?? "") || "a chest", warn);
  return { name: String(obj.name ?? ""), lootTableId, resetMinutes, position: { x: Math.floor(obj.x), y: Math.floor(obj.y) }, layer };
}

/** Mirror other side is on unless it says false. */
const mirrorFrom = (v: unknown): boolean => !(v === false || v === "false" || v === 0);
const kindFrom = (v: unknown): PortalKind => (v === "teleport" ? "teleport" : "dungeon");
const spotFrom = (map: unknown, x: unknown, y: unknown): PortalSpot | null => {
  const nx = typeof x === "string" && x.trim() !== "" ? Number(x) : x, ny = typeof y === "string" && y.trim() !== "" ? Number(y) : y;
  if (typeof map !== "string" || !map.trim() || !finite(nx) || !finite(ny) || nx < 0 || ny < 0) return null;
  return { map: map.trim(), x: Math.floor(nx), y: Math.floor(ny) };
};
/** A return portal's source: a map (bare name) and a portal name, both given. */
const linkFrom = (map: unknown, name: unknown): PortalLink | null => {
  if (typeof map !== "string" || typeof name !== "string") return null;
  const m = map.trim().replace(/\.json$/, ""), n = name.trim();
  return m && n ? { map: m, name: n } : null;
};

/**
 * A portal as kept: kind dungeon (with its dungeon, or none) or teleport (with its target), and Mirror other side. An
 * old portal without kind or mirror is a dungeon portal that mirrors. A return portal (a teleport's way back, or a
 * dungeon's exit on its map) names its source in returnOf. Null when it has no place or size.
 */
export function portalFrom(raw: any): DungeonPortalObject | null {
  if (!raw || typeof raw !== "object" || !finite(raw.position?.x) || !finite(raw.position?.y)) return null;
  if (!finite(raw.size?.width) || !finite(raw.size?.height) || raw.size.width < 1 || raw.size.height < 1) return null;
  const kind = kindFrom(raw.kind);
  const returnOf = linkFrom(raw.returnOf?.map, raw.returnOf?.name);
  return {
    name: typeof raw.name === "string" ? raw.name : String(raw.name ?? ""), kind,
    dungeonId: kind === "dungeon" ? wholeFrom(raw.dungeonId, 1) : null,
    mirror: mirrorFrom(raw.mirror),
    target: kind === "teleport" ? spotFrom(raw.target?.map, raw.target?.x, raw.target?.y) : null,
    position: { x: raw.position.x, y: raw.position.y }, size: { width: raw.size.width, height: raw.size.height }, layer: layerOf(raw.layer),
    ...(returnOf ? { returnOf } : {}),
  };
}

/** A map's portal list as kept, whatever was stored. */
export function portalsFrom(raw: unknown): DungeonPortalObject[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
  return list.map(portalFrom).filter((p): p is DungeonPortalObject => p !== null);
}

/** A portal's Tiled properties, as readPortalObject reads them back. */
export function portalTiledProperties(p: DungeonPortalObject): Array<{ name: string; type: string; value: unknown }> {
  const props: Array<{ name: string; type: string; value: unknown }> = [
    { name: "kind", type: "string", value: p.kind },
    { name: "mirror", type: "bool", value: p.mirror },
  ];
  if (p.kind === "dungeon" && p.dungeonId !== null) props.unshift({ name: "dungeon", type: "int", value: p.dungeonId });
  if (p.kind === "teleport" && p.target) {
    props.push({ name: "map", type: "string", value: p.target.map }, { name: "x", type: "int", value: p.target.x }, { name: "y", type: "int", value: p.target.y });
  }
  if (p.returnOf) {
    props.push({ name: "return_of_map", type: "string", value: p.returnOf.map }, { name: "return_of", type: "string", value: p.returnOf.name });
  }
  return props;
}

/**
 * A Tiled `dungeon_portal` object: properties dungeon (whole number, 1 or more), kind, mirror, a teleport's map, x and
 * y, and a return portal's return_of_map and return_of (its source).
 */
export function readPortalObject(obj: any, layer: string | null): DungeonPortalObject | null {
  if (!finite(obj?.x) || !finite(obj?.y) || !finite(obj?.width) || !finite(obj?.height)) return null;
  const width = Math.floor(obj.width), height = Math.floor(obj.height);
  if (width < 1 || height < 1) return null;
  const props = propsOf(obj);
  return portalFrom({
    name: String(obj.name ?? ""), kind: props.get("kind"), dungeonId: props.get("dungeon"), mirror: props.get("mirror"),
    target: { map: props.get("map"), x: props.get("x"), y: props.get("y") },
    returnOf: { map: props.get("return_of_map"), name: props.get("return_of") },
    position: { x: Math.floor(obj.x), y: Math.floor(obj.y) }, size: { width, height }, layer,
  });
}

/** A summoning stone: its position is its foot (x the middle, y the ground line), glowing in glowColor (#rrggbb). */
export interface SummoningStoneObject { name: string; position: { x: number; y: number }; glowColor: string; layer: string | null }

/** The glow of a stone given none, or none that can be read. */
export const DEFAULT_GLOW = "#66ccff";

/** A glow colour as kept: a #rrggbb colour in lower case, else null. */
export function glowColorOf(v: unknown): string | null {
  return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim().toLowerCase() : null;
}

/** A stone as kept, with DEFAULT_GLOW for a missing or bad colour. Null when it has no place. */
function stoneFrom(raw: any): SummoningStoneObject | null {
  if (!raw || typeof raw !== "object" || !finite(raw.position?.x) || !finite(raw.position?.y)) return null;
  return {
    name: typeof raw.name === "string" ? raw.name : String(raw.name ?? ""),
    position: { x: raw.position.x, y: raw.position.y },
    glowColor: glowColorOf(raw.glowColor) ?? DEFAULT_GLOW,
    layer: layerOf(raw.layer),
  };
}

/** A map's summoning stone list as kept, whatever was stored: a list, or one keyed by name. */
export function stonesFrom(raw: unknown): SummoningStoneObject[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object"
    ? Object.entries(raw).map(([name, s]) => (s && typeof s === "object" && (s as any).name === undefined ? { ...s, name } : s))
    : [];
  return list.map(stoneFrom).filter((s): s is SummoningStoneObject => s !== null);
}

/** A Tiled `summoning_stone` point object: its point is the stone's foot, and property glow_color its glow (#rrggbb). */
export function readStoneObject(obj: any, layer: string | null): SummoningStoneObject | null {
  if (!finite(obj?.x) || !finite(obj?.y)) return null;
  return stoneFrom({ name: String(obj.name ?? ""), position: { x: Math.floor(obj.x), y: Math.floor(obj.y) }, glowColor: propsOf(obj).get("glow_color"), layer });
}

/**
 * A name of its own for each object read from a map: a missing or repeated name becomes `<prefix>_<n>`, the first n
 * not taken, as the map editor names them. The editor can then save the list, and no chest is taken for another.
 */
function nameLoadedObjects<T extends { name: string }>(prefix: string, list: T[]): T[] {
  const named = list.map((o) => ({ ...o, name: typeof o.name === "string" ? o.name.trim() : "" }));
  const taken = new Set<string>();
  const pending: number[] = [];
  named.forEach((o, i) => {
    if (o.name && !taken.has(o.name)) taken.add(o.name);
    else pending.push(i);
  });
  let counter = 1;
  for (const i of pending) {
    while (taken.has(`${prefix}_${counter}`)) counter++;
    named[i].name = `${prefix}_${counter}`;
    taken.add(named[i].name);
  }
  return named;
}

/**
 * A map's chests or dungeon portals as loaded: the list saved in the map file when it has one, each keeping the layer
 * of the Tiled object with its name, else the Tiled objects. Undefined when there are neither.
 */
export function loadedMapObjects<T extends { name: string; layer: string | null }>(prefix: string, fromTiled: T[], saved: unknown): T[] | undefined {
  const tiled = nameLoadedObjects(prefix, fromTiled);
  if (!saved || typeof saved !== "object") return tiled.length > 0 ? tiled : undefined;
  const layers = new Map(tiled.map((o) => [o.name, o.layer]));
  const list: T[] = (Array.isArray(saved) ? saved : Object.values(saved)).filter((o: any) => o && typeof o === "object");
  return nameLoadedObjects(prefix, list.map((o) => ({ ...o, layer: layers.get(typeof o.name === "string" ? o.name.trim() : "") || o.layer })));
}

function checkList(raw: unknown, what: string, one: (item: any, label: string) => string | null): string | null {
  if (!Array.isArray(raw)) return `${what} must be a list`;
  if (raw.length > MAP_OBJECT_LIMIT) return `at most ${MAP_OBJECT_LIMIT} ${what}`;
  const seen = new Set<string>();
  for (const item of raw) {
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    if (!name) return "every object needs a name";
    if (seen.has(name)) return `the name "${name}" is used twice`;
    seen.add(name);
    const bad = one(item, `"${name}"`);
    if (bad) return bad;
    if (!finite(item.position?.x) || !finite(item.position?.y)) return `${name} has no position`;
  }
  return null;
}

export function cleanChests(raw: unknown): { chests: MapChestObject[] } | { error: string } {
  const error = checkList(raw, "chests", (c, label) => {
    if (wholeFrom(c.lootTableId, 1) === null) return `${label} needs a loot table`;
    if (wholeFrom(c.resetMinutes, 1, RESET_MAX_MIN) === null) return `${label} needs a reset of 1 to ${RESET_MAX_MIN} minutes`;
    return null;
  });
  if (error) return { error };
  return {
    chests: (raw as any[]).map((c) => ({
      name: c.name.trim(), lootTableId: Number(c.lootTableId), resetMinutes: Number(c.resetMinutes),
      position: { x: c.position.x, y: c.position.y }, layer: layerOf(c.layer),
    })),
  };
}

/** A portal list to save: each a dungeon portal (with a dungeon or none) or a teleport with its map and place. */
export function cleanPortals(raw: unknown): { portals: DungeonPortalObject[] } | { error: string } {
  const error = checkList(raw, "dungeon portals", (p, label) => {
    const kind = p.kind ?? "dungeon";
    if (!PORTAL_KINDS.includes(kind)) return `${label} has no kind dungeon or teleport`;
    if (kind === "dungeon" && p.dungeonId != null && wholeFrom(p.dungeonId, 1) === null) return `${label} needs a dungeon`;
    if (kind === "teleport" && !spotFrom(p.target?.map, p.target?.x, p.target?.y)) return `${label} needs a map and a place to lead to`;
    if (!finite(p.size?.width) || !finite(p.size?.height) || p.size.width < 1 || p.size.height < 1) return `${label} needs a size of 1 or more`;
    return null;
  });
  if (error) return { error };
  return { portals: (raw as any[]).map((p) => ({ ...portalFrom(p)!, name: p.name.trim() })) };
}

/** A summoning stone list to save: each named, placed, and with a #rrggbb glow (none given is DEFAULT_GLOW). */
export function cleanStones(raw: unknown): { stones: SummoningStoneObject[] } | { error: string } {
  const error = checkList(raw, "summoning stones", (s, label) =>
    s.glowColor != null && glowColorOf(s.glowColor) === null ? `${label} needs a glow colour as #rrggbb` : null);
  if (error) return { error };
  return { stones: (raw as any[]).map((s) => ({ ...stoneFrom(s)!, name: s.name.trim() })) };
}

export const MAP_OBJECT_REFUSED = "You do not have permission to edit maps";

type Option = { id: number; name: string };

/** The answer to MAP_OBJECT_OPTIONS: the pickers' lists, or empty lists and the reason for an editor without map rights. */
export async function mapObjectOptionsFor(allowed: boolean, load: () => Promise<{ dungeons: Array<{ id: unknown; name: unknown }>; lootTables: Array<{ id: unknown; name: unknown }> }>):
  Promise<{ dungeons: Option[]; lootTables: Option[]; message?: string }> {
  if (!allowed) return { dungeons: [], lootTables: [], message: MAP_OBJECT_REFUSED };
  const { dungeons, lootTables } = await load();
  const list = (rows: Array<{ id: unknown; name: unknown }>) => rows.map((r) => ({ id: Number(r.id), name: String(r.name) }));
  return { dungeons: list(dungeons), lootTables: list(lootTables) };
}
