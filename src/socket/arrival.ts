import { ARRIVAL_TTL_MS } from "../cluster/handoff";
import { bareMapName } from "../cluster/handoffwatch";
import type { LinkContext } from "../cluster/linkhooks";
import log from "../modules/logger";
import cooldownManager from "../services/cooldownmanager";
import effectManager from "../services/effectmanager";
import { CONSUMABLE_COOLDOWN_MS, setReadyIn as setConsumableReadyIn } from "../systems/consumables";
import type { CarriedChain, CarriedScene } from "../systems/cutsceneplayer";
import { rememberSicknessGiven, sicknessDurationMs, saveOnDisconnect as saveSickness, type SicknessGiven } from "../systems/resurrection";
import { defOf } from "../systems/gamesettings/registry";
import { STAT_INT_MAX } from "../systems/creatures/remotereward";
import { WARP_COOLDOWN_MS, setWarpReadyIn } from "../systems/warpcooldown";

export interface HandoffState {
  dots: any[];
  barriers: any[];
  stuns: any[];
  slows: any[];
  cooldowns: Record<string, number>;
  lockoutMs: number;
  sickUntil: number;
  /** What the sickness was given with on the node it came from; absent when it came without. */
  sickGiven?: SicknessGiven;
  deadState: 0 | 1 | 2;
  corpse: { map: string; x: number; y: number } | null;
  combat: boolean;
  lastAttackAgoMs: number | null;
  mounted: boolean;
  mount_type: string | null;
  /** The shared consumable cooldown left (ms, 0 when ready), at most a full cooldown. */
  consumableReadyIn: number;
  /** The warp cooldown left (ms, 0 when ready), at most a full cooldown. */
  warpReadyIn: number;
  /** The direction the player was walking when handed off (one of the eight), or null: the arrival goes on walking. */
  walk: string | null;
  /** How long the walk had stood still on the old node when the final snapshot was taken (ms, 0 when not walking). */
  walkIdleMs: number;
  /** The cutscene the player is watching, or null: it goes on here (cutsceneplayer.ts adopt). */
  cutscene: CarriedScene | null;
  /** The chain of cutscenes that moved the player here, or null: its next scene begins here (adoptChain). */
  cutsceneChain: CarriedChain | null;
}

/** The directions a MOVEXY names (the same eight as VALID_DIRECTIONS in receiver.ts), as the walk of an arrival may be. */
export const WALK_DIRECTIONS: ReadonlySet<string> = new Set(["up", "down", "left", "right", "upleft", "upright", "downleft", "downright"]);

export function walkOf(p: any): string | null {
  if (p?.moving !== true || p.isDead) return null;
  const direction = String(p._movementState?.targetDirection ?? p.location?.position?.direction ?? "").toLowerCase();
  return WALK_DIRECTIONS.has(direction) ? direction : null;
}

export function walkIdleMsOf(p: any, now = performance.now()): number {
  if (!walkOf(p) || typeof p._lastStepAt !== "number") return 0;
  return Math.max(0, Math.round(now - p._lastStepAt));
}

/** The longest standstill a resumed walk makes up. Longer, and the client has been told where the player stands since. */
export const MAX_RESUME_CATCH_UP_MS = 500;

/** What the resumed walk of an arrival makes up (receiver.ts sets it, the first MOVEXY of the connection takes it). */
export interface ResumeCatchUp {
  walk: string;
  /** The standstill on the old node, to the final snapshot (HandoffState.walkIdleMs). */
  idleMs: number;
  /** When the commit with that snapshot came, on this node's Date.now() clock. */
  committedAt: number;
  /** The part of that standstill the gap replay walked already (GapPlan.spentMs), 0 without one. */
  spentMs?: number;
}

/** The standstill a resumed walk makes up at `now`: from the old node's last step to now, at most MAX_RESUME_CATCH_UP_MS. */
function catchUpBudgetMs(catchUp: ResumeCatchUp, now: number): number {
  return Math.min(MAX_RESUME_CATCH_UP_MS, positive(catchUp.idleMs) + Math.max(0, now - catchUp.committedAt));
}

