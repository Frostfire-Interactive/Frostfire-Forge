// An admin's /speed (socket/handlers/commands.ts): their whole walk speed as a multiple of the base walk speed, read
// by the movement handler in place of mount, ghost form and slows.

/** The most /speed allows: 5 times the base step is 30 px a tick, under a tile, so a step cannot pass through a wall. */
export const MAX_SPEED_OVERRIDE = 5;
export const MIN_SPEED_OVERRIDE = 0.1;

/** A player's /speed walk speed for a base step of `base` px, or null when they have none (their speed is as usual). */
export function overriddenSpeed(currentPlayer: { speedOverride?: unknown }, base: number): number | null {
  const override = Number(currentPlayer.speedOverride);
  if (!(override > 0)) return null;
  return base * Math.min(Math.max(override, MIN_SPEED_OVERRIDE), MAX_SPEED_OVERRIDE);
}
