// Every game-wide value staff can edit. Each default equals the value hard-coded before game settings existed,
// so nothing changes in game until a row is saved.

import * as settings from "../../config/settings.json";
import { compileFormula } from "./formula";

export type SettingDef = {
  key: string;
  section: string;
  label: string;
  help: string;
  kind: "number" | "formula";
  default: number | string;
  min?: number;
  max?: number;
  integer?: boolean;
};

export type SettingContext = { maxLevel: number; current?: (key: string) => number | string };

export type ValidateResult = { ok: true; value: number | string } | { ok: false; error: string };

/** The stats table's integer columns hold no more than this. */
export const MAX_XP_VALUE = 2147483647;

/**
 * The fastest a player may move, in px a second: 30 px a 30 Hz tick, under a tile, since a step tests only where it
 * lands and a longer one could pass through a wall. Walk speed times the larger of the mount and ghost multipliers is
 * held to it.
 */
export const MAX_MOVE_SPEED = 900;

/** The highest level formulas are checked to: the level cap, or 1000 when there is none. */
export const formulaCheckTop = (maxLevel: number): number => (maxLevel > 0 ? maxLevel : 1000);

/** maxLevelCap never searches past this, so a curve that never outgrows the stats table still ends. */
const LEVEL_CEILING = 100_000;

/** The last level whose next XP target still fits the stats table (playereditor.ts maxLevel, for any curve). */
export function maxLevelCap(xpFn: (level: number) => number): number {
  const first = Math.floor(xpFn(1));
  if (!Number.isFinite(first) || first < 1 || first > MAX_XP_VALUE) return 0;
  let level = 1;
  while (level < LEVEL_CEILING) {
    const next = Math.floor(xpFn(level + 1));
    if (!Number.isFinite(next) || next > MAX_XP_VALUE || next < 1) break;
    level++;
  }
  return level;
}

const DEFAULT_XP = "floor(100 * 1.1 ^ (level - 1))";

const defaultXpFn = (() => {
  const r = compileFormula(DEFAULT_XP);
  if (!r.ok) throw new Error(`Default XP formula does not compile: ${r.error}`);
  return r.fn;
})();

/** How far today's XP curve stays within the stats table. With no level cap, a new curve must reach at least this far. */
export const DEFAULT_CURVE_REACH = maxLevelCap(defaultXpFn);

// The same read as creatures/constants.ts RESPAWN_MULTIPLIER, done here so the registry depends on nothing it configures.
const creatureCfg: Record<string, any> = (settings as any)?.creatures || {};
const DEFAULT_RESPAWN_MULTIPLIER = Number(creatureCfg.respawnMultiplier) || 1;

// mail.ts / trades.ts limits: min 1 (0 where 0 works today), max ten times the default, whole numbers.
// subjectMax is held to the mail.subject column (VARCHAR(64)); the other limits fit their columns at ten times the default.
const limit = (key: string, label: string, def: number, help: string, min = 1, max = def * 10): SettingDef => ({
  key, section: "Inventory and economy", label, help, kind: "number", default: def, min, max, integer: true,
});

