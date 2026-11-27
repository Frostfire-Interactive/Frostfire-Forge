import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import { SETTINGS, defOf, validateValue, type SettingContext, type SettingDef } from "./gamesettings/registry";
import { compileFormula } from "./gamesettings/formula";
import { currentValues, overrides, refusalOf, resetSetting, saveSetting, settled } from "./gamesettings/store";

export const EDITOR_PERMISSIONS = ["tools.gamesettings", "tools.*", "server.admin", "server.*"];
export const DENIED = "You don't have permission to use the game settings editor.";

const sqlite = () => (process.env.DATABASE_ENGINE || "mysql") === "sqlite";

// -------------------------------------------------------------- permission

export function canUseEditor(player: any): boolean {
  if (!player || player.isGuest) return false;
  if (player.isAdmin) return true;
  const held: string[] = Array.isArray(player.permissions) ? player.permissions : [];
  return held.some((p) => EDITOR_PERMISSIONS.includes(p));
}

/** The editor's permission, so it can be granted where the permissions are picked from a list. Never throws. */
export async function ensureGameSettingsPermission(): Promise<void> {
  try {
    await query(`INSERT ${sqlite() ? "OR IGNORE" : "IGNORE"} INTO permission_types (name) VALUES ('tools.gamesettings')`);
  } catch {
    // no permission_types table: nothing lists them
  }
}

// ------------------------------------------------------------------ editor

export interface EditorSetting extends SettingDef {
  value: number | string;
  /** A row is saved for it, kept or not. */
  overridden: boolean;
  /** Why the last reload refused the saved row (the default is in force); only when it did. */
  refused?: string;
  updatedBy?: string;
  updatedAt?: number;
}

export interface EditorData {
  sections: string[];
  settings: EditorSetting[];
  maxLevel: number;
}

/** What a preview shows: the value at levels 1 to 20 and at the cap, saved nowhere. */
export interface PreviewData {
  ok: boolean;
  error?: string;
  rows: Array<[number, number]>;
  /** The value previewed, as it was sent, so an answer is matched to the text it is for. */
  value: number | string;
}

const PREVIEW_LEVELS = 20;

export function buildEditorData(): EditorData {
  const values = currentValues();
  const saved = overrides();
  return {
    sections: [...new Set(SETTINGS.map((d) => d.section))],
    settings: SETTINGS.map((d) => {
      const row = saved[d.key];
      // A row the reload refused is still saved: it is listed as such, with why, so it can be reset.
      const refused = row ? undefined : refusalOf(d.key);
      return {
        ...d,
        value: values[d.key] ?? d.default,
        overridden: !!row || refused !== undefined,
        ...(refused !== undefined ? { refused } : {}),
        ...(row ? { updatedBy: row.updatedBy, updatedAt: row.updatedAt } : {}),
      };
    }),
    maxLevel: Number(values.maxLevel) || 0,
  };
}

export type EditorAnswer =
  | { kind: "data"; data: EditorData }
  | {
    kind: "result"; ok: boolean; errors: string[]; fields?: Record<string, string>; name: string | null;
    denied?: boolean; data: EditorData | PreviewData | null;
    /** The settings changed: the other open editors are told. */
    changed?: boolean;
  };

const contextNow = (): SettingContext => {
  const values = currentValues();
  return { maxLevel: Number(values.maxLevel) || 0, current: (k) => currentValues()[k] };
};

/** The formulas the game floors when it uses them (store.ts formula()); a preview of any other shows the real value. */
const FLOORED_FORMULAS = new Set(["xpToNextLevel", "maxHealth", "maxStamina"]);

/** Rows of a formula at levels 1 to 20, and at the cap when it is past them, floored as the game floors that formula. */
export function previewRows(def: SettingDef, text: string, cap: number): Array<[number, number]> {
  const compiled = compileFormula(text);
  if (!compiled.ok) return [];
  const levels = Array.from({ length: PREVIEW_LEVELS }, (_, i) => i + 1);
  if (cap > PREVIEW_LEVELS) levels.push(cap);
  const shown = FLOORED_FORMULAS.has(def.key) ? Math.floor : (n: number) => n;
  return levels.map((level) => [level, shown(compiled.fn(level))] as [number, number]);
}

/** The XP formula's text in force now. */
const xpText = (): string => String(currentValues().xpToNextLevel ?? defOf("xpToNextLevel")!.default);

/**
 * What a save would hold, checked by the registry under the current values (a level cap there is also held to the XP
 * curve, and to the health and stamina formulas). Nothing is written.
 */
function check(def: SettingDef, raw: unknown): { ok: true; value: number | string } | { ok: false; error: string } {
  return validateValue(def, raw, contextNow());
}

