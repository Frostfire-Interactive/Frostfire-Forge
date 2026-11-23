import log from "../modules/logger";
import assetCache from "../services/assetCache";
import { dungeonDefs } from "./dungeons/definitions";
import { bareName, isCopyKey } from "./dungeons/copykey";
import { DEFAULT_GLOW, glowColorOf, stonesFrom, type SummoningStoneObject } from "./mapobjects";
import { DENIED, canUseEditor, mapOptions } from "./dungeoneditor";
import { NAME_MAX, portalChange } from "./portaleditor";

// The summoning stone editor: a map's stones listed, saved and deleted by name, on the map the editor stands on.

const lower = (s: unknown): string => String(s ?? "").toLowerCase();
const GONE = "That summoning stone no longer exists. It may have been deleted by someone else.";
export const STONE_DUNGEON_REFUSED = "Summoning stones can only be placed on maps outside dungeons.";

export interface StoneSaveContext {
  /** The bare name of the map the stones are on. */
  map: string;
  /** The editor's position, for "Place at my position". */
  at: { x: number; y: number } | null;
  /** The map's size in pixels: a position must be inside it (only 0 or more is checked without). */
  size?: { width: number; height: number } | null;
}

export type StoneSaveOutcome =
  | { stones: SummoningStoneObject[]; name: string }
  | { errors: string[]; fields: Record<string, string> };

/**
 * One stone created or edited by the editor, in the map's list: a new one goes last, an edit keeps its place and layer.
 * Errors are by field ("name", "position.x", "position.y", "glowColor").
 */
export function stoneSave(list: SummoningStoneObject[], data: any, ctx: StoneSaveContext): StoneSaveOutcome {
  const original = typeof data?.original === "string" && data.original ? data.original : null;
  const index = original === null ? -1 : list.findIndex((s) => s.name === original);
  if (original !== null && index === -1) return { errors: [GONE], fields: {} };
  const before = index === -1 ? null : list[index]!;

  const fields: Record<string, string> = {};
  const add = (field: string, message: string) => { fields[field] ??= message; };

  const name = typeof data?.name === "string" ? data.name.trim() : "";
  if (!name) add("name", "Name is required.");
  else if (name.length > NAME_MAX) add("name", `Name must be ${NAME_MAX} characters or fewer.`);
  else if (list.some((s, i) => i !== index && lower(s.name) === lower(name))) add("name", "This map already has a summoning stone with that name.");

  let glowColor = DEFAULT_GLOW;
  if (data?.glowColor !== undefined && data.glowColor !== null && data.glowColor !== "") {
    const glow = glowColorOf(data.glowColor);
    if (glow === null) add("glowColor", "The glow color must be a #rrggbb color.");
    else glowColor = glow;
  }

  let position = data?.position;
  if (data?.atMe === true && ctx.at) position = { x: Math.round(ctx.at.x), y: Math.round(ctx.at.y) };
  const limits = { x: ctx.size?.width, y: ctx.size?.height };
  for (const key of ["x", "y"] as const) {
    const v = position?.[key];
    const limit = limits[key];
    if (typeof v !== "number" || !Number.isFinite(v)) add(`position.${key}`, "The position must be a number.");
    else if (v < 0 || (limit !== undefined && v > limit)) add(`position.${key}`, "The summoning stone must be inside the map.");
  }
  if (Object.keys(fields).length) return { errors: [...new Set(Object.values(fields))], fields };

  const stone: SummoningStoneObject = { name, position: { x: position.x, y: position.y }, glowColor, layer: before?.layer ?? null };
  const stones = [...list];
  if (index === -1) stones.push(stone);
  else stones[index] = stone;
  return { stones, name };
}

/** The map's list without the named stone. */
export function stoneDelete(list: SummoningStoneObject[], name: unknown): { stones: SummoningStoneObject[] } | { errors: string[] } {
  if (typeof name !== "string" || !list.some((s) => s.name === name)) return { errors: [GONE] };
  return { stones: list.filter((s) => s.name !== name) };
}

/** Why the map takes no stones: a dungeon's own map or one of its copies. Null when it does. */
export async function stoneMapProblem(map: string): Promise<string | null> {
  if (isCopyKey(map) || (await dungeonDefs.byMap(bareName(map)))) return STONE_DUNGEON_REFUSED;
  return null;
}

// ------------------------------------------------------------------ storage

/** Writes one map's stone list everywhere it is kept; set by the map save code (socket/handlers/editors.ts). */
export type StoneWriter = (map: string, stones: SummoningStoneObject[], by: string) => Promise<void>;
let writer: StoneWriter | null = null;
export function setStoneWriter(w: StoneWriter | null): void {
  writer = w;
}