export const SETTINGS: readonly SettingDef[] = [
  // Progression
  { key: "xpToNextLevel", section: "Progression", label: "XP to next level", kind: "formula", default: DEFAULT_XP, min: 1, max: MAX_XP_VALUE,
    help: "The XP a character needs to leave a level; applies to each character at their next level-up. "
      + `With no max level, it must stay within the XP limit up to level ${DEFAULT_CURVE_REACH}; set a max level to use a steeper curve.` },
  { key: "maxHealth", section: "Progression", label: "Max health", kind: "formula", default: "100 + level ^ 1.5 * 5", min: 1, max: MAX_XP_VALUE,
    help: "Base health for a level; applies to each character at their next level-up." },
  { key: "maxStamina", section: "Progression", label: "Max stamina", kind: "formula", default: "100 + level ^ 1.5 * 3", min: 1, max: MAX_XP_VALUE,
    help: "Base stamina for a level; applies to each character at their next level-up." },
  { key: "maxLevel", section: "Progression", label: "Level cap", kind: "number", default: 0, min: 0, max: DEFAULT_CURVE_REACH, integer: true,
    help: "The highest level a character can reach (0 for no cap); applies from the next XP gain." },

  // Movement
  { key: "walkSpeed", section: "Movement", label: "Walk speed (px/s)", kind: "number", default: 180, min: 30, max: MAX_MOVE_SPEED,
    help: "How fast players walk, in pixels a second; applies from their next step." },
  { key: "mountSpeedMultiplier", section: "Movement", label: "Mount speed multiplier", kind: "number", default: 1.35, min: 1, max: 5,
    help: "How much faster a mounted player moves than walking; applies from their next step." },
  { key: "ghostSpeedMultiplier", section: "Movement", label: "Ghost speed multiplier", kind: "number", default: 1.35, min: 0.5, max: 5,
    help: "How much faster a ghost moves than walking; applies from their next step." },

  // Combat and regen
  { key: "healthRegenPercent", section: "Combat and regen", label: "Health regen (% per tick)", kind: "number", default: 1, min: 0, max: 100,
    help: "The share of max health restored each regen tick out of combat; applies from the next tick." },
  { key: "staminaRegenPercent", section: "Combat and regen", label: "Stamina regen (% per tick)", kind: "number", default: 5, min: 0, max: 100,
    help: "The share of max stamina restored each regen tick; applies from the next tick." },
  { key: "pvpFlagSeconds", section: "Combat and regen", label: "Combat flag (seconds)", kind: "number", default: 5, min: 0, max: 600,
    help: "How long after their last attack a player stays flagged as in combat; applies from the next regen tick." },
  { key: "resSicknessMinutes", section: "Combat and regen", label: "Resurrection sickness (minutes)", kind: "number", default: 15, min: 0, max: 240,
    help: "How long resurrection sickness lasts; applies to the next resurrection." },
  { key: "resSicknessHealthMultiplier", section: "Combat and regen", label: "Sickness health multiplier", kind: "number", default: 0.8, min: 0.1, max: 1,
    help: "The share of max health a sick character keeps; applies to the next resurrection." },
  { key: "resSicknessStatMultiplier", section: "Combat and regen", label: "Sickness stat multiplier", kind: "number", default: 0.9, min: 0.1, max: 1,
    help: "The share of their other stats a sick character keeps; applies to the next resurrection." },
  // Kept under its first key so saved rows still apply; it never spaced casts apart.
  { key: "globalCooldownSeconds", section: "Combat and regen", label: "Instant spell time (seconds)", kind: "number", default: 1.5, min: 0.5, max: 10,
    help: "The cast time an instant spell counts as when its bonus from stats is worked out: a spell scales with "
      + "max(this, its cast time) / 3.5. It does not space casts apart. Applies from the next cast." },
  { key: "critHealMultiplier", section: "Combat and regen", label: "Critical heal multiplier", kind: "number", default: 1.5, min: 1, max: 10,
    help: "How much a critical heal multiplies the amount healed; applies from the next heal." },

  // Inventory and economy
  limit("mailRange", "Mailbox reach (px)", 120, "How far from a mailbox a player may stand and still use it; applies from the next mailbox action."),
  limit("mailItemsMax", "Items per mail", 12, "How many different items one mail can hold; applies to mail sent from now on."),
  limit("inboxMax", "Mailbox size", 100, "How many mails a mailbox holds; applies to mail sent from now on."),
  limit("subjectMax", "Mail subject length", 64, "The longest mail subject, in characters (the mail table holds 64); applies to mail sent from now on.", 1, 64),
  limit("bodyMax", "Mail body length", 500, "The longest mail body, in characters; applies to mail sent from now on."),
  limit("postageCopper", "Postage (copper)", 30, "The copper charged for each item attached, or for a mail with none; applies to mail sent from now on.", 0),
  limit("mailDays", "Mail lifetime (days)", 30, "How many days a mail waits before it goes back or is deleted; applies to mail sent from now on."),
  limit("tradeRange", "Trade reach (px)", 120, "How far apart two players may stand and still trade; applies from the next trade action."),
  limit("tradeItemsMax", "Items per trade side", 8, "How many different items one side of a trade can hold; applies from the next item offered."),
  limit("acceptDelayMs", "Trade accept delay (ms)", 2000, "How long after an offer changes before the trade can be accepted; applies from the next offer change.", 0),

  // Social and chat
  { key: "chatMaxLength", section: "Social and chat", label: "Chat message length", kind: "number", default: 500, min: 50, max: 2000, integer: true,
    help: "The longest chat message, in characters; applies from the next message." },
  { key: "chatRateMax", section: "Social and chat", label: "Chat messages per window", kind: "number", default: 5, min: 1, max: 100, integer: true,
    help: "How many chat messages a player may send in one rate window; applies from the next message." },
  { key: "chatRateWindowMs", section: "Social and chat", label: "Chat rate window (ms)", kind: "number", default: 3000, min: 100, max: 60000, integer: true,
    help: "The length of the chat rate window, in milliseconds; applies from the next message." },
  { key: "partySize", section: "Social and chat", label: "Party size", kind: "number", default: 5, min: 2, max: 40, integer: true,
    help: "How many members a party holds before it must become a raid; applies from the next invite." },
  { key: "raidSize", section: "Social and chat", label: "Raid size", kind: "number", default: 20, min: 2, max: 200, integer: true,
    help: "How many members a raid holds; applies from the next invite." },

  // Loot and corpses
  { key: "lootPickupRadius", section: "Loot and corpses", label: "Loot pickup radius (px)", kind: "number", default: 100, min: 10, max: 1000,
    help: "How close a player must stand to pick up ground loot; applies from the next pickup." },
  { key: "groundLootDespawnMinutes", section: "Loot and corpses", label: "Ground loot lifetime (minutes)", kind: "number", default: 30, min: 1, max: 1440,
    help: "How long dropped loot stays on the ground; applies to loot dropped from now on." },
  { key: "corpseWithLootSeconds", section: "Loot and corpses", label: "Corpse with loot (seconds)", kind: "number", default: 300, min: 10, max: 3600,
    help: "How long a creature corpse with loot left on it stays; applies to creatures killed from now on." },
  { key: "corpseEmptySeconds", section: "Loot and corpses", label: "Empty corpse (seconds)", kind: "number", default: 60, min: 10, max: 3600,
    help: "How long a looted or empty creature corpse stays; applies to creatures killed from now on." },
  { key: "respawnMultiplier", section: "Loot and corpses", label: "Respawn time multiplier", kind: "number", default: DEFAULT_RESPAWN_MULTIPLIER, min: 0.05, max: 20,
    help: "Multiplies every creature respawn time; applies to the next respawn scheduled." },

  // World
  { key: "weatherCycleMinutes", section: "World", label: "Weather cycle (minutes)", kind: "number", default: 30, min: 1, max: 1440, integer: true,
    help: "How long a random-weather world keeps the weather it settled on; applies from the next weather change." },
];