export function resumeCatchUpSteps(catchUp: ResumeCatchUp | null | undefined, direction: string, now: number, tickMs: number): number {
  if (!catchUp || catchUp.walk !== direction || !(tickMs > 0)) return 0;
  const idle = catchUpBudgetMs(catchUp, now);
  return Math.max(0, Math.round(idle / tickMs) - Math.round(positive(catchUp.spentMs) / tickMs) - 1);
}

export function resumeCatchUpMs(catchUp: ResumeCatchUp | null | undefined, now: number, tickMs: number): number {
  if (!catchUp) return 0;
  return Math.round(resumeCatchUpSteps(catchUp, catchUp.walk, now, tickMs) * tickMs);
}

/** The most stretches a gap report (the `gap` of AUTH) is read for; the rest are dropped. */
export const MAX_GAP_SEGMENTS = 16;

/** A stretch of a handoff's gap as the client went through it: the direction it walked ("" when it stood), for `ms`. */
export interface GapSegment {
  walk: string;
  ms: number;
}

export interface GapInput {
  segments: GapSegment[];
  held: string;
}

const gapWalkOf = (value: unknown): string | null => {
  if (value === "" || value == null) return "";
  const walk = String(value).toLowerCase();
  return WALK_DIRECTIONS.has(walk) ? walk : null;
};

export function gapInputOf(data: unknown): GapInput | null {
  if (!data || typeof data !== "object") return null;
  const r = data as { segments?: unknown; held?: unknown };
  const held = gapWalkOf(r.held);
  if (held === null || !Array.isArray(r.segments)) return null;
  const segments: GapSegment[] = [];
  for (const s of r.segments.slice(0, MAX_GAP_SEGMENTS)) {
    const walk = gapWalkOf((s as any)?.walk);
    const ms = Number((s as any)?.ms);
    if (walk === null || !Number.isFinite(ms) || ms < 0) return null;
    segments.push({ walk, ms: Math.min(ms, MAX_RESUME_CATCH_UP_MS) });
  }
  return { segments, held };
}

/** How a resumed arrival goes through the gap the client reported (gapPlanOf). */
export interface GapPlan {
  /** The direction of each step the replay takes before HANDOFF_DONE, a tick's step each, in order. */
  steps: string[];
  /** The standstill the replayed stretches took up (ms): the walk that goes on makes up only the rest. */
  spentMs: number;
  /** The walk that goes on after the replay: the direction the client holds, or null when it stands. */
  walk: string | null;
}

export function gapPlanOf(input: GapInput | null | undefined, catchUp: ResumeCatchUp | null | undefined, now: number, tickMs: number): GapPlan | null {
  if (!input || !catchUp || !(tickMs > 0)) return null;
  const budget = catchUpBudgetMs(catchUp, now);
  const steps: string[] = [];
  let spent = 0;
  for (const segment of input.segments) {
    if (!(budget - spent > 0)) break;
    const ms = Math.min(segment.ms, budget - spent);
    if (!(ms > 0)) continue;
    if (segment.walk) {
      for (let i = 0; i < Math.round(ms / tickMs); i++) steps.push(segment.walk);
    }
    spent += ms;
  }
  return { steps, spentMs: spent, walk: input.held || null };
}

/** The most reports one gap is taken in: the one with AUTH and the HANDOFF_GAP updates after it. */
export const MAX_GAP_UPDATES = 32;
/** How long after HANDOFF_DONE a later report is still walked (applyLateGap); one after it is only answered. */
export const MAX_GAP_LATE_MS = 1000;

export interface GapUpdate {
  seq: number;
  input: GapInput;
}

/** A HANDOFF_GAP as this node takes it: a report (gapInputOf) numbered 1 to MAX_GAP_UPDATES; else null. */
export function gapUpdateOf(data: unknown): GapUpdate | null {
  const seq = Number((data as { seq?: unknown } | null)?.seq);
  if (!Number.isInteger(seq) || seq < 1 || seq > MAX_GAP_UPDATES) return null;
  const input = gapInputOf(data);
  return input ? { seq, input } : null;
}

/** The later of two reports (the higher number). The packets of a connection are handled as they come, so an older one may come second. */
export function newerGap(kept: GapUpdate | null | undefined, update: GapUpdate | null | undefined): GapUpdate | null {
  if (!update) return kept ?? null;
  if (!kept) return update;
  return update.seq > kept.seq ? update : kept;
}