async function stonesOf(map: string): Promise<SummoningStoneObject[]> {
  const list = await assetCache.get("mapProperties");
  const props = (Array.isArray(list) ? (list as any[]) : []).find((m) => typeof m?.name === "string" && !isCopyKey(m.name) && bareName(m.name) === map);
  return stonesFrom(props?.summoningStones);
}

/**
 * A map that grew left or up in the map editor moves everything on it by (dx, dy) pixels. Its stones are moved here, from
 * the list the server has now, in turn with the editor's own changes.
 */
export function shiftMapStones(map: string, dx: number, dy: number, by: string): Promise<void> {
  return portalChange(async () => {
    if (!dx && !dy) return;
    const name = bareName(map);
    const list = await stonesOf(name);
    if (!list.length) return;
    if (!writer) throw new Error("summoning stones cannot be saved yet");
    await writer(name, list.map((s) => ({ ...s, position: { x: s.position.x + dx, y: s.position.y + dy } })), by);
  });
}

// -------------------------------------------------------------------- editor

export type StoneEditorData = { map: string; stones: SummoningStoneObject[]; here: { x: number; y: number } | null; nameMax: number; refused: string | null };

async function buildData(map: string, raw: string, here: { x: number; y: number } | null): Promise<StoneEditorData> {
  const refused = await stoneMapProblem(raw);
  return { map, stones: refused ? [] : await stonesOf(map), here, nameMax: NAME_MAX, refused };
}

export interface StoneEditorResult {
  kind: "result";
  ok: boolean;
  errors: string[];
  fields?: Record<string, string>;
  name?: string;
  denied?: boolean;
  data: StoneEditorData | null;
}
export type StoneEditorReply = { kind: "data"; data: StoneEditorData } | StoneEditorResult;

const positionOf = (admin: any): { x: number; y: number } | null => {
  const at = admin?.location?.position;
  return Number.isFinite(Number(at?.x)) && Number.isFinite(Number(at?.y)) ? { x: Number(at.x), y: Number(at.y) } : null;
};

/** Dispatch for every SUMMON_STONE_EDITOR_* packet, on the editor's own map. Permission is checked here, on each one. */
export async function handleStoneEditorPacket(admin: any, type: "SUMMON_STONE_EDITOR_LIST" | "SUMMON_STONE_EDITOR_SAVE" | "SUMMON_STONE_EDITOR_DELETE", data: any): Promise<StoneEditorReply> {
  if (!(await canUseEditor(admin))) return { kind: "result", ok: false, errors: [DENIED], denied: true, data: null };
  const raw = String(admin?.location?.map ?? "");
  const map = bareName(raw);
  const here = positionOf(admin);
  if (type === "SUMMON_STONE_EDITOR_LIST") return { kind: "data", data: await buildData(map, raw, here) };
  return portalChange(async () => {
    let out: { errors: string[]; fields?: Record<string, string>; name?: string };
    try {
      const refused = await stoneMapProblem(raw);
      if (refused) out = { errors: [refused] };
      else {
        const list = await stonesOf(map);
        if (type === "SUMMON_STONE_EDITOR_SAVE") {
          const size = (await mapOptions()).find((m) => m.name === map);
          const saved = stoneSave(list, data, { map, at: here, size: size && size.widthPx > 0 && size.heightPx > 0 ? { width: size.widthPx, height: size.heightPx } : null });
          if ("errors" in saved) out = saved;
          else {
            if (!writer) throw new Error("summoning stones cannot be saved yet");
            await writer(map, saved.stones, String(admin.username));
            log.info(`[STONE EDITOR] ${admin.username} saved summoning stone ${saved.name} on ${map}`);
            out = { errors: [], name: saved.name };
          }
        } else if (type === "SUMMON_STONE_EDITOR_DELETE") {
          const left = stoneDelete(list, data?.name);
          if ("errors" in left) out = left;
          else {
            if (!writer) throw new Error("summoning stones cannot be saved yet");
            await writer(map, left.stones, String(admin.username));
            log.info(`[STONE EDITOR] ${admin.username} deleted summoning stone ${data.name} on ${map}`);
            out = { errors: [], name: String(data.name) };
          }
        } else out = { errors: [`Unknown summoning stone editor action: ${type}`] };
      }
    } catch (error) {
      log.error(`Stone editor ${type} failed: ${error}`);
      out = { errors: [`The server could not do that: ${(error as Error)?.message ?? error}`] };
    }
    return { kind: "result", ok: out.errors.length === 0, errors: out.errors, fields: out.fields, name: out.name, data: await buildData(map, raw, here) } as StoneEditorResult;
  });
}
