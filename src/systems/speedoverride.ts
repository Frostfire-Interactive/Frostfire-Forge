/** The most /speed allows: 5 times the base step. */
export const MAX_SPEED_OVERRIDE = 5;
export const MIN_SPEED_OVERRIDE = 0.1;

/** The longest step a 30 Hz tick may take: under a tile, so a step cannot pass through a wall whatever the walk speed setting. */
export const MAX_STEP_PX = 30;

/** A player's /speed walk speed for a base step of `base` px, or null when they have none (their speed is as usual). */
export function overriddenSpeed(currentPlayer: { speedOverride?: unknown }, base: number): number | null {
  const override = Number(currentPlayer.speedOverride);
  if (!(override > 0)) return null;
  return Math.min(base * Math.min(Math.max(override, MIN_SPEED_OVERRIDE), MAX_SPEED_OVERRIDE), MAX_STEP_PX);
}
