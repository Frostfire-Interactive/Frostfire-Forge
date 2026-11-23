import log from "../modules/logger";
import assetCache from "../services/assetCache";
import { dungeonDefs } from "./dungeons/definitions";
import { bareName, isCopyKey } from "./dungeons/copykey";
import type { DungeonPortalObject } from "./dungeons/types";
import { portalsFrom } from "./mapobjects";
import { DENIED, canUseEditor, mapOptions, type MapOption } from "./dungeoneditor";
import { applyPlan, dungeonReturnPlan, mergePlans, returnPlan, returnRefusal, shiftPlan, type MapPortals, type MapSize, type ReturnPlanOutcome } from "./portalpairs";

export const NAME_MAX = 48;
export const SIZE_MIN = 8, SIZE_MAX = 512;
export const DEFAULT_PORTAL_SIZE = { width: 32, height: 32 };

const lower = (s: unknown): string => String(s ?? "").toLowerCase();
const whole = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

// ------------------------------------------------------------- list edits

export interface PortalSaveContext {
  /** The bare name of the map the portals are on. */
  map: string;
  maps: MapOption[];
  /** The editor's position, for "Place at my position". */
  at?: { x: number; y: number } | null;
}

export type PortalSaveOutcome =
  | { portals: DungeonPortalObject[]; portal: DungeonPortalObject; name: string; notes: string[] }
  | { errors: string[]; fields?: Record<string, string> };

const GONE = "That portal no longer exists. It may have been deleted by someone else.";

/**
 * One portal created or edited by the editor, in the map's list: a new one goes last, an edit keeps its place, its
 * dungeon link (unless it becomes a teleport) and its layer. Errors are by field ("target.x", "position.y"). A return
 * portal is refused: it follows its source (systems/portalpairs.ts).
 */
export function portalSave(list: DungeonPortalObject[], data: any, ctx: PortalSaveContext): PortalSaveOutcome {
  const original = typeof data?.original === "string" && data.original ? data.original : null;
  const index = original === null ? -1 : list.findIndex((p) => p.name === original);
  if (original !== null && index === -1) return { errors: [GONE] };
  const before = index === -1 ? null : list[index]!;
  const refusal = returnRefusal(before ?? undefined);
  if (refusal) return { errors: [refusal] };

  const fields: Record<string, string> = {};
  const add = (field: string, message: string) => { fields[field] ??= message; };

  const name = typeof data?.name === "string" ? data.name.trim() : "";
  if (!name) add("name", "Name is required.");
  else if (name.length > NAME_MAX) add("name", `Name must be ${NAME_MAX} characters or fewer.`);
  else if (list.some((p, i) => i !== index && lower(p.name) === lower(name))) add("name", "This map already has a portal with that name.");

  if (typeof data?.mirror !== "boolean") add("mirror", "Mirror other side must be on or off.");

  const destination = data?.destination;
  if (destination !== "none" && destination !== "teleport") add("destination", "The destination must be none or teleport.");

  let target: DungeonPortalObject["target"] = null;
  if (destination === "teleport") {
    const t = data?.target;
    const to = ctx.maps.find((m) => m.name === t?.map);
    if (typeof t?.map !== "string" || !to) add("target.map", "Pick the map it leads to.");
    for (const [key, limit] of [["x", to?.widthPx], ["y", to?.heightPx]] as const) {
      const v = t?.[key];
      if (!whole(v)) add(`target.${key}`, "The place must be whole pixels.");
      else if (v < 0 || (limit !== undefined && v > limit - 1)) add(`target.${key}`, limit !== undefined ? `The place must be inside the map (0 to ${limit - 1}).` : "The place must be 0 or more.");
    }
    if (to && whole(t?.x) && whole(t?.y)) target = { map: to.name, x: t.x, y: t.y };
  }

  const here = ctx.maps.find((m) => m.name === ctx.map);
  const size = { width: data?.size?.width ?? DEFAULT_PORTAL_SIZE.width, height: data?.size?.height ?? DEFAULT_PORTAL_SIZE.height };
  for (const key of ["width", "height"] as const) {
    if (!whole(size[key]) || size[key] < SIZE_MIN || size[key] > SIZE_MAX) add(`size.${key}`, `The ${key} must be whole pixels from ${SIZE_MIN} to ${SIZE_MAX}.`);
  }
  let position = data?.position;
  if (data?.atMe === true && ctx.at && whole(size.width) && whole(size.height)) {
    const fit = (v: number, span: number, limit?: number) => Math.max(0, limit !== undefined ? Math.min(v, limit - span) : v);
    position = {
      x: fit(Math.floor(ctx.at.x - size.width / 2), size.width, here?.widthPx),
      y: fit(Math.floor(ctx.at.y - size.height / 2), size.height, here?.heightPx),
    };
  }
  for (const [key, span, limit] of [["x", size.width, here?.widthPx], ["y", size.height, here?.heightPx]] as const) {
    const v = position?.[key];
    if (!whole(v)) add(`position.${key}`, "The position must be whole pixels.");
    else if (v < 0 || (limit !== undefined && whole(span) && v + span > limit)) add(`position.${key}`, "The portal must be inside the map.");
  }

  if (Object.keys(fields).length) return { errors: [...new Set(Object.values(fields))], fields };

  const notes: string[] = [];
  const kind = destination === "teleport" ? "teleport" : "dungeon";
  const dungeonId = kind === "dungeon" ? before?.dungeonId ?? null : null;
  if (kind === "teleport" && before?.dungeonId != null) notes.push("This portal no longer leads into its dungeon.");
  if (kind === "dungeon" && dungeonId === null) notes.push("Link it to a dungeon in the dungeon editor to lead into one.");
  const portal: DungeonPortalObject = {
    name, kind, dungeonId, mirror: data.mirror, target,
    position: { x: position.x, y: position.y }, size: { width: size.width, height: size.height }, layer: before?.layer ?? null,
  };
  const portals = [...list];
  if (index === -1) portals.push(portal);
  else portals[index] = portal;
  return { portals, portal, name, notes };
}