function preview(def: SettingDef, raw: unknown): PreviewData {
  const value = typeof raw === "number" ? raw : String(raw ?? "");
  const result = check(def, raw);
  if (!result.ok) return { ok: false, error: result.error, rows: [], value };
  const cap = Number(currentValues().maxLevel) || 0;
  if (def.kind === "formula") return { ok: true, rows: previewRows(def, String(result.value), cap), value };
  // A level cap shows the XP each level asks for, under the curve in force and the candidate cap.
  if (def.key === "maxLevel") return { ok: true, rows: previewRows(defOf("xpToNextLevel")!, xpText(), Number(result.value)), value };
  return { ok: true, rows: [], value };
}

/** Whether the value in force for `def` is `wanted`, as the registry gave it back. */
const holds = (def: SettingDef, wanted: number | string): boolean => {
  const now = currentValues()[def.key];
  return def.kind === "number" ? Number(now) === Number(wanted) : String(now).trim() === String(wanted).trim();
};

/** The field error for a save or reset the reload after it did not keep. */
const notKept = (def: SettingDef): string => {
  const why = refusalOf(def.key);
  const now = currentValues()[def.key];
  return `The server did not keep this value; ${def.label} is ${now}${why ? `. ${why}` : "."}`;
};

/** One packet of the editor. Permission is checked first, on every one. */
export async function handleEditorPacket(admin: any, type: string, data: any): Promise<EditorAnswer> {
  if (!canUseEditor(admin)) return { kind: "result", ok: false, errors: [DENIED], name: null, denied: true, data: null };
  // A save on another node may still be being read here: answer from, and check against, the values it brings.
  await settled();
  if (type === "GAME_SETTINGS_EDITOR_LIST") return { kind: "data", data: buildEditorData() };

  const key = String(data?.key ?? "").trim();
  const def = defOf(key);
  const refused = (errors: string[], fields?: Record<string, string>, changed?: true): EditorAnswer =>
    ({ kind: "result", ok: false, errors, fields, name: def?.key ?? null, data: buildEditorData(), ...(changed ? { changed } : {}) });
  if (!def) return refused([key ? `There is no setting called ${key}.` : "Pick a setting."]);

  if (type === "GAME_SETTINGS_EDITOR_PREVIEW") {
    const shown = preview(def, data?.value);
    return {
      kind: "result", ok: shown.ok, errors: shown.error ? [shown.error] : [],
      fields: shown.error ? { [def.key]: shown.error } : undefined, name: def.key, data: shown,
    };
  }

  if (type === "GAME_SETTINGS_EDITOR_SAVE") {
    const result = check(def, data?.value);
    if (!result.ok) return refused([result.error], { [def.key]: result.error });
    try {
      await saveSetting(def.key, result.value, admin.username);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`[GameSettings] ${admin.username} could not save ${def.key}: ${message}`);
      return refused([message], { [def.key]: message });
    }
    if (!holds(def, result.value)) {
      // The row is written, so the other editors are still told; this one hears that it did not take.
      const message = notKept(def);
      log.warn(`[GameSettings] ${admin.username} saved ${def.key} as ${result.value}, but it was not kept: ${message}`);
      return refused([message], { [def.key]: message }, true);
    }
    log.info(`[GameSettings] ${admin.username} set ${def.key} to ${result.value}.`);
    return { kind: "result", ok: true, errors: [], name: def.key, data: buildEditorData(), changed: true };
  }

  if (type === "GAME_SETTINGS_EDITOR_RESET") {
    // Back to the default must hold under the other values too (a level cap against its XP curve, say).
    const back = check(def, def.default);
    if (!back.ok) {
      const message = `The default would not hold: ${back.error}`;
      return refused([message], { [def.key]: message });
    }
    let removed: boolean;
    try {
      removed = await resetSetting(def.key, admin.username);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`[GameSettings] ${admin.username} could not reset ${def.key}: ${message}`);
      return refused([message], { [def.key]: message });
    }
    // Nothing was saved for it: nothing was written, and nobody needs telling.
    if (!removed) return { kind: "result", ok: true, errors: [], name: def.key, data: buildEditorData() };
    if (!holds(def, back.value)) {
      const message = notKept(def);
      log.warn(`[GameSettings] ${admin.username} reset ${def.key}, but the default was not kept: ${message}`);
      return refused([message], { [def.key]: message }, true);
    }
    log.info(`[GameSettings] ${admin.username} reset ${def.key} to its default.`);
    return { kind: "result", ok: true, errors: [], name: def.key, data: buildEditorData(), changed: true };
  }

  return refused([`Unknown request ${type}.`]);
}