export interface GapApplied {
  seq: number;
  map: string;
  from: { x: number; y: number; direction: string };
  catchUp: ResumeCatchUp | null;
  /** When HANDOFF_DONE went (Date.now()). */
  at: number;
  /** The walk was resumed after HANDOFF_DONE: a later report may be walked. Before, it waits in `pending`. */
  ready: boolean;
  pending: GapUpdate | null;
}

export function doneWalkOf(walk: string | null | undefined, p: any, now = Date.now()): string | null {
  if (typeof walk !== "string" || !WALK_DIRECTIONS.has(walk)) return null;
  if (p?.isDead || p?.ghostTeleportPending) return null;
  if (Number(p?.stunnedUntil) > now) return null;
  return walk;
}

/** The most effects of one kind an arrival brings. */
export const MAX_ARRIVAL_EFFECTS = 32;
/** The shortest horizon for a timed effect: the built-in ones (the creatures' daze) are not in the spell list. */
export const MIN_EFFECT_HORIZON_MS = 60_000;
/** How far the old node's clock may be ahead of this one's (Date.now() deadlines; the nodes run NTP). */
export const ARRIVAL_CLOCK_SLACK_MS = 5_000;
/** A DoT's stacks when its spell names none (systems/dots.ts). */
const DEFAULT_MAX_STACKS = 5;

export const MIN_DOT_INTERVAL_S = 0.25;

export interface ArrivalKnown {
  /** Whether `id` / `username` is a player this node holds: in the player cache, or the mirror of one on a neighbour. */
  caster?: (id: string, username: string) => boolean;
  /** This node's maps (assetCache "maps"), as adminMoveOf reads them. */
  maps?: ReadonlyArray<{ name: string }>;
}

/** Whether `maps` holds the map a corpse names, as adminMoveOf reads it (the name without ".json"). */
function holdsMap(maps: ReadonlyArray<{ name: string }> | undefined, corpseMap: string): boolean {
  const map = corpseMap.replace(/\.json$/, "");
  return (maps ?? []).some((m) => m?.name === `${map}.json`);
}

export async function arrivalMaps(
  rawState: any,
  startup: ReadonlyArray<{ name: string }> | null | undefined,
  load: () => Promise<ReadonlyArray<{ name: string }> | null | undefined>,
): Promise<ReadonlyArray<{ name: string }>> {
  const c = rawState?.corpse;
  const start = startup ?? [];
  // Anything handoffStateOf drops before the map check needs no list.
  if (!c || typeof c !== "object" || typeof c.map !== "string" || c.map.length === 0 || !finite(c.x) || !finite(c.y)) return start;
  if (holdsMap(start, c.map)) return start;
  return (await load()) || start;
}

/** What this node's spells allow an arrival's effects to be. */
export interface ArrivalLimits {
  /** Date.now() at the arrival. */
  now: number;
  /** The largest barrier any spell gives. */
  barrierMax: number;
  /** Whether a spell gives a barrier with no end (expiresAt 0). */
  permanentBarriers: boolean;
  /** The latest a timed effect may end, from now: the longest effect of any spell, at least a minute. */
  effectHorizonMs: number;
  /** The most stacks any DoT or HoT may have. */
  maxStacks: number;
}