/** The map's list without the named portal. A return portal is refused: it goes when its source does. */
export function portalDelete(list: DungeonPortalObject[], name: unknown): { portals: DungeonPortalObject[] } | { error: string } {
  const portal = typeof name === "string" ? list.find((p) => p.name === name) : undefined;
  if (!portal) return { error: GONE };
  const refusal = returnRefusal(portal);
  if (refusal) return { error: refusal };
  return { portals: list.filter((p) => p.name !== name) };
}

// ------------------------------------------------------ dungeon portal links

export type { MapPortals };
export interface PortalRef { map: string; name: string; dungeonId: number | null }

/** The dungeon portals a dungeon can lead from: its own and those linked to none. Teleports and dungeons' exits never. */
export function linkablePortals(all: MapPortals[], dungeonId: number | null): PortalRef[] {
  const out: PortalRef[] = [];
  for (const { map, portals } of all) {
    if (isCopyKey(map)) continue;
    for (const p of portals) {
      if (p.kind !== "dungeon" || p.returnOf) continue;
      if (p.dungeonId === null || (dungeonId !== null && p.dungeonId === dungeonId)) out.push({ map, name: p.name, dungeonId: p.dungeonId });
    }
  }
  return out;
}

/** Every dungeon portal outside copies, with what it is linked to: what the dungeon editor's picker shows. A dungeon's exit is left out. */
export function dungeonPortalRefs(all: MapPortals[]): PortalRef[] {
  return all.filter(({ map }) => !isCopyKey(map))
    .flatMap(({ map, portals }) => portals.filter((p) => p.kind === "dungeon" && !p.returnOf).map((p) => ({ map, name: p.name, dungeonId: p.dungeonId })));
}

/** The maps whose portals change when the dungeon leads from the picked portal (or from none): the pick linked, its others unlinked. */
export function relinkPlan(all: MapPortals[], dungeonId: number, pick: { map: string; name: string } | null): MapPortals[] {
  const plan: MapPortals[] = [];
  for (const { map, portals } of all) {
    let changed = false;
    const next = portals.map((p) => {
      const picked = pick !== null && pick.map === map && pick.name === p.name && p.kind === "dungeon";
      if (picked && p.dungeonId !== dungeonId) { changed = true; return { ...p, dungeonId }; }
      if (!picked && p.dungeonId === dungeonId) { changed = true; return { ...p, dungeonId: null }; }
      return p;
    });
    if (changed) plan.push({ map, portals: next });
  }
  return plan;
}