const BY_KEY = new Map(SETTINGS.map((d) => [d.key, d]));

export const defOf = (key: string): SettingDef | undefined => BY_KEY.get(key);

const currentOf = (key: string, ctx: SettingContext): number | string | undefined =>
  ctx.current ? ctx.current(key) : defOf(key)?.default;

/**
 * Work done again on every save, reload and preview of the same rows (up to LEVEL_CEILING evaluations each), kept by
 * formula text: the result depends on nothing else. Each map is emptied when it grows past MEMO_LIMIT.
 */
const MEMO_LIMIT = 256;
const capMemo = new Map<string, number>([[DEFAULT_XP, DEFAULT_CURVE_REACH]]);
const formulaMemo = new Map<string, ValidateResult>();
const remember = <T>(memo: Map<string, T>, key: string, value: T): T => {
  if (memo.size >= MEMO_LIMIT) memo.clear();
  memo.set(key, value);
  return value;
};

/** The XP curve's text in `ctx`, trimmed; the default's when the text there does not compile. */
function xpTextOf(ctx: SettingContext): string {
  const text = currentOf("xpToNextLevel", ctx);
  return typeof text === "string" && compileFormula(text.trim()).ok ? text.trim() : DEFAULT_XP;
}

/** maxLevelCap of the XP curve `text` (one that compiles), worked out once per text. */
function capOfXpText(text: string): number {
  const known = capMemo.get(text);
  if (known !== undefined) return known;
  const compiled = compileFormula(text);
  return remember(capMemo, text, compiled.ok ? maxLevelCap(compiled.fn) : DEFAULT_CURVE_REACH);
}

