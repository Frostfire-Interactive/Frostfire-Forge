/**
 * Cutscenes: the scene documents of the cutscene and trailer tool (/cutsceneeditor, /cse). A scene is one JSON
 * document, the same everywhere: stored in the cutscenes table, sent to the editor, and sent (resolved) to the players
 * it is played to. This module holds the document's shape and its checks (readCutscene), the table and the cached list
 * of scenes (kept in step by every write, as systems/mounts.ts keeps the mounts), the editor's packets
 * (handleEditorPacket, as systems/mounteditor.ts answers its own) and the resolving of a document for a player. Playing
 * a scene to a player, holding them still and the triggers are systems/cutsceneplayer.ts.
 *
 * A scene is known by its name everywhere (the views of a once scene, a chain's `end.next`), so a saved scene keeps its
 * name: it is never renamed. Every field of a save is checked here and nothing the editor sends is stored as it came:
 * the document is built again from the fields that are known, so an unknown field is dropped, and the fields the server
 * fills in when it resolves a document (an actor's sprite layers, a weather's and a particle's data) are never stored.
 */
import query from "../controllers/sqldatabase";
import { serverFetch } from "../modules/https_servers";
import log from "../modules/logger";
import { getNpcSpriteLayers } from "../modules/spriteSheetManager";
import assetCache from "../services/assetCache";
import type { SpriteSheetOption } from "./creatures/editor";

// Whether a player is held in a scene is asked of a leaf (the packet receiver and the damage paths ask it too).
export { isHeld } from "./cutsceneheld";

export const EDITOR_PERMISSIONS = ["tools.cutscene_editor", "tools.*", "server.admin", "server.*"];
export const DENIED = "You don't have permission to use the cutscene editor.";

/**
 * The most each field can hold. The editor is sent these and keeps to them; every one is checked again here. A stored
 * document is held under `docBytes`: the receiver takes a frame of webtransport.maxPayloadMB (1 MB when it is not set)
 * from an editor, and a save is the document in a frame of a few hundred bytes more, so a document under half of that
 * always arrives.
 */
export const LIMITS = {
  nameMax: 64, descriptionMax: 500, mapMax: 128,
  durationMin: 0.5, durationMax: 600,
  letterboxSizeMax: 0.25, fadeMax: 10,
  actorsMax: 32, tracksMax: 64, triggersMax: 16, itemsPerTrackMax: 500, itemsPerDocMax: 4000,
  actorIdMax: 16, idMax: 32, labelMax: 64, actorNameMax: 64, layerNameMax: 128,
  textMax: 500, subMax: 200, speakerMax: 64, sayMax: 200, markNameMax: 64, soundMax: 128, referenceMax: 128,
  pathPointsMax: 64, minLevelMax: 1000, coordinateMax: 1_000_000,
  docBytes: 512 * 1024,
} as const;

// ------------------------------------------------------------------ the document

export const EASES = ["linear", "smooth", "in", "out", "hold"] as const;
export const DIRECTIONS = ["up", "down", "left", "right"] as const;
export const TRACK_KINDS = ["camera", "shake", "screen", "text", "actor", "audio", "world", "mark"] as const;
export const TRIGGER_KINDS = ["area", "map", "login", "quest_accept", "quest_complete", "npc"] as const;
const SCREEN_EFFECTS = ["fade", "flash", "tint", "vignette"] as const;
const TEXT_STYLES = ["title", "subtitle", "caption", "dialogue"] as const;
const MOVE_ANIMATIONS = ["walk", "mount_walk", "cast_walk"] as const;
const ACTOR_ANIMATIONS = ["idle", "walk", "cast_idle", "cast_walk", "mount_idle", "mount_walk"] as const;
const ACTOR_ACTIONS = ["move", "place", "face", "animate", "say", "show", "hide"] as const;
const WORLD_ACTIONS = ["weather", "time", "particles"] as const;
const AUDIO_BUSES = ["music", "effects"] as const;
const SPRITE_TYPES = ["animated", "static"] as const;
const LAYER_SLOTS = ["body", "head", "helmet", "shoulderguards", "neck", "hands", "chest", "feet", "legs", "weapon"] as const;

export type Ease = typeof EASES[number];
export type Dir = typeof DIRECTIONS[number];
export type TriggerKind = typeof TRIGGER_KINDS[number];
export type TrackKind = typeof TRACK_KINDS[number];

export interface CutsceneSettings {
  letterbox: boolean;
  /** 0 to 0.25 of the screen's height, each bar. */
  letterboxSize: number;
  hideHud: boolean;
  /** Other players. */
  hideOthers: boolean;
  /** The viewer's own character. */
  hideSelf: boolean;
  hideCreatures: boolean;
  skippable: boolean;
  /** Holds the player still and out of harm's way. */
  lock: boolean;
  worldVolume: number;
  fadeIn: number;
  fadeOut: number;
}

export type ActorLook =
  | { kind: "npc"; npcId: number }
  | { kind: "viewer" }
  | { kind: "layers"; sprite_type: "animated" | "static"; body: string | null; head: string | null; helmet: string | null;
      shoulderguards: string | null; neck: string | null; hands: string | null; chest: string | null; feet: string | null;
      legs: string | null; weapon: string | null };

export interface Actor {
  id: string;
  name: string;
  showName: boolean;
  look: ActorLook;
  x: number;
  y: number;
  direction: Dir;
  /** At the start of the scene. */
  visible: boolean;
  /** Filled in by the server when it resolves a document. Never stored. */
  sprite_type?: string;
  spriteLayers?: unknown;
}

export interface Item { id: string; t: number; d: number }
export interface CameraKey extends Item { x: number; y: number; zoom: number; ease: Ease; follow: string | null }
export interface ShakeClip extends Item { strength: number; speed: number }
export interface ScreenClip extends Item { effect: typeof SCREEN_EFFECTS[number]; color: string; amount: number; in: number; out: number }
export interface TextClip extends Item {
  style: typeof TEXT_STYLES[number]; text: string; sub: string; speaker: string; x: number; y: number;
  in: number; out: number; typewriter: number; color: string; size: number;
}
export type ActorItem = Item & (
  | { do: "move"; path: { x: number; y: number }[]; ease: Ease; animation: typeof MOVE_ANIMATIONS[number] }
  | { do: "place"; x: number; y: number; direction: Dir }
  | { do: "face"; direction: Dir }
  | { do: "animate"; animation: typeof ACTOR_ANIMATIONS[number] }
  | { do: "say"; text: string }
  | { do: "show" } | { do: "hide" }
);
export interface AudioClip extends Item {
  sound: string; bus: typeof AUDIO_BUSES[number]; volume: number; rate: number; loop: boolean; in: number; out: number;
}
export type WorldClip = Item & (
  | { do: "weather"; weather: string; weatherData?: unknown }
  | { do: "time"; from: number; to: number }
  | { do: "particles"; particle: string; x: number; y: number; particleData?: unknown }
);
export interface Mark extends Item { name: string }

