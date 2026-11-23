import { bareName } from "./dungeons/copykey";
import type { DungeonPortalObject, PortalLink, PortalSpot } from "./dungeons/types";

/**
 * Two-way teleports: every teleport portal with a destination has one return portal there, a teleport back to the
 * spot in front of the source. The return follows its source (saved, moved and deleted with it) and is never edited
 * on its own. A dungeon that a portal leads into has one exit the same way, on its template map (dungeonReturnPlan).
 * Everything here is pure: the editors read the lists, plan, and write the plan in one change.
 */

export interface MapPortals { map: string; portals: DungeonPortalObject[] }
export interface MapSize { name: string; widthPx: number; heightPx: number }

/**
 * A portal fires when a player's position moves from in front of its rectangle to inside it (dungeons/rules.ts
 * portalEntered). A player who comes out of a portal stands this many pixels in front of (below) its bottom edge,
 * centred on it: outside the trigger and clear of its arch (systems/portalarch.ts), so arriving never sends them
 * back, and about three steps from stepping in again.
 */
export const ARRIVAL_GAP = 16;
/** The way a player faces after coming out of a portal: down, away from it. */
export const ARRIVAL_FACING = "down";
/** For this long after a portal puts a player somewhere, those who see them appear there are told they came out of it
 *  (a spawn's `arrived`): the client walks them out of the portal. One who logs in or reconnects there is just there. */
export const PORTAL_ARRIVAL_MS = 2000;

/** A portal has just put this player where they are now. */
export function markPortalArrival(p: object | null | undefined, now: number): void {
  if (p) (p as { portalArrivalAt?: number }).portalArrivalAt = now;
}

/** Whether a portal put this player where they are within PORTAL_ARRIVAL_MS of `now`. */
export function cameThroughPortal(p: { portalArrivalAt?: number } | null | undefined, now: number): boolean {
  const at = Number(p?.portalArrivalAt);
  return Number.isFinite(at) && now >= at && now - at < PORTAL_ARRIVAL_MS;
}

const lower = (s: unknown): string => String(s ?? "").toLowerCase();

/** Where a player stands after coming out of a portal: centred on it, ARRIVAL_GAP below its bottom edge. */
export function arrivalSpot(map: string, portal: Pick<DungeonPortalObject, "position" | "size">): PortalSpot {
  return {
    map: bareName(map),
    x: portal.position.x + Math.floor(portal.size.width / 2),
    y: portal.position.y + portal.size.height + ARRIVAL_GAP,
  };
}

/**
 * Where a return portal stands so that its arrival spot is the place its source leads to: centred above the place,
 * its bottom edge ARRIVAL_GAP above it. Near the left or right edge it is moved along the edge (the place stays in
 * front of it); with no room above the place it cannot stand there.
 */
export function returnPlacement(target: { x: number; y: number }, size: { width: number; height: number }, map?: MapSize):
  { position: { x: number; y: number } } | { error: string } {
  const y = target.y - ARRIVAL_GAP - size.height;
  if (y < 0) return { error: `Leave ${ARRIVAL_GAP + size.height} pixels above the place for its return portal, which stands just behind where players arrive.` };
  let x = target.x - Math.floor(size.width / 2);
  if (map && map.widthPx > 0) x = Math.min(x, map.widthPx - size.width);
  return { position: { x: Math.max(0, x), y } };
}

/** The return portal's name: "<source> (return)", or "<source> (return 2)" and on when that is taken on its map. */
export function returnName(source: string, list: DungeonPortalObject[]): string {
  const taken = new Set(list.map((p) => lower(p.name)));
  const first = `${source} (return)`;
  if (!taken.has(lower(first))) return first;
  for (let n = 2; ; n++) {
    const name = `${source} (return ${n})`;
    if (!taken.has(lower(name))) return name;
  }
}

/** Whether a portal is a return portal (of the given source, when one is given). */
export function isReturn(p: DungeonPortalObject, of?: PortalLink): boolean {
  return !!p.returnOf && (!of || (p.returnOf.map === of.map && p.returnOf.name === of.name));
}

/** The editor's refusal for a return portal: it follows its source and is changed only through it. */
export function returnRefusal(p: DungeonPortalObject | undefined): string | null {
  if (!p?.returnOf) return null;
  const { map, name } = p.returnOf;
  return `"${p.name}" is the return portal of "${name}" on ${map}. It follows that portal: edit, move or delete "${name}" instead.`;
}

type Rect = Pick<DungeonPortalObject, "position" | "size">;
const overlaps = (a: Rect, b: Rect): boolean =>
  a.position.x < b.position.x + b.size.width && b.position.x < a.position.x + a.size.width &&
  a.position.y < b.position.y + b.size.height && b.position.y < a.position.y + a.size.height;
const holds = (r: Rect, p: { x: number; y: number }): boolean =>
  p.x >= r.position.x && p.x < r.position.x + r.size.width && p.y >= r.position.y && p.y < r.position.y + r.size.height;