/** The limits read from this node's spells (assetCache "spells"). */
export function arrivalLimits(spells: ReadonlyArray<any> | null | undefined, now = Date.now()): ArrivalLimits {
  let barrierMax = 0;
  let permanentBarriers = false;
  let longestSec = 0;
  let maxStacks = DEFAULT_MAX_STACKS;
  for (const spell of Array.isArray(spells) ? spells : []) {
    for (const effect of Array.isArray(spell?.effects) ? spell.effects : []) {
      const value = Number(effect?.value);
      const duration = Number(effect?.duration);
      if (Number.isFinite(duration) && duration > longestSec) longestSec = duration;
      if (effect?.type === "absorbtion" && Number.isFinite(value) && value > 0) {
        barrierMax = Math.max(barrierMax, value);
        if (!(duration > 0)) permanentBarriers = true;
      }
      const stacks = Number(effect?.max_stacks);
      if (Number.isFinite(stacks) && stacks > maxStacks) maxStacks = Math.floor(stacks);
    }
  }
  return { now, barrierMax, permanentBarriers, effectHorizonMs: Math.max(MIN_EFFECT_HORIZON_MS, longestSec * 1000), maxStacks };
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function checkedList(who: string, kind: string, value: unknown, why: (element: any) => string | null): any[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    log.warn(`The ${kind} ${who} brought by handoff were dropped: not a list`);
    return [];
  }
  const kept: any[] = [];
  for (const element of value) {
    const reason = element && typeof element === "object" ? why(element) : "not a record";
    if (reason !== null) {
      log.warn(`One of the ${kind} ${who} brought by handoff was dropped: ${reason}`);
      continue;
    }
    if (kept.length >= MAX_ARRIVAL_EFFECTS) {
      log.warn(`The ${kind} ${who} brought by handoff were cut to ${MAX_ARRIVAL_EFFECTS}: they brought ${value.length}`);
      break;
    }
    kept.push(element);
  }
  return kept;
}

function clampedDot(d: any, now: number, who: string, known: ArrivalKnown): any {
  const out = { ...d };
  if (out.interval < MIN_DOT_INTERVAL_S) {
    log.warn(`The tick of one of the effects over time ${who} brought by handoff was every ${out.interval} s: cut to ${MIN_DOT_INTERVAL_S} s`);
    out.interval = MIN_DOT_INTERVAL_S;
  }
  const most = Math.max(1, Math.floor(STAT_INT_MAX / out.maxStacks));
  if (Math.abs(out.damagePerTick) > most) {
    log.warn(`One of the effects over time ${who} brought by handoff ticked for ${out.damagePerTick}: cut to ${out.damagePerTick < 0 ? -most : most}`);
    out.damagePerTick = out.damagePerTick < 0 ? -most : most;
  }
  const periodMs = out.interval * 1000;
  if (out.nextTickAt < now - ARRIVAL_TTL_MS - periodMs) out.nextTickAt = now;
  else if (out.nextTickAt > now + periodMs + ARRIVAL_CLOCK_SLACK_MS) out.nextTickAt = now + periodMs;
  const id = typeof out.casterId === "string" || typeof out.casterId === "number" ? String(out.casterId) : "";
  const name = typeof out.casterUsername === "string" ? out.casterUsername : "";
  if (id !== "" || name !== "") {
    if (id !== "" && name !== "" && known.caster?.(id, name) === true) {
      out.casterId = id;
      out.casterUsername = name;
    } else {
      const creature = typeof out.casterId === "string" && out.casterId.startsWith("creature:");
      (creature ? log.debug : log.warn)(`The caster of one of the effects over time ${who} brought by handoff is not a player this node knows: no credit for it`);
      out.casterId = "";
      out.casterUsername = "";
    }
  } else {
    // No caster named: fields that are there are made empty text, and ones that are not stay out.
    if ("casterId" in out) out.casterId = "";
    if ("casterUsername" in out) out.casterUsername = "";
  }
  return out;
}

/** A scene's name, marks and length as the scene store takes them, and how long a chain gets (systems/cutscenes.ts, cutsceneplayer.ts). The sessions' test reads them, so they cannot drift apart. */
export const SCENE_LIMITS = { nameMax: 64, durationMax: 600, marksMax: 4000, chainMax: 16 };
/** How far past its length a scene's clock runs (cutsceneplayer.ts timing): the 30 s a client has to begin it is the most. */
export const SCENE_CLOCK_SLACK_MS = 30_000;

const placeOf = (place: any): boolean => !!place && typeof place === "object" && typeof place.map === "string" && place.map.length > 0 && finite(place.x) && finite(place.y);