interface TrackBase { id: string; label: string; muted?: boolean }
export type Track =
  | (TrackBase & { kind: "camera"; items: CameraKey[] })
  | (TrackBase & { kind: "shake"; items: ShakeClip[] })
  | (TrackBase & { kind: "screen"; items: ScreenClip[] })
  | (TrackBase & { kind: "text"; items: TextClip[] })
  | (TrackBase & { kind: "actor"; actor: string; items: ActorItem[] })
  | (TrackBase & { kind: "audio"; items: AudioClip[] })
  | (TrackBase & { kind: "world"; items: WorldClip[] })
  | (TrackBase & { kind: "mark"; items: Mark[] });

export interface Trigger {
  id: string;
  on: TriggerKind;
  /** Once per character, ever (the cutscene_views table). */
  once: boolean;
  /** 0 for none. */
  minLevel: number;
  /** An area trigger: a rectangle in world px on the scene's map. */
  x: number;
  y: number;
  w: number;
  h: number;
  questId: number | null;
  npcId: number | null;
}

export interface CutsceneDoc {
  name: string;
  description: string;
  map: string;
  duration: number;
  settings: CutsceneSettings;
  actors: Actor[];
  tracks: Track[];
  triggers: Trigger[];
  end: { teleport: { map: string; x: number; y: number } | null; next: string | null };
}

/** A scene as the cached list and the editor hold it: the document and who last saved it, and when. */
export type StoredCutscene = CutsceneDoc & { updatedBy: string | null; updatedAt: number };

export const DEFAULT_SETTINGS: CutsceneSettings = {
  letterbox: true, letterboxSize: 0.1, hideHud: true, hideOthers: false, hideSelf: false, hideCreatures: false,
  skippable: true, lock: true, worldVolume: 0.5, fadeIn: 0, fadeOut: 0,
};

// ------------------------------------------------------------------ what the checks know

/**
 * What there is to point a scene at. A document that names a map, an NPC, a weather, a particle, a sound, a quest or a
 * scene that is not here is refused; without this (a stored document being read again) only its shape is checked.
 */
export interface Known {
  /** Lower case to as written. */
  maps: Map<string, string>;
  npcs: Set<number>;
  weathers: Set<string>;
  particles: Set<string>;
  /** Null when the asset server did not answer: nothing can be said of a name then, and a save is not held up for it. */
  sounds: Set<string> | null;
  quests: Set<number>;
  /** Lower case names of the saved scenes. */
  scenes: Set<string>;
}

/** What is asked of the asset server, handed in by the tests. */
export interface AssetLists {
  /** The sound files by the name a Sound item keeps, null when the asset server does not answer. */
  sounds(): Promise<string[] | null>;
  /** The sprite sheets by slot, for dressing an actor by hand. */
  spriteSheets(): Promise<Record<string, SpriteSheetOption[]>>;
  /** The icons: an actor drawn as one picture is one of these. */
  icons(): Promise<SpriteSheetOption[]>;
}

const assetServer: AssetLists = {
  // Asked each time rather than held: a file added to the asset server is offered at the next list and can be saved.
  sounds: async () => {
    const assetServerUrl = process.env.ASSET_SERVER_INTERNAL_URL || process.env.ASSET_SERVER_URL;
    if (!assetServerUrl) return null;
    try {
      const response = await serverFetch(`${assetServerUrl}/audios`);
      if (!response.ok) throw new Error(`status ${response.status}`);
      const body = (await response.json()) as { audio?: Array<{ name: string }> };
      return (body?.audio ?? []).filter((a) => a?.name).map((a) => String(a.name));
    } catch (error) {
      log.warn(`Could not list sounds for the cutscene editor: ${(error as Error).message}`);
      return null;
    }
  },
  spriteSheets: async () => (await import("./creatures/editor")).listSpriteSheets(true),
  icons: async () => (await import("./creatures/editor")).listIcons(true),
};

/** The weather a scene may name besides the table's: it needs no row, as for /weather. */
export const CLEAR_WEATHER = "clear";

const lower = (value: unknown) => String(value ?? "").trim().toLowerCase();
/** A map's name as written everywhere in the engine: no ".json". */
export const bareMap = (map: unknown): string => String(map ?? "").trim().replace(/\.json$/i, "");
const sqlite = () => (process.env.DATABASE_ENGINE || "mysql") === "sqlite";