const STAT_FORMULAS = ["maxHealth", "maxStamina"];

/**
 * The highest level the health and stamina formulas are checked to: the level cap, or with none the level the XP curve
 * lets a character reach (maxLevelCap, itself bounded at LEVEL_CEILING), and never less than formulaCheckTop(0).
 */
export const statCheckTop = (ctx: SettingContext): number =>
  ctx.maxLevel > 0 ? ctx.maxLevel : Math.max(formulaCheckTop(0), capOfXpText(xpTextOf(ctx)));

/**
 * Compiles `text` and runs it at every level from 1 to the check top: each result must be finite and, floored, within
 * the def's range. With no level cap, the XP curve's range is checked only to DEFAULT_CURVE_REACH: it must reach as far
 * as today's curve, and a steeper one needs a max level set. Health and stamina are checked to statCheckTop.
 */
export function validateFormula(def: SettingDef, text: string, ctx: SettingContext): ValidateResult {
  if (typeof text !== "string") return { ok: false, error: "A formula must be text." };
  const trimmed = text.trim();
  const top = STAT_FORMULAS.includes(def.key) ? statCheckTop(ctx) : formulaCheckTop(ctx.maxLevel);
  const rangeTop = def.key === "xpToNextLevel" && !(ctx.maxLevel > 0) ? DEFAULT_CURVE_REACH : top;
  // The outcome depends only on these: the same check asked again (a reload, a preview) is not run again.
  const memoKey = `${def.key}\u0000${def.min}\u0000${def.max}\u0000${top}\u0000${rangeTop}\u0000${trimmed}`;
  const known = formulaMemo.get(memoKey);
  if (known) return { ...known };
  const compiled = compileFormula(trimmed);
  if (!compiled.ok) return remember(formulaMemo, memoKey, { ok: false, error: compiled.error });
  for (let level = 1; level <= top; level++) {
    const result = compiled.fn(level);
    const floored = Math.floor(result);
    const inRangeCheck = level <= rangeTop;
    const bad = !Number.isFinite(result)
      || (inRangeCheck && def.min !== undefined && floored < def.min)
      || (inRangeCheck && def.max !== undefined && floored > def.max);
    if (bad) return remember(formulaMemo, memoKey, { ok: false, error: `At level ${level} the formula gives ${result}.` });
  }
  return remember(formulaMemo, memoKey, { ok: true, value: trimmed });
}

const SPEED_KEYS = ["walkSpeed", "mountSpeedMultiplier", "ghostSpeedMultiplier"];

/** A plain decimal: an optional sign, digits, and an optional fraction (no hex, exponent, Infinity or blank). */
const PLAIN_DECIMAL = /^[+-]?\d+(?:\.\d+)?$/;

function toNumber(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && PLAIN_DECIMAL.test(raw.trim())) return Number(raw.trim());
  return NaN;
}