/**
 * A plan with the exits of the dungeons it touches planned on top (systems/portalpairs.ts dungeonReturnPlan), read
 * from the dungeons as they are now. The dungeons are read only when some are touched. Refused for want of room on `field`.
 */
export async function withDungeonExits(all: MapPortals[], plan: MapPortals[], ids: Array<number | null | undefined>, maps: MapSize[], field: string,
  dungeons?: Array<{ id: number; map: string; entranceX: number; entranceY: number }>): Promise<ReturnPlanOutcome> {
  const touched = [...new Set(ids.filter((id): id is number => typeof id === "number"))];
  if (!touched.length) return { plan, notes: [] };
  const exits = dungeonReturnPlan(applyPlan(all, plan), dungeons ?? (await dungeonDefs.all()), touched, maps, field);
  if ("errors" in exits) return exits;
  return { plan: mergePlans(plan, exits.plan), notes: exits.notes };
}

// ------------------------------------------------------------------ storage

/** Writes one map's portal list everywhere it is kept; set by the map save code (socket/handlers/editors.ts). */
export type PortalWriter = (map: string, portals: DungeonPortalObject[], by: string) => Promise<void>;
let writer: PortalWriter | null = null;
export function setPortalWriter(write: PortalWriter | null): void {
  writer = write;
}

/** Every map's portals, as loaded (copies left out). */
export async function allMapPortals(): Promise<MapPortals[]> {
  const list = await assetCache.get("mapProperties");
  return (Array.isArray(list) ? (list as any[]) : [])
    .filter((m) => typeof m?.name === "string" && m.name && !isCopyKey(m.name))
    .map((m) => ({ map: bareName(m.name), portals: portalsFrom(m.dungeonPortals) }));
}

async function portalsOf(map: string): Promise<DungeonPortalObject[]> {
  return (await allMapPortals()).find((m) => m.map === map)?.portals ?? [];
}

/** Saves the maps of a plan, one after another. */
export async function writePortals(plan: MapPortals[], by: string): Promise<void> {
  if (!plan.length) return;
  if (!writer) throw new Error("portals cannot be saved yet");
  for (const { map, portals } of plan) await writer(map, portals, by);
}

// -------------------------------------------------------------------- editor

export interface PortalEditorData {
  map: string;
  portals: DungeonPortalObject[];
  /** Names of the dungeons the map's portals lead into, by id. */
  dungeons: Record<string, string>;
  maps: MapOption[];
  /** The editor's position on the map. */
  here: { x: number; y: number } | null;
  nameMax: number;
  sizeMin: number;
  sizeMax: number;
}

export async function buildPortalEditorData(map: string, here: { x: number; y: number } | null): Promise<PortalEditorData> {
  const portals = await portalsOf(map);
  const dungeons: Record<string, string> = {};
  for (const p of portals) {
    if (p.dungeonId === null) continue;
    const def = await dungeonDefs.get(p.dungeonId);
    dungeons[String(p.dungeonId)] = def?.name ?? `#${p.dungeonId} (deleted)`;
  }
  return { map, portals, dungeons, maps: await mapOptions(), here, nameMax: NAME_MAX, sizeMin: SIZE_MIN, sizeMax: SIZE_MAX };
}

export interface PortalEditorResult {
  kind: "result";
  ok: boolean;
  errors: string[];
  fields?: Record<string, string>;
  name?: string;
  notes: string[];
  denied?: boolean;
  data: PortalEditorData | null;
}
export type PortalEditorReply = { kind: "data"; data: PortalEditorData } | PortalEditorResult;

/** Changes run one at a time with the dungeon editor's links: each is a read of the lists followed by a write. */
let changes: Promise<unknown> = Promise.resolve();
export function portalChange<T>(work: () => Promise<T>): Promise<T> {
  const run = changes.then(work, work);
  changes = run.catch(() => {});
  return run;
}