async function cached(key: string): Promise<any[]> {
  try {
    const list = await assetCache.get(key);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** The map names the engine has: the maps' properties, else the map list. */
async function mapNames(): Promise<string[]> {
  let names = (await cached("mapProperties")).map((m: any) => bareMap(m?.name)).filter(Boolean);
  if (names.length === 0) names = (await cached("maps")).map((m: any) => bareMap(m?.name)).filter(Boolean);
  return [...new Set(names)];
}

export async function buildKnown(assets: AssetLists = assetServer): Promise<Known> {
  const [maps, npcs, weather, particles, sounds, quests, scenes] = await Promise.all([
    mapNames(), cached("npcs"), cached("weather"), cached("particles"), assets.sounds(), cached("quests"), cached("cutscenes"),
  ]);
  const weathers = new Set<string>([CLEAR_WEATHER]);
  for (const w of weather) if (w?.name) weathers.add(String(w.name));
  return {
    maps: new Map(maps.map((m): [string, string] => [m.toLowerCase(), m])),
    npcs: new Set(npcs.filter((n: any) => n?.id !== null && n?.id !== undefined).map((n: any) => Number(n.id))),
    weathers,
    particles: new Set(particles.filter((p: any) => p?.name).map((p: any) => String(p.name))),
    sounds: sounds && new Set(sounds),
    quests: new Set(quests.filter((q: any) => q?.id !== null && q?.id !== undefined).map((q: any) => Number(q.id))),
    scenes: new Set(scenes.filter((s: any) => s?.name).map((s: any) => lower(s.name))),
  };
}

// -------------------------------------------------------------- permission

/**
 * Admins, and anyone holding the editor's permission, from the permissions copied to the player at login, as the mount
 * editor asks (mounteditor.ts). Asked on every packet, and of every other player when they are told to reload.
 */
export function canUseEditor(player: any): boolean {
  if (!player || player.isGuest) return false;
  if (player.isAdmin) return true;
  const held: string[] = Array.isArray(player.permissions) ? player.permissions : [];
  return held.some((p) => EDITOR_PERMISSIONS.includes(p));
}

/** The editor's permission, so it can be granted where the permissions are picked from a list. Never throws. */
export async function ensureCutsceneEditorPermission(): Promise<void> {
  try {
    await query(`INSERT ${sqlite() ? "OR IGNORE" : "IGNORE"} INTO permission_types (name) VALUES ('tools.cutscene_editor')`);
  } catch {
    // no permission_types table: nothing lists them
  }
}

// ------------------------------------------------------------------ checks

type Fields = Record<string, string>;
export type ReadResult = { ok: true; doc: CutsceneDoc } | { ok: false; errors: string[]; fields: Fields };

/** The fields of a document that are wrong, by their path ("tracks.3.items.2.t"), so the editor can point at them. */
class Check {
  readonly fields: Fields = {};
  private readonly paths = new Set<string>();
  /** The first complaint about a path is kept; past this many paths the rest only count. */
  static readonly KEPT = 200;

  /** How many fields are wrong: a field is counted once however many ways it is wrong. */
  get count(): number {
    return this.paths.size;
  }

  bad(path: string, message: string): void {
    if (this.paths.has(path)) return;
    this.paths.add(path);
    if (Object.keys(this.fields).length < Check.KEPT) this.fields[path] = message;
  }

  /** A number from `min` to `max`. A missing one is `fallback` when there is one. */
  num(path: string, value: unknown, min: number, max: number, options: { int?: boolean; fallback?: number } = {}): number {
    if (value === undefined && options.fallback !== undefined) return options.fallback;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.bad(path, "Enter a number.");
      return options.fallback ?? min;
    }
    if (options.int && !Number.isInteger(value)) {
      this.bad(path, "Enter a whole number.");
      return min;
    }
    if (value < min || value > max) {
      this.bad(path, `Enter a number from ${min} to ${max}.`);
      return min;
    }
    return value;
  }

  /** A world px coordinate. */
  coord(path: string, value: unknown, fallback?: number): number {
    return this.num(path, value, -LIMITS.coordinateMax, LIMITS.coordinateMax, { fallback });
  }

  bool(path: string, value: unknown, fallback?: boolean): boolean {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== "boolean") {
      this.bad(path, "Choose on or off.");
      return fallback ?? false;
    }
    return value;
  }

  /** Text of at most `max` characters; trimmed unless `keep`. A missing one is `fallback` when there is one. */
  str(path: string, value: unknown, max: number, options: { min?: number; keep?: boolean; fallback?: string } = {}): string {
    if (value === undefined && options.fallback !== undefined) return options.fallback;
    if (typeof value !== "string") {
      this.bad(path, "Enter some text.");
      return options.fallback ?? "";
    }
    const text = options.keep ? value : value.trim();
    if (text.length < (options.min ?? 0)) this.bad(path, options.min === 1 ? "Enter some text." : `Enter at least ${options.min} characters.`);
    else if (text.length > max) this.bad(path, `At most ${max} characters.`);
    return text;
  }

  /** One of `allowed`; anything else is refused (an unknown kind is never guessed at). */
  oneOf<T extends string>(path: string, value: unknown, allowed: readonly T[], fallback?: T): T {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
      this.bad(path, `Pick one of: ${allowed.join(", ")}.`);
      return fallback ?? allowed[0]!;
    }
    return value as T;
  }

  /** A colour as #rrggbb, in lower case. */
  color(path: string, value: unknown, fallback = "#000000"): string {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) {
      this.bad(path, "Pick a colour as #rrggbb.");
      return fallback;
    }
    return value.toLowerCase();
  }

  /** A list of at most `max`. Anything else is refused. */
  list(path: string, value: unknown, max: number, options: { min?: number } = {}): any[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      this.bad(path, "Expected a list.");
      return [];
    }
    if (value.length > max) {
      this.bad(path, `At most ${max} here.`);
      return value.slice(0, max);
    }
    if (value.length < (options.min ?? 0)) this.bad(path, `At least ${options.min} needed.`);
    return value;
  }

  /** A plain object; anything else is refused and read as empty. */
  obj(path: string, value: unknown): any {
    if (value === undefined || value === null) return {};
    if (typeof value !== "object" || Array.isArray(value)) {
      this.bad(path, "Expected an object.");
      return {};
    }
    return value;
  }

  /** An id: letters, digits, _ and -, at most `max` characters, and not one of `taken`. */
  id(path: string, value: unknown, max: number, taken: Set<string>): string {
    const id = this.str(path, value, max, { min: 1 });
    if (id && !/^[A-Za-z0-9_-]+$/.test(id)) this.bad(path, "Letters, digits, _ and - only.");
    else if (id && taken.has(id)) this.bad(path, `${id} is used twice.`);
    taken.add(id);
    return id;
  }
}

function readSettings(c: Check, raw: any): CutsceneSettings {
  const s = c.obj("settings", raw);
  const d = DEFAULT_SETTINGS;
  return {
    letterbox: c.bool("settings.letterbox", s.letterbox, d.letterbox),
    letterboxSize: c.num("settings.letterboxSize", s.letterboxSize, 0, LIMITS.letterboxSizeMax, { fallback: d.letterboxSize }),
    hideHud: c.bool("settings.hideHud", s.hideHud, d.hideHud),
    hideOthers: c.bool("settings.hideOthers", s.hideOthers, d.hideOthers),
    hideSelf: c.bool("settings.hideSelf", s.hideSelf, d.hideSelf),
    hideCreatures: c.bool("settings.hideCreatures", s.hideCreatures, d.hideCreatures),
    skippable: c.bool("settings.skippable", s.skippable, d.skippable),
    lock: c.bool("settings.lock", s.lock, d.lock),
    worldVolume: c.num("settings.worldVolume", s.worldVolume, 0, 1, { fallback: d.worldVolume }),
    fadeIn: c.num("settings.fadeIn", s.fadeIn, 0, LIMITS.fadeMax, { fallback: d.fadeIn }),
    fadeOut: c.num("settings.fadeOut", s.fadeOut, 0, LIMITS.fadeMax, { fallback: d.fadeOut }),
  };
}