function arrivalScene(raw: any, deadState: number, now: number, who: string): CarriedScene | null {
  if (raw === undefined || raw === null) return null;
  const drop = (why: string): null => {
    log.warn(`The cutscene ${who} brought by handoff was dropped: ${why}`);
    return null;
  };
  if (typeof raw !== "object") return drop("not a record");
  if (deadState !== 0) return drop("they are dead");
  if (typeof raw.name !== "string" || raw.name.length === 0 || raw.name.length > SCENE_LIMITS.nameMax) return drop("no name");
  if (typeof raw.token !== "string" || !/^[0-9a-f]{32}$/.test(raw.token)) return drop("no token");
  if (raw.phase !== "pending" && raw.phase !== "running") return drop(`it was ${String(raw.phase).slice(0, 16)}`);
  if (!finite(raw.duration) || raw.duration <= 0 || raw.duration > SCENE_LIMITS.durationMax) return drop(`a length of ${raw.duration} s`);
  const latest = now + raw.duration * 1000 + SCENE_CLOCK_SLACK_MS + ARRIVAL_CLOCK_SLACK_MS;
  if (!finite(raw.clockEndsAt) || raw.clockEndsAt <= 0 || raw.clockEndsAt > latest) return drop(`it ends ${Math.round((Number(raw.clockEndsAt) - now) / 1000)} s from now`);
  if (raw.phase === "running" && (!finite(raw.startedAt) || raw.startedAt <= 0 || raw.startedAt > now + ARRIVAL_CLOCK_SLACK_MS)) return drop("no start time");
  if (!finite(raw.at)) return drop("no time it left");
  if (!Number.isInteger(raw.depth) || raw.depth < 0 || raw.depth > SCENE_LIMITS.chainMax) return drop(`${raw.depth} scenes before it`);

  const end = raw.end;
  if (!end || typeof end !== "object") return drop("no end");
  if (end.next !== null && (typeof end.next !== "string" || end.next.length > SCENE_LIMITS.nameMax)) return drop("the scene after it is not a name");
  if (end.teleport !== null && !placeOf(end.teleport)) return drop("the place it ends at is not a map and a point");
  if (raw.origin !== null && !placeOf(raw.origin)) return drop("the place it began at is not a map and a point");
  if (!Array.isArray(raw.marks) || raw.marks.length > SCENE_LIMITS.marksMax) return drop("its marks are not a list");
  if (!raw.marks.every((m: any) => typeof m?.name === "string" && finite(m?.t) && m.t >= 0)) return drop("one of its marks is not a name and a time");

  return {
    name: raw.name,
    token: raw.token,
    lock: raw.lock === true,
    phase: raw.phase,
    clockEndsAt: raw.clockEndsAt,
    startedAt: raw.phase === "running" ? raw.startedAt : 0,
    duration: raw.duration,
    skippable: raw.skippable === true,
    end: { next: end.next, teleport: end.teleport && { map: end.teleport.map, x: end.teleport.x, y: end.teleport.y } },
    origin: raw.origin && { map: raw.origin.map, x: raw.origin.x, y: raw.origin.y, direction: String(raw.origin.direction || "down") },
    depth: raw.depth,
    marks: raw.marks.map((m: any) => ({ name: m.name, t: m.t })),
    at: raw.at,
  };
}

/** What a sickness came with, kept to what the settings allow; null when it came without or what came is no such record. */
function sickGivenOf(raw: any): SicknessGiven | null {
  if (!raw || typeof raw !== "object") return null;
  const within = (key: string, value: unknown): number | null => {
    const def = defOf(key);
    const n = Number(value);
    return Number.isFinite(n) && def ? Math.min(def.max ?? n, Math.max(def.min ?? n, n)) : null;
  };
  const minutes = within("resSicknessMinutes", Number(raw.durationMs) / 60_000);
  const healthMult = within("resSicknessHealthMultiplier", raw.healthMult);
  const statMult = within("resSicknessStatMultiplier", raw.statMult);
  if (minutes === null || healthMult === null || statMult === null) return null;
  return { durationMs: minutes * 60_000, healthMult, statMult };
}

/** The chain of an arrival, or null when it has none or when what came could not be one. */
function arrivalChain(raw: any, deadState: number, who: string): CarriedChain | null {
  if (raw === undefined || raw === null) return null;
  const good = typeof raw === "object" && deadState === 0
    && typeof raw.name === "string" && raw.name.length > 0 && raw.name.length <= SCENE_LIMITS.nameMax
    && Number.isInteger(raw.depth) && raw.depth >= 0 && raw.depth < SCENE_LIMITS.chainMax
    && (raw.origin === null || placeOf(raw.origin));
  if (good) {
    const origin = raw.origin && { map: raw.origin.map, x: raw.origin.x, y: raw.origin.y, direction: String(raw.origin.direction || "down") };
    return { name: raw.name, origin, depth: raw.depth };
  }
  log.warn(`The cutscene chain ${who} brought by handoff was dropped`);
  return null;
}

