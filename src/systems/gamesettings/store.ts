// Game settings store: the saved overrides (table game_settings) laid over the registry defaults, read synchronously
// by the systems that use them. Every node keeps its own copy and reads it again when another node saves.

import query from "../../controllers/sqldatabase";
import assetCache from "../../services/assetCache";
import log from "../../modules/logger";
import { MAX_XP_VALUE, SETTINGS, defOf, validateValue, type SettingContext } from "./registry";
import { compileFormula } from "./formula";

export type Row = { setting_key: string; value: string; updated_by: string | null; updated_at: number };

export type SettingsIO = {
  read?: () => Promise<Row[]>;
  write?: (key: string, value: string, by: string) => Promise<void>;
  remove?: (key: string) => Promise<void>;
  /** The cache that tells of saves on other nodes (default: the real asset cache). */
  cache?: CacheLike;
};

type CacheLike = { onChange?: (key: string, listener: (elsewhere: boolean) => void) => unknown };

export type Override = { value: string; updatedBy: string; updatedAt: number };

type FormulaFn = (level: number) => number;

const sqlite = () => (process.env.DATABASE_ENGINE || "mysql") === "sqlite";

const defaultIO: Required<SettingsIO> = {
  cache: assetCache,
  read: async () => (await query("SELECT setting_key, value, updated_by, updated_at FROM game_settings")) as Row[],
  write: async (key, value, by) => {
    const at = Date.now();
    if (sqlite()) {
      await query(
        "INSERT INTO game_settings (setting_key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) "
        + "ON CONFLICT(setting_key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
        [key, value, by, at],
      );
    } else {
      await query(
        "INSERT INTO game_settings (setting_key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) "
        + "ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)",
        [key, value, by, at],
      );
    }
  },
  remove: async (key) => {
    await query("DELETE FROM game_settings WHERE setting_key = ?", [key]);
  },
};

let io: Required<SettingsIO> = defaultIO;
let values: Record<string, number | string> = {};
let formulas = new Map<string, FormulaFn>();
let overrideMap: Record<string, Override> = {};
let missingTableLogged = false;
const listeners = new Set<() => void>();
/** Why the last reload refused each saved row it refused (cleared for rows it took). */
let refusals: Record<string, string> = {};
/** Saved-row problems already warned of, once each per process: the same row is met again on every reload. */
const warned = new Set<string>();
/** The overrides last published to the cluster, so a load that changed nothing publishes nothing. */
let lastPublished: string | undefined;
/** The reload of a save made on another node, while it runs. */
let inFlight: Promise<void> = Promise.resolve();

const warnOnce = (id: string, message: string): void => {
  if (warned.has(id)) return;
  warned.add(id);
  log.warn(message);
};

const defaultValues = (): Record<string, number | string> => {
  const out: Record<string, number | string> = {};
  for (const d of SETTINGS) out[d.key] = d.default;
  return out;
};

const compiledOf = (text: string): FormulaFn | undefined => {
  const r = compileFormula(text);
  return r.ok ? r.fn : undefined;
};

const defaultFormulas = (): Map<string, FormulaFn> => {
  const out = new Map<string, FormulaFn>();
  for (const d of SETTINGS) if (d.kind === "formula") out.set(d.key, compiledOf(String(d.default))!);
  return out;
};

const isMissingTable = (error: unknown): boolean => /no such table|doesn't exist|does not exist|ER_NO_SUCH_TABLE/i.test(String(error));