function readLook(c: Check, path: string, raw: any, known: Known | undefined): ActorLook {
  const look = c.obj(path, raw);
  const kind = c.oneOf(`${path}.kind`, look.kind, ["npc", "viewer", "layers"] as const);
  if (kind === "viewer") return { kind };
  if (kind === "npc") {
    const npcId = c.num(`${path}.npcId`, look.npcId, 0, Number.MAX_SAFE_INTEGER, { int: true });
    if (known && !known.npcs.has(npcId)) c.bad(`${path}.npcId`, `There is no NPC ${npcId}.`);
    return { kind, npcId };
  }
  const slot = (name: typeof LAYER_SLOTS[number]): string | null => {
    const value = look[name];
    if (value === undefined || value === null || value === "") return null;
    return c.str(`${path}.${name}`, value, LIMITS.layerNameMax) || null;
  };
  return {
    kind, sprite_type: c.oneOf(`${path}.sprite_type`, look.sprite_type, SPRITE_TYPES),
    body: slot("body"), head: slot("head"), helmet: slot("helmet"), shoulderguards: slot("shoulderguards"), neck: slot("neck"),
    hands: slot("hands"), chest: slot("chest"), feet: slot("feet"), legs: slot("legs"), weapon: slot("weapon"),
  };
}

function readActors(c: Check, raw: unknown, known: Known | undefined): Actor[] {
  const ids = new Set<string>();
  return c.list("actors", raw, LIMITS.actorsMax).map((entry, i): Actor => {
    const path = `actors.${i}`;
    const a = c.obj(path, entry);
    const id = c.id(`${path}.id`, a.id, LIMITS.actorIdMax, ids);
    // "viewer" names the viewer's own character in a camera's follow: an actor of that id would be taken for it.
    if (id === "viewer") c.bad(`${path}.id`, "viewer is not a name an actor can have.");
    return {
      id,
      name: c.str(`${path}.name`, a.name, LIMITS.actorNameMax, { fallback: "" }),
      showName: c.bool(`${path}.showName`, a.showName, false),
      look: readLook(c, `${path}.look`, a.look, known),
      x: c.coord(`${path}.x`, a.x),
      y: c.coord(`${path}.y`, a.y),
      direction: c.oneOf(`${path}.direction`, a.direction, DIRECTIONS, "down"),
      visible: c.bool(`${path}.visible`, a.visible, true),
    };
  });
}

/** What reading the tracks needs of the rest of the document. */
interface TrackContext {
  duration: number;
  actorIds: Set<string>;
  itemIds: Set<string>;
  known: Known | undefined;
}

/** The part of an item every kind has: its id and where it sits on the timeline. `point`: it has no length. */
function readItemBase(c: Check, path: string, raw: any, ctx: TrackContext, point: boolean): Item {
  return {
    id: c.id(`${path}.id`, raw.id, LIMITS.idMax, ctx.itemIds),
    t: c.num(`${path}.t`, raw.t, 0, ctx.duration),
    d: point ? 0 : c.num(`${path}.d`, raw.d, 0, ctx.duration, { fallback: 0 }),
  };
}

function readActorItem(c: Check, path: string, raw: any, ctx: TrackContext): ActorItem {
  const action = c.oneOf(`${path}.do`, raw.do, ACTOR_ACTIONS);
  // Placing, facing, showing and hiding happen at a moment; a move, an animation and a bubble last.
  const base = readItemBase(c, path, raw, ctx, action === "place" || action === "face" || action === "show" || action === "hide");
  // An action that is not one is said once: reading the rest as a move would only add complaints about fields it never had.
  if (!(ACTOR_ACTIONS as readonly string[]).includes(raw.do)) return { ...base, do: action } as ActorItem;
  switch (action) {
    case "move": {
      const points = c.list(`${path}.path`, raw.path, LIMITS.pathPointsMax, { min: 1 });
      if (raw.path === undefined) c.bad(`${path}.path`, "A move needs a path.");
      return {
        ...base, do: action,
        path: points.map((point, p) => {
          const at = c.obj(`${path}.path.${p}`, point);
          return { x: c.coord(`${path}.path.${p}.x`, at.x), y: c.coord(`${path}.path.${p}.y`, at.y) };
        }),
        ease: c.oneOf(`${path}.ease`, raw.ease, EASES, "linear"),
        animation: c.oneOf(`${path}.animation`, raw.animation, MOVE_ANIMATIONS, "walk"),
      };
    }
    case "place":
      return { ...base, do: action, x: c.coord(`${path}.x`, raw.x), y: c.coord(`${path}.y`, raw.y), direction: c.oneOf(`${path}.direction`, raw.direction, DIRECTIONS, "down") };
    case "face":
      return { ...base, do: action, direction: c.oneOf(`${path}.direction`, raw.direction, DIRECTIONS) };
    case "animate":
      return { ...base, do: action, animation: c.oneOf(`${path}.animation`, raw.animation, ACTOR_ANIMATIONS) };
    case "say":
      return { ...base, do: action, text: c.str(`${path}.text`, raw.text, LIMITS.sayMax, { min: 1, keep: true }) };
    case "show":
    case "hide":
      return { ...base, do: action };
  }
}

function readWorldClip(c: Check, path: string, raw: any, ctx: TrackContext): WorldClip {
  const action = c.oneOf(`${path}.do`, raw.do, WORLD_ACTIONS);
  const base = readItemBase(c, path, raw, ctx, false);
  if (!(WORLD_ACTIONS as readonly string[]).includes(raw.do)) return { ...base, do: action } as WorldClip;
  switch (action) {
    case "weather": {
      const weather = c.str(`${path}.weather`, raw.weather, LIMITS.referenceMax, { min: 1 });
      if (weather && ctx.known && !ctx.known.weathers.has(weather)) c.bad(`${path}.weather`, `There is no weather ${weather}.`);
      return { ...base, do: action, weather };
    }
    case "time":
      return { ...base, do: action, from: c.num(`${path}.from`, raw.from, 0, 24), to: c.num(`${path}.to`, raw.to, 0, 24) };
    case "particles": {
      const particle = c.str(`${path}.particle`, raw.particle, LIMITS.referenceMax, { min: 1 });
      if (particle && ctx.known && !ctx.known.particles.has(particle)) c.bad(`${path}.particle`, `There is no particle ${particle}.`);
      return { ...base, do: action, particle, x: c.coord(`${path}.x`, raw.x), y: c.coord(`${path}.y`, raw.y) };
    }
  }
}