export function handoffStateOf(raw: unknown, limits: ArrivalLimits, who = "an arriving player", known: ArrivalKnown = {}): HandoffState {
  const r: any = raw && typeof raw === "object" ? raw : {};
  const latest = limits.now + limits.effectHorizonMs + ARRIVAL_CLOCK_SLACK_MS;
  const ends = (e: any): string | null =>
    !finite(e.expiresAt) || e.expiresAt < 0 ? "no end time" : e.expiresAt > latest ? `it ends ${Math.round((e.expiresAt - limits.now) / 1000)} s from now` : null;

  const cooldowns: Record<string, number> = {};
  if (r.cooldowns && typeof r.cooldowns === "object") {
    for (const [spellId, left] of Object.entries(r.cooldowns)) {
      if (Number.isInteger(Number(spellId)) && positive(left) > 0) cooldowns[spellId] = positive(left);
    }
  }

  const barriers = checkedList(who, "barriers", r.barriers, (b) => {
    if (!finite(b.amount) || b.amount <= 0 || b.amount > limits.barrierMax) return `an amount of ${b.amount}, the most a spell gives is ${limits.barrierMax}`;
    if (b.expiresAt === 0) return limits.permanentBarriers ? null : "no end, and no spell gives a barrier without one";
    return ends(b);
  });
  const stuns = checkedList(who, "stuns", r.stuns, ends);
  const slows = checkedList(who, "slows", r.slows, (s) =>
    !finite(s.slowPercent) || s.slowPercent < 1 || s.slowPercent > 99 ? `a slow of ${s.slowPercent}%` : ends(s));
  const checkedDots = checkedList(who, "effects over time", r.dots, (d) => {
    if (!finite(d.damagePerTick) || !Number.isInteger(d.damagePerTick) || d.damagePerTick === 0) return `${d.damagePerTick} a tick`;
    if (!finite(d.interval) || d.interval <= 0) return `a tick every ${d.interval} s`;
    if (!finite(d.nextTickAt)) return "no next tick";
    if (!Number.isInteger(d.maxStacks) || d.maxStacks < 1 || d.maxStacks > limits.maxStacks) return `at most ${d.maxStacks} stacks`;
    if (!Number.isInteger(d.stacks) || d.stacks < 1 || d.stacks > d.maxStacks) return `${d.stacks} stacks`;
    return ends(d);
  });
  const dots = checkedDots.map((d) => clampedDot(d, limits.now, who, known));

  let sickUntil = positive(r.sickUntil);
  // A sickness is as long as it was given: the length it came with (within what the setting allows), else the live one.
  const sickGiven = sickGivenOf(r.sickGiven);
  const sickLength = sickGiven?.durationMs ?? sicknessDurationMs();
  const sickLatest = limits.now + sickLength + ARRIVAL_CLOCK_SLACK_MS;
  if (sickUntil > sickLatest) {
    log.warn(`The resurrection sickness ${who} brought by handoff ended ${Math.round((sickUntil - limits.now) / 1000)} s from now: cut to the full sickness`);
    sickUntil = limits.now + sickLength;
  }

  const dead = Number(r.deadState);
  const deadState: 0 | 1 | 2 = dead === 1 || dead === 2 ? dead : 0;
  let corpse: HandoffState["corpse"] = null;
  if (r.corpse != null) {
    const c = r.corpse;
    if (c && typeof c === "object" && typeof c.map === "string" && c.map.length > 0 && finite(c.x) && finite(c.y)) {
      // The map is one this node has, named as adminMoveOf reads it (the name without ".json").
      if (holdsMap(known.maps, c.map)) {
        corpse = { map: c.map, x: c.x, y: c.y };
      } else {
        log.warn(`The corpse ${who} brought by handoff was dropped: an unknown map ${JSON.stringify(String(c.map).slice(0, 64))}`);
      }
    } else {
      log.warn(`The corpse ${who} brought by handoff was dropped: not a map and a point`);
    }
  }

  let consumableReadyIn = 0;
  if (r.consumableReadyIn != null) {
    const left = r.consumableReadyIn;
    if (!finite(left) || left < 0) {
      log.warn(`The consumable cooldown ${who} brought by handoff was dropped: ${left}`);
    } else if (left > CONSUMABLE_COOLDOWN_MS) {
      log.warn(`The consumable cooldown ${who} brought by handoff was ${left} ms: cut to ${CONSUMABLE_COOLDOWN_MS}`);
      consumableReadyIn = CONSUMABLE_COOLDOWN_MS;
    } else {
      consumableReadyIn = left;
    }
  }

  let warpReadyIn = 0;
  if (r.warpReadyIn != null) {
    const left = r.warpReadyIn;
    if (!finite(left) || left < 0) {
      log.warn(`The warp cooldown ${who} brought by handoff was dropped: ${left}`);
    } else if (left > WARP_COOLDOWN_MS) {
      log.warn(`The warp cooldown ${who} brought by handoff was ${left} ms: cut to ${WARP_COOLDOWN_MS}`);
      warpReadyIn = WARP_COOLDOWN_MS;
    } else {
      warpReadyIn = left;
    }
  }

  return {
    dots,
    barriers,
    stuns,
    slows,
    cooldowns,
    lockoutMs: positive(r.lockoutMs),
    sickUntil,
    ...(sickGiven && sickUntil > 0 ? { sickGiven } : {}),
    deadState,
    corpse,
    combat: r.combat === true,
    lastAttackAgoMs: r.lastAttackAgoMs == null ? null : positive(r.lastAttackAgoMs),
    mounted: r.mounted === true,
    mount_type: typeof r.mount_type === "string" ? r.mount_type : null,
    consumableReadyIn,
    warpReadyIn,
    // A dead player does not walk; anything but one of the eight directions is no walk.
    walk: deadState === 0 && typeof r.walk === "string" && WALK_DIRECTIONS.has(r.walk) ? r.walk : null,
    walkIdleMs: Math.min(MAX_RESUME_CATCH_UP_MS, positive(r.walkIdleMs)),
    cutscene: arrivalScene(r.cutscene, deadState, limits.now, who),
    cutsceneChain: arrivalChain(r.cutsceneChain, deadState, who),
  };
}

