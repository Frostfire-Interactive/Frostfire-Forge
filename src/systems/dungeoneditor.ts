import log from "../modules/logger";
import assetCache from "../services/assetCache";
import permissions from "./permissions";
import { dungeonDefs } from "./dungeons/definitions";
import { DEFAULT_MULTIPLIERS, PORTAL_COLOR_PATTERN, type DungeonDef, type DungeonSize } from "./dungeons/types";
import { isCopyKey } from "./dungeons/copykey";
import { allMapPortals, dungeonPortalRefs, linkablePortals, portalChange, relinkPlan, writePortals, type MapPortals, type PortalRef } from "./portaleditor";
import { applyPlan, dungeonReturnPlan } from "./portalpairs";

/** The tool's own permission and the wildcards over it, as the other editors have theirs. */
export const EDITOR_PERMISSIONS = ["tools.dungeon_editor", "tools.*", "server.admin", "server.*"];
export const DENIED = "You don't have permission to use the dungeon tool.";

/** Column size of dungeons.name. */
export const NAME_MAX = 48;
export const MULTIPLIER_MIN = 0.1, MULTIPLIER_MAX = 100;

const lower = (s: unknown): string => String(s ?? "").toLowerCase();

// -------------------------------------------------------------- permission

/** Admins, and anyone holding the tool's permission: the stored permissions, asked on every packet. */
export async function canUseEditor(admin: any): Promise<boolean> {
  if (!admin?.username || admin.isGuest) return false;
  if (admin.isAdmin) return true;
  const held = String((await permissions.get(admin.username)) || "").split(",").map((p) => p.trim()).filter(Boolean);
  return held.some((p) => EDITOR_PERMISSIONS.includes(p));
}

/** Whether a player could have the editor open, from the permissions copied at login: who is told to reload. */
export function mayHaveEditorOpen(player: any): boolean {
  if (player?.isAdmin) return true;
  const held: string[] = Array.isArray(player?.permissions) ? player.permissions : [];
  return held.some((p) => EDITOR_PERMISSIONS.includes(p));
}

// ----------------------------------------------------------------- reading

/** A map a dungeon can be on, as the picker shows it: bare name and size in pixels. */
export interface MapOption { name: string; widthPx: number; heightPx: number }