/** One item of a track of `kind`. Fields the kind does not have are left out. */
function readItem(c: Check, path: string, kind: TrackKind, entry: unknown, ctx: TrackContext): Item {
  const raw = c.obj(path, entry);
  switch (kind) {
    case "camera": {
      const follow = raw.follow === undefined || raw.follow === null ? null : c.str(`${path}.follow`, raw.follow, LIMITS.actorIdMax);
      if (follow !== null && follow !== "viewer" && !ctx.actorIds.has(follow)) c.bad(`${path}.follow`, `There is no actor ${follow}.`);
      return {
        ...readItemBase(c, path, raw, ctx, true),
        x: c.coord(`${path}.x`, raw.x), y: c.coord(`${path}.y`, raw.y),
        zoom: c.num(`${path}.zoom`, raw.zoom, 1, 3),
        ease: c.oneOf(`${path}.ease`, raw.ease, EASES, "smooth"),
        follow,
      } as CameraKey;
    }
    case "shake":
      return {
        ...readItemBase(c, path, raw, ctx, false),
        strength: c.num(`${path}.strength`, raw.strength, 0, 64), speed: c.num(`${path}.speed`, raw.speed, 1, 60),
      } as ShakeClip;
    case "screen":
      return {
        ...readItemBase(c, path, raw, ctx, false),
        effect: c.oneOf(`${path}.effect`, raw.effect, SCREEN_EFFECTS),
        color: c.color(`${path}.color`, raw.color),
        amount: c.num(`${path}.amount`, raw.amount, 0, 1),
        in: c.num(`${path}.in`, raw.in, 0, LIMITS.durationMax, { fallback: 0 }),
        out: c.num(`${path}.out`, raw.out, 0, LIMITS.durationMax, { fallback: 0 }),
      } as ScreenClip;
    case "text":
      return {
        ...readItemBase(c, path, raw, ctx, false),
        style: c.oneOf(`${path}.style`, raw.style, TEXT_STYLES),
        text: c.str(`${path}.text`, raw.text, LIMITS.textMax, { keep: true, fallback: "" }),
        sub: c.str(`${path}.sub`, raw.sub, LIMITS.subMax, { keep: true, fallback: "" }),
        speaker: c.str(`${path}.speaker`, raw.speaker, LIMITS.speakerMax, { fallback: "" }),
        x: c.num(`${path}.x`, raw.x, 0, 1, { fallback: 0.5 }), y: c.num(`${path}.y`, raw.y, 0, 1, { fallback: 0.8 }),
        in: c.num(`${path}.in`, raw.in, 0, LIMITS.durationMax, { fallback: 0 }),
        out: c.num(`${path}.out`, raw.out, 0, LIMITS.durationMax, { fallback: 0 }),
        typewriter: c.num(`${path}.typewriter`, raw.typewriter, 0, 120, { fallback: 0 }),
        color: c.color(`${path}.color`, raw.color, "#ffffff"),
        size: c.num(`${path}.size`, raw.size, 0.5, 3, { fallback: 1 }),
      } as TextClip;
    case "actor":
      return readActorItem(c, path, raw, ctx);
    case "audio": {
      const sound = c.str(`${path}.sound`, raw.sound, LIMITS.soundMax, { min: 1 });
      if (sound && ctx.known?.sounds && !ctx.known.sounds.has(sound)) c.bad(`${path}.sound`, `There is no sound ${sound}.`);
      return {
        ...readItemBase(c, path, raw, ctx, false),
        sound, bus: c.oneOf(`${path}.bus`, raw.bus, AUDIO_BUSES, "effects"),
        volume: c.num(`${path}.volume`, raw.volume, 0, 1, { fallback: 1 }),
        rate: c.num(`${path}.rate`, raw.rate, 0.25, 4, { fallback: 1 }),
        loop: c.bool(`${path}.loop`, raw.loop, false),
        in: c.num(`${path}.in`, raw.in, 0, LIMITS.durationMax, { fallback: 0 }),
        out: c.num(`${path}.out`, raw.out, 0, LIMITS.durationMax, { fallback: 0 }),
      } as AudioClip;
    }
    case "world":
      return readWorldClip(c, path, raw, ctx);
    case "mark":
      return { ...readItemBase(c, path, raw, ctx, true), name: c.str(`${path}.name`, raw.name, LIMITS.markNameMax, { min: 1 }) } as Mark;
  }
}

function readTracks(c: Check, raw: unknown, duration: number, actors: Actor[], known: Known | undefined): Track[] {
  const trackIds = new Set<string>();
  const ctx: TrackContext = { duration, actorIds: new Set(actors.map((a) => a.id)), itemIds: new Set(), known };
  let total = 0;
  return c.list("tracks", raw, LIMITS.tracksMax).map((entry, i): Track => {
    const path = `tracks.${i}`;
    const t = c.obj(path, entry);
    const kind = c.oneOf(`${path}.kind`, t.kind, TRACK_KINDS);
    const kindIsKnown = (TRACK_KINDS as readonly string[]).includes(t.kind);
    const out: any = {
      id: c.id(`${path}.id`, t.id, LIMITS.idMax, trackIds),
      kind,
      label: c.str(`${path}.label`, t.label, LIMITS.labelMax, { fallback: "" }),
    };
    if (t.muted !== undefined && c.bool(`${path}.muted`, t.muted)) out.muted = true;
    if (kind === "actor") {
      // The track is the actor's: one that points at nothing would move nobody.
      out.actor = c.str(`${path}.actor`, t.actor, LIMITS.actorIdMax, { min: 1 });
      if (out.actor && !ctx.actorIds.has(out.actor)) c.bad(`${path}.actor`, `There is no actor ${out.actor}.`);
    }
    const items = c.list(`${path}.items`, t.items, LIMITS.itemsPerTrackMax);
    total += items.length;
    if (total > LIMITS.itemsPerDocMax && total - items.length <= LIMITS.itemsPerDocMax) c.bad("tracks", `A scene holds ${LIMITS.itemsPerDocMax} items at most.`);
    // A kind that is not one is said once, not once for every item read as if it were a camera.
    out.items = kindIsKnown ? items.map((item, n) => readItem(c, `${path}.items.${n}`, kind, item, ctx)) : [];
    return out as Track;
  });
}