function apply(rows: Row[]): void {
  const nextValues = defaultValues();
  const nextFormulas = defaultFormulas();
  const nextOverrides: Record<string, Override> = {};
  const nextRefusals: Record<string, string> = {};
  const rowOf = new Map<string, Row>();
  for (const row of rows) {
    const def = row && typeof row.setting_key === "string" ? defOf(row.setting_key) : undefined;
    if (!def) {
      warnOnce(`unknown\u0000${row?.setting_key}\u0000${row?.value}`, `Game setting "${row?.setting_key}" is not a known setting; skipped.`);
      continue;
    }
    rowOf.set(def.key, row);
  }
  // Number rows still in the running. Cross-checks between numbers (party against raid size, walk speed against the
  // multipliers) see the rows being loaded, not defaults that a row taken later would have replaced.
  const candidates = new Set<string>();
  for (const key of rowOf.keys()) if (defOf(key)?.kind === "number") candidates.add(key);
  let numbersTaken = false;
  const ctx: SettingContext = {
    maxLevel: 0,
    current: (key) => {
      const d = defOf(key);
      // While the numbers are taken, the level cap is held to the saved XP curve only: a health or stamina row that
      // does not fit the cap is refused on its own below (saves refuse that cap or formula up front).
      if (d?.kind === "formula" && rowOf.has(key) && (numbersTaken || key === "xpToNextLevel")) return String(rowOf.get(key)!.value);
      if (d?.kind === "number" && !numbersTaken && candidates.has(key)) return String(rowOf.get(key)!.value);
      return nextValues[key];
    },
  };
  /** Takes a row; false when it was refused (its default is kept). */
  const take = (key: string): boolean => {
    const row = rowOf.get(key);
    const def = defOf(key);
    if (!row || !def) return true;
    const result = validateValue(def, row.value, ctx);
    if (!result.ok) {
      nextRefusals[key] = result.error;
      warnOnce(`bad\u0000${key}\u0000${row.value}`, `Game setting "${key}" has a bad saved value; using the default. ${result.error}`);
      return false;
    }
    if (def.kind === "formula") {
      const fn = compiledOf(String(result.value));
      if (!fn) return false;
      nextFormulas.set(key, fn);
    }
    delete nextRefusals[key];
    nextValues[key] = result.value;
    nextOverrides[key] = { value: String(row.value), updatedBy: row.updated_by ?? "", updatedAt: Number(row.updated_at) || 0 };
    return true;
  };

  // Numbers first, so formulas are checked against the loaded level cap. A refused number row falls back to its
  // default, which rows already checked against it may not fit, so the numbers are taken again until none is refused.
  for (let refused = true; refused;) {
    refused = false;
    for (const d of SETTINGS) {
      if (d.kind !== "number") continue;
      delete nextOverrides[d.key];
      nextValues[d.key] = d.default;
    }
    for (const d of SETTINGS) {
      if (d.kind !== "number" || !candidates.has(d.key)) continue;
      if (!take(d.key)) {
        candidates.delete(d.key);
        refused = true;
        break;
      }
    }
  }
  numbersTaken = true;
  ctx.maxLevel = Number(nextValues.maxLevel) || 0;
  for (const d of SETTINGS) if (d.kind === "formula") take(d.key);

  values = nextValues;
  formulas = nextFormulas;
  overrideMap = nextOverrides;
  refusals = nextRefusals;
}

async function reload(): Promise<void> {
  let rows: Row[] = [];
  try {
    rows = (await io.read()) || [];
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    if (!missingTableLogged) {
      missingTableLogged = true;
      log.warn("The game_settings table does not exist yet; using the default game settings. Run the database setup.");
    }
  }
  apply(rows);
}

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      log.warn(`A game settings listener failed: ${error}`);
    }
  }
}

/** Reads the saved settings (the io given is remembered for later saves and reloads) and shares them across the cluster. */
export async function loadGameSettings(next?: SettingsIO): Promise<void> {
  io = next ? { ...defaultIO, ...next } : defaultIO;
  missingTableLogged = false;
  attachCacheListener(io.cache);
  await reload();
  // Only what changed is published: loading the same rows again tells the other nodes nothing new.
  if (JSON.stringify(overrideMap) !== lastPublished) await publish();
  notify();
}

/** Tells the other nodes the saved settings changed. */
async function publish(): Promise<void> {
  lastPublished = JSON.stringify(overrideMap);
  await assetCache.set("game_settings", overrideMap);
}

/**
 * Reads the settings again, after any reload already in flight, and tells the listeners. Resolves once done; it never
 * rejects. Used when another node said it saved, whichever of its news (cache change or editor nudge) comes first.
 */