/**
 * A map that grew left or up in the map editor moves everything on it by (dx, dy) pixels. Its portals are moved here,
 * from the lists the server has now, so a portal saved in the portal editor since the map editor loaded is kept. Every
 * teleport on any map that leads into the map (a return portal too) is moved by as much, so it leads to the same ground.
 */
export function shiftMapPortals(map: string, dx: number, dy: number, by: string): Promise<void> {
  return portalChange(async () => {
    if (!dx && !dy) return;
    await writePortals(shiftPlan(await allMapPortals(), bareName(map), dx, dy), by);
  });
}

const positionOf = (admin: any): { x: number; y: number } | null => {
  const at = admin?.location?.position;
  return Number.isFinite(Number(at?.x)) && Number.isFinite(Number(at?.y)) ? { x: Number(at.x), y: Number(at.y) } : null;
};

/** Dispatch for every PORTAL_EDITOR_* packet, on the editor's own map. Permission is checked here, on each one. */
export async function handlePortalEditorPacket(admin: any, type: string, data: any): Promise<PortalEditorReply> {
  if (!(await canUseEditor(admin))) return { kind: "result", ok: false, errors: [DENIED], notes: [], denied: true, data: null };
  const map = bareName(String(admin?.location?.map ?? ""));
  const here = positionOf(admin);
  if (type === "PORTAL_EDITOR_LIST") return { kind: "data", data: await buildPortalEditorData(map, here) };
  return portalChange(async () => {
    let out: { errors: string[]; fields?: Record<string, string>; name?: string; notes?: string[] };
    try {
      // A portal and its return are planned from the lists as they are now and written in this one change.
      const all = await allMapPortals();
      const list = all.find((m) => m.map === map)?.portals ?? [];
      const original = typeof data?.original === "string" && data.original ? data.original : null;
      if (type === "PORTAL_EDITOR_SAVE") {
        const maps = await mapOptions();
        const saved = portalSave(list, data, { map, maps, at: here });
        const was = original === null ? undefined : list.find((p) => p.name === original);
        const teleports = "errors" in saved ? saved : returnPlan(all, { map, original, portals: saved.portals, source: saved.portal }, maps);
        const paired = "errors" in saved || "errors" in teleports ? teleports
          : await withDungeonExits(all, teleports.plan, [was?.dungeonId, saved.portal.dungeonId], maps, "destination");
        if ("errors" in paired) out = paired;
        else if ("errors" in teleports) out = teleports;
        else if ("errors" in saved) out = saved;
        else {
          await writePortals(paired.plan, String(admin.username));
          log.info(`[PORTAL EDITOR] ${admin.username} saved portal ${saved.name} on ${map}${paired.plan.length > 1 ? ` (and ${paired.plan.slice(1).map((m) => m.map).join(", ")})` : ""}`);
          out = { errors: [], name: saved.name, notes: [...saved.notes, ...teleports.notes, ...paired.notes] };
        }
      } else if (type === "PORTAL_EDITOR_DELETE") {
        const left = portalDelete(list, data?.name);
        if ("error" in left) out = { errors: [left.error] };
        else {
          const teleports = returnPlan(all, { map, original: String(data.name), portals: left.portals, source: null }, []);
          if ("errors" in teleports) throw new Error(teleports.errors.join(" "));
          const gone = list.find((p) => p.name === data.name);
          const paired = await withDungeonExits(all, teleports.plan, [gone?.dungeonId], await mapOptions(), "destination");
          if ("errors" in paired) throw new Error(paired.errors.join(" "));
          await writePortals(paired.plan, String(admin.username));
          log.info(`[PORTAL EDITOR] ${admin.username} deleted portal ${data.name} on ${map}`);
          out = { errors: [], name: String(data.name), notes: [...teleports.notes, ...paired.notes] };
        }
      } else out = { errors: [`Unknown portal editor action: ${type}`] };
    } catch (error) {
      log.error(`Portal editor ${type} failed: ${error}`);
      out = { errors: [`The server could not do that: ${(error as Error)?.message ?? error}`] };
    }
    return {
      kind: "result", ok: out.errors.length === 0, errors: out.errors, fields: out.fields, name: out.name, notes: out.notes ?? [],
      data: await buildPortalEditorData(map, here),
    } as PortalEditorResult;
  });
}