function readTriggers(c: Check, raw: unknown, known: Known | undefined): Trigger[] {
  const ids = new Set<string>();
  return c.list("triggers", raw, LIMITS.triggersMax).map((entry, i): Trigger => {
    const path = `triggers.${i}`;
    const t = c.obj(path, entry);
    const on = c.oneOf(`${path}.on`, t.on, TRIGGER_KINDS);
    const area = on === "area";
    const questId = on === "quest_accept" || on === "quest_complete"
      ? c.num(`${path}.questId`, t.questId, 0, Number.MAX_SAFE_INTEGER, { int: true })
      : null;
    if (questId !== null && known && !known.quests.has(questId)) c.bad(`${path}.questId`, `There is no quest ${questId}.`);
    const npcId = on === "npc" ? c.num(`${path}.npcId`, t.npcId, 0, Number.MAX_SAFE_INTEGER, { int: true }) : null;
    if (npcId !== null && known && !known.npcs.has(npcId)) c.bad(`${path}.npcId`, `There is no NPC ${npcId}.`);
    const trigger: Trigger = {
      id: c.id(`${path}.id`, t.id, LIMITS.idMax, ids),
      on,
      once: c.bool(`${path}.once`, t.once, false),
      minLevel: c.num(`${path}.minLevel`, t.minLevel, 0, LIMITS.minLevelMax, { int: true, fallback: 0 }),
      x: area ? c.coord(`${path}.x`, t.x) : 0,
      y: area ? c.coord(`${path}.y`, t.y) : 0,
      w: area ? c.num(`${path}.w`, t.w, 0, LIMITS.coordinateMax) : 0,
      h: area ? c.num(`${path}.h`, t.h, 0, LIMITS.coordinateMax) : 0,
      questId, npcId,
    };
    if (area && trigger.w <= 0) c.bad(`${path}.w`, "An area needs a width.");
    if (area && trigger.h <= 0) c.bad(`${path}.h`, "An area needs a height.");
    return trigger;
  });
}

function readEnd(c: Check, raw: unknown, ownName: string, known: Known | undefined): CutsceneDoc["end"] {
  const end = c.obj("end", raw);
  let teleport: CutsceneDoc["end"]["teleport"] = null;
  if (end.teleport !== undefined && end.teleport !== null) {
    const at = c.obj("end.teleport", end.teleport);
    const map = bareMap(c.str("end.teleport.map", at.map, LIMITS.mapMax, { min: 1 }));
    const canonical = known?.maps.get(map.toLowerCase());
    if (known && map && !canonical) c.bad("end.teleport.map", `There is no map ${map}.`);
    teleport = { map: canonical ?? map, x: c.coord("end.teleport.x", at.x), y: c.coord("end.teleport.y", at.y) };
  }
  let next: string | null = null;
  if (end.next !== undefined && end.next !== null && end.next !== "") {
    next = c.str("end.next", end.next, LIMITS.nameMax, { min: 1 });
    if (next && lower(next) === lower(ownName)) c.bad("end.next", "A scene cannot continue into itself.");
    else if (next && known && !known.scenes.has(lower(next))) c.bad("end.next", `There is no scene called ${next}.`);
  }
  return { teleport, next };
}

/**
 * The scene an editor sent, or which fields are wrong. `originalName` is the saved scene being changed, or null for a
 * new one; `existing` is every scene there is. Every field is checked and the document is built again from the ones
 * that are known: a field this does not know is dropped, a kind it does not know is refused, a number is refused unless
 * it is finite and inside its bounds. `known` (see Known) adds the check that what the scene points at is there.
 */
export function readCutscene(raw: any, originalName: string | null, existing: Array<{ name: string }>, known?: Known): ReadResult {
  const c = new Check();
  const input = c.obj("doc", raw);

  // A saved scene keeps its name, whatever was sent.
  const name = originalName ?? String(input.name ?? "").trim();
  if (originalName === null) {
    if (!name) c.bad("name", "Enter a name.");
    else if (name.length > LIMITS.nameMax) c.bad("name", `A name is ${LIMITS.nameMax} characters at most.`);
    else if (!/^[A-Za-z0-9 _-]+$/.test(name)) c.bad("name", "A name holds letters, digits, spaces, _ and - only.");
    else if (existing.some((s) => lower(s.name) === lower(name))) c.bad("name", `There is already a scene called ${name}.`);
  }

  const description = c.str("description", input.description, LIMITS.descriptionMax, { fallback: "" });

  const mapText = bareMap(c.str("map", input.map, LIMITS.mapMax, { min: 1 }));
  const canonicalMap = known?.maps.get(mapText.toLowerCase());
  if (known && mapText && !canonicalMap) c.bad("map", `There is no map ${mapText}.`);

  const wrongBefore = c.count;
  const duration = c.num("duration", input.duration, LIMITS.durationMin, LIMITS.durationMax);
  // A duration that is wrong does not make every time on the timeline wrong with it: they are held to the longest there is.
  const timeline = c.count === wrongBefore ? duration : LIMITS.durationMax;
  const settings = readSettings(c, input.settings);
  const actors = readActors(c, input.actors, known);
  const tracks = readTracks(c, input.tracks, timeline, actors, known);
  const triggers = readTriggers(c, input.triggers, known);
  const end = readEnd(c, input.end, name, known);

  if (c.count > 0) {
    const wrong = c.count;
    return { ok: false, errors: [wrong === 1 ? "1 field needs fixing." : `${wrong} fields need fixing.`], fields: c.fields };
  }
  const doc: CutsceneDoc = { name, description, map: canonicalMap ?? mapText, duration, settings, actors, tracks, triggers, end };
  const bytes = Buffer.byteLength(JSON.stringify(doc));
  if (bytes > LIMITS.docBytes) {
    return { ok: false, errors: ["The scene is too large to store."], fields: { doc: `A scene is ${Math.floor(LIMITS.docBytes / 1024)} KB at most; this one is ${Math.ceil(bytes / 1024)} KB.` } };
  }
  return { ok: true, doc };
}

// ------------------------------------------------------------------- table

export const CUTSCENES_TABLE: Record<"mysql" | "sqlite", string> = {
  mysql: `CREATE TABLE IF NOT EXISTS cutscenes (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(64) NOT NULL UNIQUE,
    data MEDIUMTEXT NOT NULL,
    updated_by VARCHAR(255) NULL,
    updated_at BIGINT NOT NULL DEFAULT 0
  )`,
  sqlite: `CREATE TABLE IF NOT EXISTS cutscenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE NOT NULL,
    name TEXT NOT NULL UNIQUE,
    data TEXT NOT NULL,
    updated_by TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`,
};

export const CUTSCENE_VIEWS_TABLE: Record<"mysql" | "sqlite", string> = {
  mysql: `CREATE TABLE IF NOT EXISTS cutscene_views (
    username VARCHAR(255) NOT NULL,
    cutscene VARCHAR(64) NOT NULL,
    seen_at BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (username, cutscene)
  )`,
  sqlite: `CREATE TABLE IF NOT EXISTS cutscene_views (
    username TEXT NOT NULL,
    cutscene TEXT NOT NULL,
    seen_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (username, cutscene)
  )`,
};

