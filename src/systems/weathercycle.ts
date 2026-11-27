import { onSettingsChanged, setting } from "./gamesettings/store";

export const TORNADO = "tornado";

/** How long a "random" world keeps the weather it settled on (read when used). */
export const weatherCycleMs = (): number => setting("weatherCycleMinutes") * 60 * 1000;

// A cycle length change applies from the next weather change: the stretch running when it changed keeps its weather
// and its end (`held.first`). The next stretch (`held.bridge`) runs from that end to the first epoch boundary of the
// new length at least one new length later, so it is never shorter than the new length; from there the stretches are
// counted from the epoch, as before. Each node holds the stretch it was in when it heard of the save, and the bridge
// is worked out from that stretch's end and the new length alone, so nodes agree once the bridge ends.
type Stretch = { from: number; until: number; stretch: number };
let lastCycle: number | undefined;
let held: { first: Stretch; bridge: Stretch } | null = null;

const within = (s: Stretch, at: number): boolean => at >= s.from && at < s.until;

/** The stretch after `first` under the new length `cycle`: to the first boundary at least `cycle` past its end. */
function bridgeAfter(first: Stretch, cycle: number): Stretch {
  const until = Math.ceil((first.until + cycle) / cycle) * cycle;
  return { from: first.until, until, stretch: until / cycle - 1 };
}

/** The stretch `at` falls in under `cycle`, the held ones first. */
function stretchUnder(at: number, cycle: number): Stretch {
  if (held && within(held.first, at)) return held.first;
  if (held && within(held.bridge, at)) return held.bridge;
  const stretch = Math.floor(at / cycle);
  return { from: stretch * cycle, until: (stretch + 1) * cycle, stretch };
}

function noteCycle(at: number): void {
  const cycle = weatherCycleMs();
  if (lastCycle !== undefined && cycle !== lastCycle) {
    const first = stretchUnder(at, lastCycle);
    held = { first, bridge: bridgeAfter(first, cycle) };
  }
  lastCycle = cycle;
}

onSettingsChanged(() => noteCycle(Date.now()));

/** The stretch `at` falls in, and when it ends. */
function stretchAt(at: number): { stretch: number; until: number } {
  if (lastCycle === undefined) lastCycle = weatherCycleMs();
  const { stretch, until } = stretchUnder(at, weatherCycleMs());
  return { stretch, until };
}

/** How long from `at` until the next stretch begins. */
export const nextCycleIn = (at: number = Date.now()): number => stretchAt(at).until - at;

export function settledPick<T extends { name: string }>(all: T[] | null | undefined, world: string, at: number = Date.now()): T | null {
  const pool = (all || []).filter((w) => w.name !== TORNADO).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (pool.length === 0) return null;
  const { stretch } = stretchAt(at);
  return pool[Number(BigInt(Bun.hash(`${world}:${stretch}`)) % BigInt(pool.length))];
}
