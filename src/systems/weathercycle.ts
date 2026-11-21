export const TORNADO = "tornado";

/** How long a "random" world keeps the weather it settled on. */
export const WEATHER_CYCLE_MS = 30 * 60 * 1000;

/** How long from `at` until the next stretch begins. */
export const nextCycleIn = (at: number = Date.now()): number => WEATHER_CYCLE_MS - (at % WEATHER_CYCLE_MS);

export function settledPick<T extends { name: string }>(all: T[] | null | undefined, world: string, at: number = Date.now()): T | null {
  const pool = (all || []).filter((w) => w.name !== TORNADO).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (pool.length === 0) return null;
  const stretch = Math.floor(at / WEATHER_CYCLE_MS);
  return pool[Number(BigInt(Bun.hash(`${world}:${stretch}`)) % BigInt(pool.length))];
}
