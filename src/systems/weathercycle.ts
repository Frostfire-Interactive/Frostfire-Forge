// The weather a "random" world settles on. It keeps it for a stretch of WEATHER_CYCLE_MS and settles again at the turn
// of the next. In a cluster every node that holds part of the world picks it on its own, so the pick comes from the
// world's name and the stretch alone, never from a roll: every node settles on the same weather at the same moment,
// and a world split between nodes shows one weather on both sides of a border.

/**
 * USER REQUEST 2026-10-17 (tornadoes, systems/tornadoes.ts): "tornado" is a thunderstorm with tornadoes. The client
 * draws it as a thunderstorm (rain, dark sky, lightning) and a world on it always has a tornado. Like "clear" it is a
 * word of /weather that needs no row of the weather table: without one it carries the thunderstorm's values. It is
 * never picked for a random world: a random world gets tornadoes by the rare chance every thunderstorm has.
 */
export const TORNADO = "tornado";

/** How long a "random" world keeps the weather it settled on. */
export const WEATHER_CYCLE_MS = 30 * 60 * 1000;

/** How long from `at` until the next stretch begins. */
export const nextCycleIn = (at: number = Date.now()): number => WEATHER_CYCLE_MS - (at % WEATHER_CYCLE_MS);

/**
 * The weather of the table a "random" world settles on for the stretch `at` falls in (never "tornado"); null when
 * there is none. The table is taken in name order, so the order it was read in changes nothing.
 */
export function settledPick<T extends { name: string }>(all: T[] | null | undefined, world: string, at: number = Date.now()): T | null {
  const pool = (all || []).filter((w) => w.name !== TORNADO).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (pool.length === 0) return null;
  const stretch = Math.floor(at / WEATHER_CYCLE_MS);
  return pool[Number(BigInt(Bun.hash(`${world}:${stretch}`)) % BigInt(pool.length))];
}