/** A stored row as a scene, or null when it cannot be read (it is left out of the list, and said once). */
function fromRow(row: any): StoredCutscene | null {
  try {
    const name = String(row?.name ?? "");
    const read = readCutscene(JSON.parse(String(row?.data ?? "")), name, []);
    if (!read.ok) {
      log.warn(`[Cutscenes] The scene ${name} is stored in a form that cannot be read (${Object.keys(read.fields).slice(0, 3).join(", ")}), so it is left out.`);
      return null;
    }
    return { ...read.doc, updatedBy: row?.updated_by ?? null, updatedAt: Number(row?.updated_at) || 0 };
  } catch (error) {
    log.warn(`[Cutscenes] The scene ${row?.name} could not be read, so it is left out: ${error}`);
    return null;
  }
}

/** Every scene in the table. Throws when there is no table: the caller decides what that means. */
export async function readTable(): Promise<StoredCutscene[]> {
  const rows = ((await query("SELECT name, data, updated_by, updated_at FROM cutscenes")) || []) as any[];
  return Array.from(rows, fromRow).filter((s): s is StoredCutscene => s !== null);
}

/**
 * Start-time safety step: makes the two tables on a database whose setup ran before they were added, then reads the
 * scenes into the cache (the first read, at the asset load, found no table). Safe on every start, and never throws:
 * without the tables there are no scenes, and a save is refused with the reason in the log.
 */
export async function ensureCutsceneSchema(): Promise<boolean> {
  try {
    await query(CUTSCENES_TABLE[sqlite() ? "sqlite" : "mysql"]);
    await query(CUTSCENE_VIEWS_TABLE[sqlite() ? "sqlite" : "mysql"]);
  } catch (error) {
    log.warn(`[Cutscenes] The cutscenes tables could not be made, so there are no cutscenes: ${error}`);
    return false;
  }
  try {
    await assetCache.set("cutscenes", await readTable());
  } catch (error) {
    log.warn(`[Cutscenes] The cutscenes could not be read: ${error}`);
    return false;
  }
  return true;
}

/** The scenes held: every row of the table, read at startup and kept in step by each write of it. */
export async function allScenes(): Promise<StoredCutscene[]> {
  const list = await assetCache.get("cutscenes");
  return (Array.isArray(list) ? list : []) as StoredCutscene[];
}

/** The scene of that name (any case), or nothing. */
export async function findScene(name: unknown): Promise<StoredCutscene | undefined> {
  const wanted = lower(name);
  if (!wanted) return undefined;
  return (await allScenes()).find((s) => lower(s.name) === wanted);
}

/**
 * A statement that changes the cutscenes table. One that throws may still have been applied (a timeout, say), so the
 * table is read again: what is held is then what the database holds, not what it held before.
 */
async function write(sql: string, values: any[]): Promise<any> {
  try {
    return await query(sql, values);
  } catch (error) {
    try {
      await assetCache.set("cutscenes", await readTable());
    } catch (again) {
      log.error(`[Cutscenes] Could not read the scenes again after a write that failed: ${again}`);
    }
    throw error;
  }
}

/** Writes a checked scene, new or changed, and keeps the cached list in step. */
export async function saveScene(doc: CutsceneDoc, by: string, exists: boolean): Promise<StoredCutscene> {
  const stored: StoredCutscene = { ...doc, updatedBy: by, updatedAt: Date.now() };
  const json = JSON.stringify(doc);
  if (exists) {
    await write("UPDATE cutscenes SET data = ?, updated_by = ?, updated_at = ? WHERE name = ?", [json, by, stored.updatedAt, doc.name]);
  } else {
    await write("INSERT INTO cutscenes (name, data, updated_by, updated_at) VALUES (?, ?, ?, ?)", [doc.name, json, by, stored.updatedAt]);
  }
  const all = await allScenes();
  await assetCache.set("cutscenes", exists
    ? all.map((s) => (lower(s.name) === lower(doc.name) ? stored : s))
    : [...all, stored]);
  return stored;
}

/**
 * Deletes a scene, and the record of who has seen it: a scene made again under the name is new to everyone. The scenes
 * that went on to it end instead: readCutscene refuses a `next` that names no scene, so one left pointing here could
 * not be saved again until someone found out why. They are written as `by` changing them. Returns their names.
 */
export async function removeScene(scene: { name: string }, by: string): Promise<string[]> {
  await write("DELETE FROM cutscenes WHERE name = ?", [scene.name]);
  try {
    await query("DELETE FROM cutscene_views WHERE cutscene = ?", [scene.name]);
  } catch (error) {
    log.warn(`[Cutscenes] The views of ${scene.name} could not be cleared: ${error}`);
  }
  await assetCache.set("cutscenes", (await allScenes()).filter((s) => lower(s.name) !== lower(scene.name)));

  const changed: string[] = [];
  for (const other of await allScenes()) {
    if (lower(other.end.next) !== lower(scene.name)) continue;
    const { updatedBy: _by, updatedAt: _at, ...doc } = other;
    try {
      await saveScene({ ...doc, end: { ...doc.end, next: null } }, by, true);
      changed.push(other.name);
    } catch (error) {
      log.warn(`[Cutscenes] ${other.name} still goes on to ${scene.name}, which is gone: ${error}`);
    }
  }
  return changed;
}

// ----------------------------------------------------------------- resolving

/**
 * The document with what the server fills in: an actor drawn as an NPC or from layers gets its sprite type and layers
 * (as an NPC is sent to the client, getNpcSpriteLayers), a weather clip the weather's values (what CHANGE_WEATHER
 * carries as weatherData) and a particle clip the particle. A reference that is gone is left without its data and
 * the client draws nothing for it. A copy: the cached scene is never changed.
 */
export async function resolveDoc<T extends CutsceneDoc>(doc: T): Promise<T> {
  const out = structuredClone(doc);
  const [npcs, weather, particles] = await Promise.all([cached("npcs"), cached("weather"), cached("particles")]);

  for (const actor of out.actors) {
    const look = actor.look;
    if (look.kind === "npc") {
      const row = npcs.find((n: any) => Number(n?.id) === look.npcId);
      if (!row) continue;
      actor.sprite_type = String(row.sprite_type || "animated");
      actor.spriteLayers = getNpcSpriteLayers(row);
    } else if (look.kind === "layers") {
      actor.sprite_type = look.sprite_type;
      actor.spriteLayers = getNpcSpriteLayers({
        sprite_type: look.sprite_type, sprite_body: look.body, sprite_head: look.head, sprite_helmet: look.helmet,
        sprite_shoulderguards: look.shoulderguards, sprite_neck: look.neck, sprite_hands: look.hands, sprite_chest: look.chest,
        sprite_feet: look.feet, sprite_legs: look.legs, sprite_weapon: look.weapon,
      });
    }
  }

  for (const track of out.tracks) {
    if (track.kind !== "world") continue;
    for (const clip of track.items) {
      if (clip.do === "weather") {
        const row = weather.find((w: any) => w?.name === clip.weather);
        // "clear" needs no row: with none it is drawn from no values at all.
        if (row) clip.weatherData = row;
        else if (clip.weather === CLEAR_WEATHER) clip.weatherData = null;
      } else if (clip.do === "particles") {
        const row = particles.find((p: any) => p?.name === clip.particle);
        if (row) clip.particleData = row;
      }
    }
  }
  return out;
}