/** The refusal when the health or stamina formula in `ctx` does not fit under level cap `cap` (0: none). */
function statFormulasMisfit(ctx: SettingContext, cap: number): string | undefined {
  const under: SettingContext = { ...ctx, maxLevel: cap };
  for (const key of STAT_FORMULAS) {
    const formulaDef = defOf(key)!;
    const text = currentOf(key, ctx);
    const usable = typeof text === "string" && compileFormula(text.trim()).ok ? text : String(formulaDef.default);
    const fits = validateFormula(formulaDef, usable, under);
    if (fits.ok) continue;
    const where = cap > 0 ? `up to level ${cap}` : `with no level cap (checked to level ${statCheckTop(under)})`;
    return `${formulaDef.label} formula does not fit ${where}: ${fits.error} Change it first.`;
  }
  return undefined;
}

export function validateValue(def: SettingDef, raw: unknown, ctx: SettingContext): ValidateResult {
  if (def.kind === "formula") {
    const result = validateFormula(def, raw as string, ctx);
    if (!result.ok || def.key !== "xpToNextLevel" || ctx.maxLevel > 0) return result;
    // With no cap the XP curve sets how far levelling goes: the health and stamina formulas must fit that far.
    const withCurve: SettingContext = { ...ctx, current: (key) => (key === "xpToNextLevel" ? result.value : currentOf(key, ctx)!) };
    const misfit = statFormulasMisfit(withCurve, 0);
    return misfit ? { ok: false, error: misfit } : result;
  }

  const value = toNumber(raw);
  if (!Number.isFinite(value)) return { ok: false, error: `${def.label} must be a number.` };
  if (def.integer && !Number.isInteger(value)) return { ok: false, error: `${def.label} must be a whole number.` };

  if (def.min !== undefined && value < def.min) return { ok: false, error: `${def.label} must be at least ${def.min}.` };
  let max = def.max;
  if (def.key === "maxLevel") {
    const xpDef = defOf("xpToNextLevel")!;
    const curve = xpTextOf(ctx);
    max = capOfXpText(curve);
    if (value === 0) {
      // Turning the cap off puts the curve under the no-cap rules, so recheck it as they would.
      const fits = validateFormula(xpDef, curve, { ...ctx, maxLevel: 0 });
      if (!fits.ok) return { ok: false, error: `Remove the level cap only after the XP curve fits without one: ${fits.error}` };
    } else {
      if (max === 0) {
        const compiled = compileFormula(curve);
        const first = compiled.ok ? compiled.fn(1) : NaN;
        return { ok: false, error: `The XP formula is invalid at level 1 (it gives ${first}), so no level cap fits under it; change the XP formula first.` };
      }
      // The XP curve must fit every level up to the new cap, whoever saves it.
      const fits = validateFormula(xpDef, curve, { ...ctx, maxLevel: value });
      if (!fits.ok) return { ok: false, error: `The XP curve does not fit up to level ${value}: ${fits.error}` };
    }
  }
  if (max !== undefined && value > max) return { ok: false, error: `${def.label} must be at most ${max}.` };

  // The health and stamina formulas were checked only to the cap they were saved under: hold them to the new one.
  if (def.key === "maxLevel") {
    const misfit = statFormulasMisfit(ctx, value);
    if (misfit) return { ok: false, error: misfit };
  }

  if (SPEED_KEYS.includes(def.key)) {
    const of = (key: string): number => (key === def.key ? value : Number(currentOf(key, ctx)));
    const fastest = of("walkSpeed") * Math.max(of("mountSpeedMultiplier"), of("ghostSpeedMultiplier"));
    if (Number.isFinite(fastest) && fastest > MAX_MOVE_SPEED) {
      return { ok: false, error: `Walk speed times the larger of the mount and ghost multipliers must be at most ${MAX_MOVE_SPEED} px/s (30 px a tick); this gives ${Math.round(fastest * 100) / 100}.` };
    }
  }

  if (def.key === "raidSize") {
    const party = Number(currentOf("partySize", ctx));
    if (Number.isFinite(party) && value < party) return { ok: false, error: `Raid size must be at least the party size (${party}).` };
  }
  if (def.key === "partySize") {
    const raid = Number(currentOf("raidSize", ctx));
    if (Number.isFinite(raid) && value > raid) return { ok: false, error: `Party size must be at most the raid size (${raid}).` };
  }
  return { ok: true, value };
}