export function readAgain(): Promise<void> {
  inFlight = inFlight
    .then(reload)
    .then(notify)
    .catch((error) => log.warn(`The game settings saved on another node could not be read again here: ${error}`));
  return inFlight;
}

/** Reads the settings again when another node saved them. */
function readAgainFromElsewhere(elsewhere: boolean): void {
  if (elsewhere) void readAgain();
}

/** Resolves once a reload of another node's save, if one is running, has finished (it never rejects). */
export const settled = (): Promise<void> => inFlight;

/** Why the last reload refused the saved value of `key`, if it did. */
export const refusalOf = (key: string): string | undefined => refusals[key];

const listening = new WeakSet<object>();

/** Listens for saves on other nodes, once per cache instance. Done when the settings load, not when this module does, so a cache that a test replaced first is the one listened to. */
function attachCacheListener(cache: CacheLike | undefined): void {
  if (!cache || typeof cache.onChange !== "function" || listening.has(cache)) return;
  listening.add(cache);
  cache.onChange("game_settings", readAgainFromElsewhere);
}

export function setting(key: string): number {
  const def = defOf(key);
  if (!def) throw new Error(`Unknown game setting "${key}".`);
  if (def.kind === "formula") throw new Error(`Game setting "${key}" is a formula; use formula().`);
  return Number(values[key] ?? def.default);
}

/** Formulas whose result goes into an INT column of the stats table, so it is held to that column at run time. */
const COLUMN_HELD = new Set(["maxHealth", "maxStamina"]);

/**
 * The formula as a function of level, floored; a result that is not finite falls back to the default formula's. Max
 * health and stamina never go past the stats column (MAX_XP_VALUE), at whatever level they are asked for.
 */
export function formula(key: string): (level: number) => number {
  const def = defOf(key);
  if (!def || def.kind !== "formula") throw new Error(`Game setting "${key}" is not a formula.`);
  const fallback = compiledOf(String(def.default))!;
  const held = COLUMN_HELD.has(key);
  return (level: number) => {
    const fn = formulas.get(key) ?? fallback;
    let out = Math.floor(fn(level));
    if (!Number.isFinite(out)) out = Math.floor(fallback(level));
    return held && out > MAX_XP_VALUE ? MAX_XP_VALUE : out;
  };
}

export const currentValues = (): Record<string, number | string> => ({ ...values });

export const overrides = (): Record<string, Override> => ({ ...overrideMap });

export function onSettingsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * After a write: reads the rows again and tells the other nodes. They are told even when the reload here fails, since
 * the row is written and they read it themselves; the failure is still thrown.
 */
async function persist(): Promise<void> {
  let failure: unknown;
  let failed = false;
  try {
    await reload();
  } catch (error) {
    failure = error;
    failed = true;
  }
  await publish();
  if (failed) throw failure;
  notify();
}

export async function saveSetting(key: string, value: unknown, by: string): Promise<void> {
  const def = defOf(key);
  if (!def) throw new Error(`Unknown game setting "${key}".`);
  const ctx: SettingContext = { maxLevel: Number(values.maxLevel) || 0, current: (k) => values[k] };
  const result = validateValue(def, value, ctx);
  if (!result.ok) throw new Error(result.error);
  await io.write(key, String(result.value), by);
  await persist();
}

/** Deletes the saved value of `key`; false, with nothing written or told, when it had none. */
export async function resetSetting(key: string, _by: string): Promise<boolean> {
  if (!defOf(key)) throw new Error(`Unknown game setting "${key}".`);
  if (!Object.hasOwn(overrideMap, key) && !Object.hasOwn(refusals, key)) return false;
  await io.remove(key);
  await persist();
  return true;
}

export const clientSettings = (): { walkSpeed: number; mountSpeedMultiplier: number; ghostSpeedMultiplier: number; chatMaxLength: number } => ({
  walkSpeed: setting("walkSpeed"),
  mountSpeedMultiplier: setting("mountSpeedMultiplier"),
  ghostSpeedMultiplier: setting("ghostSpeedMultiplier"),
  chatMaxLength: setting("chatMaxLength"),
});

values = defaultValues();
formulas = defaultFormulas();
