import { setting } from "./gamesettings/store";

/** What one regen tick restores of a pool of `max`, `percent` percent of it: at least 1, or nothing when the percent is 0. */
export function regenAmount(max: number, percent: number): number {
  if (!(percent > 0)) return 0;
  return Math.max(1, Math.floor(max * (percent / 100)));
}

/** Health restored by one regen tick (out of combat). */
export const healthRegenAmount = (maxHealth: number): number => regenAmount(maxHealth, setting("healthRegenPercent"));

/** Stamina restored by one regen tick. */
export const staminaRegenAmount = (maxStamina: number): number => regenAmount(maxStamina, setting("staminaRegenPercent"));

/** Whether a player whose last attack was `sinceAttackMs` ago is no longer flagged as in combat. */
export const pvpFlagExpired = (sinceAttackMs: number): boolean => sinceAttackMs > setting("pvpFlagSeconds") * 1000;

/** A pool of `max` holding `current` after one regen tick of `percent`: never past max. Unchanged when the percent is 0, so no stats frame is due. */
export function regenTo(current: number, max: number, percent: number): number {
  if (current >= max) return current;
  return Math.min(max, current + regenAmount(max, percent));
}
