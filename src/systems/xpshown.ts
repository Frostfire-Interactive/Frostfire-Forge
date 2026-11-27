// The level a character stops at, and the XP bar the client is shown there. A character at the limit keeps the XP
// they had (below max_xp, so a raised cap asks for the curve's target); the bar shows full only in what is sent.

import { setting, formula, onSettingsChanged } from "./gamesettings/store";
import { maxLevelCap } from "./gamesettings/registry";

// The last level whose XP target fits max_xp, for the saved curve. Worked out when first asked, and again after a settings change.
let curveCeiling: number | undefined;
onSettingsChanged(() => { curveCeiling = undefined; });
export const curveLimit = (): number => (curveCeiling ??= maxLevelCap(formula("xpToNextLevel")));

/** The level cap, or with none the last level whose XP target still fits max_xp (0 when there is no limit at all). */
export const levelLimit = (): number => (setting("maxLevel") > 0 ? setting("maxLevel") : curveLimit());

export const atLevelLimit = (level: unknown): boolean => {
  const limit = levelLimit();
  return limit > 0 && Number(level) >= limit;
};

/** `stats` as the client is shown it: at the level limit the XP bar is full. The object given is never changed. */
export function shownStats<T>(stats: T): T {
  const s = stats as any;
  if (!s || typeof s !== "object" || !("xp" in s) || !Number.isFinite(Number(s.max_xp)) || !atLevelLimit(s.level)) return stats;
  return { ...s, xp: s.max_xp };
}

/** A packet's data with its `stats` shown as above. */
export function withShownStats<T>(data: T): T {
  const d = data as any;
  if (!d || typeof d !== "object" || !d.stats) return data;
  const stats = shownStats(d.stats);
  return stats === d.stats ? data : { ...d, stats };
}