export interface PortalChange {
  /** The map the edited portal is on. */
  map: string;
  /** Its name before the change; null for a new portal. */
  original: string | null;
  /** That map's list after the change. */
  portals: DungeonPortalObject[];
  /** The portal as saved; null when it was deleted. */
  source: DungeonPortalObject | null;
}

export type ReturnPlanOutcome =
  | { plan: MapPortals[]; notes: string[] }
  | { errors: string[]; fields: Record<string, string> };

/**
 * The maps to write for one change in the portal editor: the edited map, and every map where the portal's return is
 * removed or placed. The portal's old returns (by its old and new name) go wherever they are; a teleport with a
 * destination gets exactly one new return there. The edited map is always first; only maps that change follow.
 */
export function returnPlan(all: MapPortals[], change: PortalChange, maps: MapSize[]): ReturnPlanOutcome {
  const map = bareName(change.map);
  const lists = new Map<string, DungeonPortalObject[]>();
  for (const m of all) lists.set(bareName(m.map), m.portals);
  const before = new Map(lists);
  lists.set(map, change.portals);

  const names = new Set([change.original, change.source?.name].filter((n): n is string => typeof n === "string" && n !== ""));
  // a teleport's returns only: a dungeon's exit is planned by dungeonReturnPlan
  const ofSource = (p: DungeonPortalObject) => p.kind === "teleport" && !!p.returnOf && p.returnOf.map === map && names.has(p.returnOf.name);
  const oldLayers = new Map<string, string | null>();
  let had = false;
  for (const [m, list] of lists) {
    const old = list.find(ofSource);
    if (!old) continue;
    had = true;
    oldLayers.set(m, old.layer);
    lists.set(m, list.filter((p) => !ofSource(p)));
  }

  const notes: string[] = [];
  const s = change.source;
  if (s && s.kind === "teleport" && s.target) {
    const to = bareName(s.target.map);
    const fields: Record<string, string> = {};
    const back = arrivalSpot(map, s);
    const here = maps.find((m) => m.name === map);
    if (here && here.heightPx > 0 && back.y > here.heightPx - 1) {
      fields["position.y"] = `Leave ${ARRIVAL_GAP} pixels in front of (below) the portal: players coming back through its return portal stand there.`;
    }
    const placed = returnPlacement(s.target, s.size, maps.find((m) => m.name === to));
    if ("error" in placed) fields["target.y"] = placed.error;
    else if (to === map) {
      const ret = { position: placed.position, size: s.size };
      if (overlaps(ret, s) || holds(s, s.target) || holds(ret, back)) {
        fields["target.y"] = "That place is too close to the portal itself: its return portal would stand on it. Pick a place further away.";
      }
    }
    if (Object.keys(fields).length) return { errors: [...new Set(Object.values(fields))], fields };
    if ("error" in placed) return { errors: [placed.error], fields: { "target.y": placed.error } };

    const list = lists.get(to) ?? [];
    const name = returnName(s.name, list);
    lists.set(to, [...list, {
      name, kind: "teleport", dungeonId: null, mirror: s.mirror, target: back,
      position: placed.position, size: { width: s.size.width, height: s.size.height }, layer: oldLayers.get(to) ?? null,
      returnOf: { map, name: s.name },
    }]);
    notes.push(`Its return portal "${name}" stands on ${to} just behind where players arrive, and leads back here.`);
  } else if (had) notes.push("Its return portal was removed.");

  const plan = [...lists.keys()]
    .filter((m) => m === map || JSON.stringify(lists.get(m)) !== JSON.stringify(before.get(m) ?? []))
    .sort((a, b) => (a === map ? -1 : b === map ? 1 : 0))
    .map((m) => ({ map: m, portals: lists.get(m)! }));
  return { plan, notes };
}

/** What dungeonReturnPlan needs of a dungeon: its template map and where players arrive in a copy. */
export interface DungeonEntrance { id: number; map: string; entranceX: number; entranceY: number }

/** Whether a portal is a dungeon's exit made for it (a dungeon portal with a source): hand-made exits have none. */
export const isDungeonExit = (p: DungeonPortalObject): boolean => p.kind === "dungeon" && !!p.returnOf;

/**
 * The exits of the given dungeons, after a change to their portals or to the dungeons themselves. A dungeon that a
 * portal leads into keeps one exit on its template map: a dungeon portal linked to no dungeon (inside a copy every
 * dungeon portal leads out to the player's saved spot; on the template it leads nowhere), placed by returnPlacement
 * around the entrance so players arriving in a copy stand just in front of it, with its source's size and Mirror.
 * Copies are made from the template, so each copy opened from then on has it.
 *
 * One exit per dungeon. Its source is the portal that has it now while that still leads into the dungeon; otherwise
 * the first linked portal by map name, then by place in the map's list. Exits made for a dungeon that are on another
 * map (the dungeon moved or was deleted), or on a map that is no dungeon's, are removed. Hand-made exits (no source)
 * are never touched. A refusal for want of room is reported on `field`. Only the maps that change are listed.
 */