export function seedArrival(username: string, state: HandoffState, now = performance.now()): void {
  const lower = username.toLowerCase();
  effectManager.saveDots(lower, state.dots);
  effectManager.saveBarriers(lower, state.barriers);
  effectManager.saveStuns(lower, state.stuns);
  effectManager.saveSlows(lower, state.slows);
  cooldownManager.removePlayer(username);
  for (const [spellId, left] of Object.entries(state.cooldowns)) cooldownManager.setCooldown(username, Number(spellId), now + left);
  if (state.lockoutMs > 0) cooldownManager.setLockout(username, now + state.lockoutMs);
  saveSickness({ username, resurrectionSickUntil: state.sickUntil });
  rememberSicknessGiven(username, state.sickGiven);
  if (state.consumableReadyIn > 0) setConsumableReadyIn(username, state.consumableReadyIn);
  if (state.warpReadyIn > 0) setWarpReadyIn(username, state.warpReadyIn);
}

/** The playerCache fields an arrival brings instead of the login's defaults. */
export function arrivalFields(state: HandoffState, now = performance.now()) {
  return {
    combat: state.combat,
    last_attack: state.lastAttackAgoMs == null ? null : now - state.lastAttackAgoMs,
    mounted: state.mounted,
    mount_type: state.mounted ? state.mount_type : null,
  };
}

export function arrivalMount(
  fields: { mounted: boolean; mount_type: string | null },
  collectables: ReadonlyArray<any>,
  deadState: number,
  interior: boolean
): { mounted: boolean; mount_type: string | null } {
  const owned = fields.mount_type !== null && collectables.some((c: any) => c?.type === "mount" && c?.item === fields.mount_type);
  return fields.mounted && owned && deadState === 0 && !interior
    ? { mounted: true, mount_type: fields.mount_type }
    : { mounted: false, mount_type: null };
}