export async function mapOptions(): Promise<MapOption[]> {
  const list = await assetCache.get("mapProperties");
  const out: MapOption[] = [];
  for (const m of (Array.isArray(list) ? (list as any[]) : [])) {
    if (typeof m?.name !== "string" || !m.name || isCopyKey(m.name)) continue;
    const name = m.name.endsWith(".json") ? m.name.slice(0, -".json".length) : m.name;
    out.push({
      name,
      widthPx: (Number(m.width) || 0) * (Number(m.tileWidth) || 0),
      heightPx: (Number(m.height) || 0) * (Number(m.tileHeight) || 0),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface DungeonEditorData {
  dungeons: DungeonDef[];
  maps: MapOption[];
  defaults: DungeonDef["multipliers"];
  /** False when the dungeons table could not be read: nothing can be saved. */
  ready: boolean;
  /** The longest name a dungeon may have. */
  nameMax: number;
  /** Every dungeon portal outside copies, with the dungeon it leads into (null: none): the entrance portal picker. */
  portals: PortalRef[];
}

export async function buildEditorData(): Promise<DungeonEditorData> {
  return {
    dungeons: await dungeonDefs.all(),
    maps: await mapOptions(),
    defaults: DEFAULT_MULTIPLIERS,
    ready: true,
    nameMax: NAME_MAX,
    portals: dungeonPortalRefs(await allMapPortals()),
  };
}

// -------------------------------------------------------------- validation

export interface FieldError { field: string; message: string }

/** What is wrong with a dungeon sent by the editor, by field ("multipliers.10.damage" for a raid's damage at size 10). */
export function validateDungeon(data: any, ctx: { maps: MapOption[]; dungeons: DungeonDef[]; portals?: MapPortals[] }): FieldError[] {
  const errors: FieldError[] = [];
  const add = (field: string, message: string) => { if (!errors.some((e) => e.field === field)) errors.push({ field, message }); };
  const id = data?.id === null || data?.id === undefined ? null : Number(data.id);
  const others = ctx.dungeons.filter((d) => id === null || d.id !== id);

  const name = typeof data?.name === "string" ? data.name.trim() : "";
  if (!name) add("name", "Name is required.");
  else if (name.length > NAME_MAX) add("name", `Name must be ${NAME_MAX} characters or fewer.`);
  else if (others.some((d) => lower(d.name) === lower(name))) add("name", "A dungeon with that name already exists.");

  const map = ctx.maps.find((m) => m.name === data?.map);
  if (typeof data?.map !== "string" || !map) add("map", "Pick a map.");
  else if (others.some((d) => d.map === map.name)) add("map", "That map already has a dungeon.");

  const type = data?.type;
  if (type !== "dungeon" && type !== "raid") add("type", "Type must be dungeon or raid.");

  const sizes: unknown[] = Array.isArray(data?.sizes) ? data.sizes : [];
  if (!Array.isArray(data?.sizes)) add("sizes", "Sizes must be a list.");
  else if (type === "dungeon") {
    if (sizes.length !== 1 || sizes[0] !== 5) add("sizes", "A dungeon is for a party of 5.");
  } else if (type === "raid") {
    if (!sizes.length) add("sizes", "Pick at least one raid size.");
    else if (sizes.some((s) => s !== 10 && s !== 20)) add("sizes", "A raid is for 10 or 20 players.");
  }

  // each allowed size has a health and a damage multiplier
  const allowed = sizes.filter((s): s is DungeonSize => s === 5 || s === 10 || s === 20);
  for (const size of new Set(allowed)) {
    for (const key of ["health", "damage"] as const) {
      const value = data?.multipliers?.[String(size)]?.[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < MULTIPLIER_MIN || value > MULTIPLIER_MAX) {
        add(`multipliers.${size}.${key}`, `The ${key} multiplier must be a number from ${MULTIPLIER_MIN} to ${MULTIPLIER_MAX}.`);
      }
    }
  }

  for (const [key, limit, label] of [["entranceX", map?.widthPx, "wide"], ["entranceY", map?.heightPx, "high"]] as const) {
    const value = data?.[key];
    if (typeof value !== "number" || !Number.isInteger(value)) add(key, "The entrance must be whole pixels.");
    else if (value < 0 || (limit !== undefined && value > limit - 1)) add(key, limit !== undefined ? `The entrance must be inside the map (0 to ${limit - 1}).` : `The entrance is outside the map (${label}).`);
  }

  if (typeof data?.enabled !== "boolean") add("enabled", "Enabled must be on or off.");

  const color = data?.portalColor;
  if (color !== null && color !== undefined && (typeof color !== "string" || !PORTAL_COLOR_PATTERN.test(color))) {
    add("portalColor", "The portal colour must be a code like #ff8a3d.");
  }

  // the entrance portal: left out keeps the links as they are; null leads from none
  const pick = data?.portal;
  if (pick !== undefined && pick !== null) {
    const free = linkablePortals(ctx.portals ?? [], id);
    if (typeof pick?.map !== "string" || typeof pick?.name !== "string" || !free.some((p) => p.map === pick.map && p.name === pick.name)) {
      add("portal", "Pick a dungeon portal that leads into no other dungeon.");
    }
  }
  return errors;
}

// ----------------------------------------------------------------- changes

interface Outcome { errors: string[]; fields?: Record<string, string>; name?: string; id?: number; notes?: string[]; changed?: boolean }
const refuse = (...errors: string[]): Outcome => ({ errors });
function invalid(errors: FieldError[]): Outcome {
  const fields: Record<string, string> = {};
  for (const error of errors) fields[error.field] ??= error.message;
  return { errors: errors.map((e) => e.message), fields };
}

const GONE = "That dungeon no longer exists. It may have been deleted by someone else.";

async function saveDungeon(admin: any, data: any): Promise<Outcome> {
  const all = await dungeonDefs.all();
  const id = data?.id === null || data?.id === undefined ? null : Number(data.id);
  if (id !== null && !all.some((d) => d.id === id)) return refuse(GONE);

  const portals = await allMapPortals();
  const maps = await mapOptions();
  const errors = validateDungeon(data, { maps, dungeons: all, portals });
  if (errors.length) return invalid(errors);
  const pick = data.portal === undefined ? undefined : data.portal === null ? null : { map: String(data.portal.map), name: String(data.portal.name) };

  // the dungeon's exit portal must have room above the entrance (id 0 stands for a new dungeon)
  const draft = { id: id ?? 0, map: String(data.map), entranceX: Number(data.entranceX), entranceY: Number(data.entranceY) };
  const linked = applyPlan(portals, pick === undefined ? [] : relinkPlan(portals, draft.id, pick));
  const room = dungeonReturnPlan(linked, [...all.filter((d) => d.id !== id), draft], [draft.id], maps, "entranceY");
  if ("errors" in room) return invalid(Object.entries(room.fields).map(([field, message]) => ({ field, message })));

  const sizes = [...new Set((data.sizes as number[]).map(Number))].sort((a, b) => a - b) as DungeonSize[];
  const multipliers = {} as DungeonDef["multipliers"];
  for (const key of ["5", "10", "20"] as const) {
    const given = data.multipliers?.[key];
    multipliers[key] = sizes.includes(Number(key) as DungeonSize) ? { health: Number(given.health), damage: Number(given.damage) } : { ...DEFAULT_MULTIPLIERS[key] };
  }
  const savedId = await dungeonDefs.save({
    id,
    name: String(data.name).trim(),
    map: String(data.map),
    type: data.type,
    sizes,
    multipliers,
    entranceX: Number(data.entranceX),
    entranceY: Number(data.entranceY),
    enabled: data.enabled,
    portalColor: typeof data.portalColor === "string" ? data.portalColor.toLowerCase() : null,
  });
  const name = String(data.name).trim();
  log.info(`[DUNGEON EDITOR] ${admin.username} ${id === null ? "created" : "saved"} dungeon ${name} (#${savedId})`);
  const notes = [id === null ? "Link an entrance portal to lead into it." : "Copies that are already open keep running with what they were opened with."];
  notes.push(...(await relinkPortals(admin, savedId, pick)));
  return { errors: [], name, id: savedId, changed: true, notes };
}

async function deleteDungeon(admin: any, data: any): Promise<Outcome> {
  const id = Number(data?.id);
  const row = Number.isInteger(id) ? await dungeonDefs.get(id) : null;
  if (!row) return refuse(GONE);
  await dungeonDefs.remove(row.id);
  if (await dungeonDefs.get(row.id)) return refuse(`The server did not delete ${row.name}.`);
  log.info(`[DUNGEON EDITOR] ${admin.username} deleted dungeon ${row.name}`);
  const notes = ["Copies that are already open keep running; no new ones open."];
  notes.push(...(await relinkPortals(admin, row.id, null)));
  return { errors: [], name: row.name, changed: true, notes };
}

/**
 * Links the dungeon to the picked portal (or none; undefined keeps the links), with the portal editor's changes kept in
 * turn, and plans its exit portal on its map (systems/portalpairs.ts dungeonReturnPlan) in the same change. The exit
 * maps are written before the linked ones.
 */
async function relinkPortals(admin: any, dungeonId: number, pick: { map: string; name: string } | null | undefined): Promise<string[]> {
  try {
    return await portalChange(async () => {
      const all = await allMapPortals();
      const by = String(admin.username);
      const links = pick === undefined ? [] : relinkPlan(all, dungeonId, pick);
      const exits = dungeonReturnPlan(applyPlan(all, links), await dungeonDefs.all(), [dungeonId], await mapOptions(), "entranceY");
      if ("errors" in exits) {
        await writePortals(links, by);
        return [`The dungeon's portal links were saved, but not its exit portal: ${exits.errors[0]}`];
      }
      const plan = [
        ...exits.plan.filter((e) => !links.some((l) => l.map === e.map)),
        ...links.map((l) => exits.plan.find((e) => e.map === l.map) ?? l),
      ];
      await writePortals(plan, by);
      return exits.notes;
    });
  } catch (error) {
    log.error(`Dungeon editor could not link portals of dungeon #${dungeonId}: ${error}`);
    return [`The dungeon was saved, but its portal links were not: ${(error as Error)?.message ?? error}`];
  }
}

/** Changes run one at a time: each is a check followed by a write. */
let changes: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = changes.then(work, work);
  changes = run.catch(() => {});
  return run;
}

export interface ActionResult {
  kind: "result";
  ok: boolean;
  errors: string[];
  fields?: Record<string, string>;
  name?: string;
  /** The saved dungeon's id, on a save that worked. */
  id?: number;
  notes: string[];
  denied?: boolean;
  changed?: boolean;
  data: DungeonEditorData | null;
}
export type EditorResult = { kind: "data"; data: DungeonEditorData } | ActionResult;

function change(type: string, work: () => Promise<Outcome>): Promise<ActionResult> {
  return oneAtATime(async () => {
    let outcome: Outcome;
    try {
      outcome = await work();
    } catch (error) {
      log.error(`Dungeon editor ${type} failed: ${error}`);
      outcome = refuse(`The server could not do that: ${(error as Error)?.message ?? error}`);
    }
    return {
      kind: "result", ok: outcome.errors.length === 0, errors: outcome.errors, fields: outcome.fields, name: outcome.name, id: outcome.id,
      notes: outcome.notes ?? [], changed: outcome.changed, data: await buildEditorData(),
    };
  });
}

/** Dispatch for every DUNGEON_EDITOR_* packet. Permission is checked here, on each one. */
export async function handleEditorPacket(admin: any, type: string, data: any): Promise<EditorResult> {
  if (!(await canUseEditor(admin))) return { kind: "result", ok: false, errors: [DENIED], notes: [], denied: true, data: null };
  switch (type) {
    case "DUNGEON_EDITOR_LIST":
      return { kind: "data", data: await buildEditorData() };
    case "DUNGEON_EDITOR_SAVE":
      return change(type, () => saveDungeon(admin, data));
    case "DUNGEON_EDITOR_DELETE":
      return change(type, () => deleteDungeon(admin, data));
    default:
      return change(type, async () => refuse(`Unknown dungeon editor action: ${type}`));
  }
}