export function dungeonReturnPlan(all: MapPortals[], dungeons: DungeonEntrance[], ids: number[], maps: MapSize[], field: string): ReturnPlanOutcome {
  const lists = new Map<string, DungeonPortalObject[]>();
  for (const m of all) lists.set(bareName(m.map), m.portals);
  const before = new Map(lists);
  const templates = new Set(dungeons.map((d) => bareName(d.map)));
  const wanted = dungeons.filter((d) => ids.includes(d.id));
  const cleared = new Set(wanted.map((d) => bareName(d.map)));
  const sorted = [...lists.keys()].sort((a, b) => a.localeCompare(b));
  const linked = (id: number) => sorted.flatMap((map) => (lists.get(map) ?? [])
    .filter((p) => p.kind === "dungeon" && p.dungeonId === id && !p.returnOf)
    .map((p) => ({ map, portal: p })));

  // the exits as they are, by template map, before any are taken away
  const held = new Map<string, DungeonPortalObject>();
  for (const map of cleared) {
    const old = (lists.get(map) ?? []).find(isDungeonExit);
    if (old) held.set(map, old);
  }
  let had = false;
  for (const [map, list] of lists) {
    if (!cleared.has(map) && templates.has(map)) continue;
    const kept = list.filter((p) => !isDungeonExit(p));
    if (kept.length !== list.length) { had = true; lists.set(map, kept); }
  }

  const notes: string[] = [];
  let added = false;
  for (const d of wanted) {
    const map = bareName(d.map);
    const sources = linked(d.id);
    if (!sources.length) continue;
    const old = held.get(map);
    const owner = (old && sources.find((s) => s.map === old.returnOf!.map && s.portal.name === old.returnOf!.name)) ?? sources[0]!;
    const s = owner.portal;
    const entrance = { x: d.entranceX, y: d.entranceY };
    const placed = returnPlacement(entrance, s.size, maps.find((m) => m.name === map));
    if ("error" in placed) {
      const message = `Leave ${ARRIVAL_GAP + s.size.height} pixels above the dungeon's entrance for its exit portal, which stands just behind where players arrive.`;
      return { errors: [message], fields: { [field]: message } };
    }
    if (owner.map === map && (overlaps({ position: placed.position, size: s.size }, s) || holds(s, entrance))) {
      const message = "The dungeon's entrance is too close to the portal that leads into it: its exit portal would stand on it.";
      return { errors: [message], fields: { [field]: message } };
    }
    const list = lists.get(map) ?? [];
    const name = returnName(s.name, list);
    lists.set(map, [...list, {
      name, kind: "dungeon", dungeonId: null, mirror: s.mirror, target: null,
      position: placed.position, size: { width: s.size.width, height: s.size.height }, layer: old?.layer ?? null,
      returnOf: { map: owner.map, name: s.name },
    }]);
    added = true;
    notes.push(`The dungeon's exit portal "${name}" stands on ${map} just behind where players arrive in a copy.`);
  }
  if (!added && had) notes.push("The dungeon's exit portal was removed.");

  const plan = [...lists.keys()]
    .filter((m) => JSON.stringify(lists.get(m)) !== JSON.stringify(before.get(m) ?? []))
    .map((m) => ({ map: m, portals: lists.get(m)! }));
  return { plan, notes: plan.length ? notes : [] };
}

/** The lists after a plan is written. */
export function applyPlan(all: MapPortals[], plan: MapPortals[]): MapPortals[] {
  const out = all.map((m) => ({ map: m.map, portals: plan.find((p) => bareName(p.map) === bareName(m.map))?.portals ?? m.portals }));
  for (const p of plan) if (!out.some((m) => bareName(m.map) === bareName(p.map))) out.push(p);
  return out;
}

/** Two plans as one, the second planned from the lists the first leaves: its lists win; maps keep the first's order. */
export function mergePlans(first: MapPortals[], second: MapPortals[]): MapPortals[] {
  const later = (map: string) => second.find((p) => bareName(p.map) === bareName(map));
  return [
    ...first.map((p) => later(p.map) ?? p),
    ...second.filter((p) => !first.some((q) => bareName(q.map) === bareName(p.map))),
  ];
}

/**
 * A map that grew left or up by (dx, dy) pixels: its portals move with it, and every teleport on any map that leads
 * into it (returns included) leads to the same ground as before. Only the maps that change are listed.
 */
export function shiftPlan(all: MapPortals[], map: string, dx: number, dy: number): MapPortals[] {
  const name = bareName(map);
  const plan: MapPortals[] = [];
  for (const m of all) {
    const here = bareName(m.map) === name;
    let changed = false;
    const portals = m.portals.map((p) => {
      let q = p;
      if (here) q = { ...q, position: { x: q.position.x + dx, y: q.position.y + dy } };
      if (q.kind === "teleport" && q.target && bareName(q.target.map) === name) q = { ...q, target: { ...q.target, x: q.target.x + dx, y: q.target.y + dy } };
      if (q !== p) changed = true;
      return q;
    });
    if (changed) plan.push({ map: m.map, portals });
  }
  return plan;
}