/** The players the client showed on the old node that it does not see here: they are despawned once. */
export function playersToDespawn(shownBefore: Iterable<string>, shownNow: ReadonlySet<string>, selfId: string): string[] {
  const out: string[] = [];
  for (const id of shownBefore) {
    const key = String(id);
    if (key !== selfId && !shownNow.has(key)) out.push(key);
  }
  return out;
}

export function draggedCheck(dragged: ReadonlyMap<number, number>): (playerId: string) => boolean {
  return (playerId) => {
    const id = String(playerId);
    for (const [draggedId, adminId] of dragged) {
      if (String(draggedId) === id || String(adminId) === id) return true;
    }
    return false;
  };
}

/** An admin's summon or teleport sent from the admin's node (cells-summon), each field checked. */
export interface AdminMove {
  by: string;
  map: string;
  x: number;
  y: number;
  why: "summon" | "teleport";
  admins: boolean;
}

/** The name of the admin who sent a remote action, or null when it is not a name. */
export function remoteAdminOf(args: any): string | null {
  const by = args?.by;
  return typeof by === "string" && by.trim().length > 0 ? by : null;
}

export function adminMoveOf(args: any, maps: ReadonlyArray<{ name: string; data?: any }>): AdminMove | string {
  const by = remoteAdminOf(args);
  if (by === null) return "no admin name";
  if (args.why !== "summon" && args.why !== "teleport") return `an unknown reason ${JSON.stringify(args.why)}`;
  if (typeof args.admins !== "boolean") return "no admins flag";
  if (typeof args.map !== "string" || args.map.length === 0) return "no map";
  const map = args.map.replace(/\.json$/, "");
  const known = maps.find((m) => m?.name === `${map}.json`);
  if (!known) return `an unknown map ${JSON.stringify(map)}`;
  if (typeof args.x !== "number" || typeof args.y !== "number" || !Number.isFinite(args.x) || !Number.isFinite(args.y)) return "no point";
  const data = known.data;
  const width = Number(data?.width) * Number(data?.tilewidth);
  const height = Number(data?.height) * Number(data?.tileheight);
  if (!(width > 0) || !(height > 0)) return `a map without a size ${JSON.stringify(map)}`;
  const x = Math.round(args.x);
  const y = Math.round(args.y);
  if (x < 0 || y < 0 || x > width || y > height) return `a point outside ${map} (${x}, ${y})`;
  return { by, map, x, y, why: args.why, admins: args.admins };
}

export function reverseSummonAdmins(args: any): boolean {
  return args?.admins === true;
}

/** The node that owns a warp's destination when it is not this one; null to warp here. */
export function warpTarget(ctx: Pick<LinkContext, "ownerAt" | "self"> | null, map: string, x: number, y: number): string | null {
  if (!ctx) return null;
  const owner = ctx.ownerAt(bareMapName(map), x, y);
  return owner && owner !== ctx.self ? owner : null;
}

export function resumeSelfSpawn(
  current: any,
  nameOf: (direction: string, walking: boolean, mounted: boolean, mountType: string | undefined, casting: boolean) => string,
  moverRunning: boolean = false
): { animationName: string; x: number; y: number; direction: string } | null {
  const here = current?.location?.position;
  if (!here || !Number.isFinite(here.x) || !Number.isFinite(here.y)) return null;
  const direction = here.direction || "down";
  const mounted = current.mounted === true;
  return {
    animationName: nameOf(direction, (current.moving === true || moverRunning) && !current.isDead, mounted, mounted ? current.mount_type || undefined : undefined, current.casting === true),
    x: here.x,
    y: here.y,
    direction,
  };
}

/** How long after a resumed handoff arrival that walks a superseded mover's stray stop is undone (movement.ts). */
export const RESUME_WALK_RECOVER_MS = 3000;
/** The longest the deferred spawn waits for the resumed walk to begin. */
export const RESUME_WALK_WAIT_MS = 500;

export async function waitFor(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work.catch(() => undefined), new Promise<void>((done) => { timer = setTimeout(done, ms); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function recoverResumedWalk(
  player: { moving?: boolean; isDead?: boolean; ghostTeleportPending?: boolean },
  until: number | undefined,
  now: number
): boolean {
  if (until === undefined || !(now <= until)) return false;
  if (player.moving || player.isDead || player.ghostTeleportPending) return false;
  player.moving = true;
  return true;
}