/** What CUTSCENE_PLAY carries: the resolved document without its triggers, which are the server's business. */
export async function resolveForPlay(doc: CutsceneDoc): Promise<Omit<CutsceneDoc, "triggers">> {
  const resolved: Partial<CutsceneDoc> = await resolveDoc(doc);
  delete resolved.triggers;
  return resolved as Omit<CutsceneDoc, "triggers">;
}

// ------------------------------------------------------------------ editor

export interface EditorData {
  cutscenes: StoredCutscene[];
  npcs: Array<{ id: number; name: string; map: string }>;
  weathers: string[];
  particles: string[];
  sounds: string[];
  quests: Array<{ id: number; name: string }>;
  maps: string[];
  spriteSheets: Record<string, SpriteSheetOption[]>;
  icons: SpriteSheetOption[];
  limits: typeof LIMITS;
}

export async function buildEditorData(assets: AssetLists = assetServer): Promise<EditorData> {
  const [scenes, npcs, weather, particles, sounds, quests, maps, spriteSheets, icons] = await Promise.all([
    allScenes(), cached("npcs"), cached("weather"), cached("particles"), assets.sounds(), cached("quests"), mapNames(), assets.spriteSheets(), assets.icons(),
  ]);
  const names = (list: any[]) => [...new Set(list.filter((x) => x?.name).map((x) => String(x.name)))].sort((a, b) => a.localeCompare(b));
  return {
    cutscenes: [...scenes].sort((a, b) => a.name.localeCompare(b.name)),
    // The maps' particle emitters are NPCs too, in their tens of thousands, with nothing to draw or to talk to.
    npcs: npcs
      .filter((n: any) => n?.id !== null && n?.id !== undefined && n.sprite_type !== "none")
      .map((n: any) => ({ id: Number(n.id), name: String(n.name ?? `#${n.id}`), map: bareMap(n.map) }))
      .sort((a, b) => a.id - b.id),
    weathers: [...new Set([CLEAR_WEATHER, ...names(weather)])],
    particles: names(particles),
    sounds: [...new Set(sounds ?? [])].sort((a, b) => a.localeCompare(b)),
    quests: quests
      .filter((q: any) => q?.id !== null && q?.id !== undefined)
      .map((q: any) => ({ id: Number(q.id), name: String(q.name ?? `#${q.id}`) }))
      .sort((a, b) => a.id - b.id),
    maps: maps.sort((a, b) => a.localeCompare(b)),
    spriteSheets,
    icons,
    limits: LIMITS,
  };
}

export type EditorAnswer =
  | { kind: "data"; data: EditorData }
  | { kind: "resolved"; doc: CutsceneDoc }
  | {
    kind: "result"; ok: boolean; errors: string[]; fields?: Record<string, string>; name: string | null;
    denied?: boolean;
    /** The scene as it was stored, after a save. */
    doc?: StoredCutscene;
    /** The scenes changed: the other open editors are told. */
    changed?: boolean;
  };

/** One packet of the editor. Permission is checked first, on every one. */
export async function handleEditorPacket(admin: any, type: string, data: any, assets: AssetLists = assetServer): Promise<EditorAnswer> {
  if (!canUseEditor(admin)) return { kind: "result", ok: false, errors: [DENIED], name: null, denied: true };
  if (type === "CUTSCENE_EDITOR_LIST") return { kind: "data", data: await buildEditorData(assets) };

  const all = await allScenes();
  const known = await buildKnown(assets);

  if (type === "CUTSCENE_EDITOR_RESOLVE") {
    // A scene being worked on, saved or not: checked as a save would check it, and resolved for the preview.
    const named = data?.doc?.name;
    const saved = named ? all.find((s) => lower(s.name) === lower(named)) : undefined;
    const read = readCutscene(data?.doc, saved?.name ?? null, all, known);
    if (!read.ok) return { kind: "result", ok: false, errors: read.errors, fields: read.fields, name: saved?.name ?? null };
    return { kind: "resolved", doc: await resolveDoc(read.doc) };
  }

  const wanted = String(data?.originalName ?? "").trim();
  const existing = wanted ? all.find((s) => lower(s.name) === lower(wanted)) ?? null : null;
  const refused = (errors: string[], fields?: Record<string, string>): EditorAnswer =>
    ({ kind: "result", ok: false, errors, fields, name: existing?.name ?? null });
  if (wanted && !existing) return refused([`There is no scene called ${wanted} any more.`]);

  if (type === "CUTSCENE_EDITOR_SAVE") {
    const read = readCutscene(data?.doc, existing?.name ?? null, all, known);
    if (!read.ok) return refused(read.errors, read.fields);
    let stored: StoredCutscene;
    try {
      stored = await saveScene(read.doc, String(admin.username), !!existing);
    } catch (error) {
      log.error(`[Cutscenes] ${admin.username} could not save scene ${read.doc.name}: ${error}`);
      return refused(["The scene could not be saved. The server log says why."]);
    }
    log.info(`[Cutscenes] ${admin.username} ${existing ? "changed" : "added"} scene ${stored.name}.`);
    return { kind: "result", ok: true, errors: [], name: stored.name, doc: stored, changed: true };
  }

  if (type === "CUTSCENE_EDITOR_DELETE") {
    if (!existing) return refused(["Pick a scene."]);
    let ended: string[];
    try {
      ended = await removeScene(existing, String(admin.username));
    } catch (error) {
      log.error(`[Cutscenes] ${admin.username} could not delete scene ${existing.name}: ${error}`);
      return refused(["The scene could not be deleted. The server log says why."]);
    }
    log.info(`[Cutscenes] ${admin.username} deleted scene ${existing.name}${ended.length ? `, so ${ended.join(", ")} now end there` : ""}.`);
    return { kind: "result", ok: true, errors: [], name: existing.name, changed: true };
  }

  return refused([`Unknown request ${type}.`]);
}
