import * as settings from "../config/settings.json";

/** The rate the per-tick constants (the 6 px step, "every 10th tick") were tuned at. */
export const BASE_TICK_RATE = 30;
export const BASE_TICK_MS = 1000 / BASE_TICK_RATE;
export const DEFAULT_TICK_RATE = 60;
export const MIN_TICK_RATE = 20;
export const MAX_TICK_RATE = 120;

/** The first of `sources` that is a number from MIN_TICK_RATE to MAX_TICK_RATE; DEFAULT_TICK_RATE if none is. */
export function resolveTickRate(...sources: unknown[]): number {
  for (const source of sources) {
    if (source === undefined || source === null || source === "") continue;
    const rate = Number(source);
    if (Number.isFinite(rate) && rate >= MIN_TICK_RATE && rate <= MAX_TICK_RATE) return rate;
  }
  return DEFAULT_TICK_RATE;
}

export const TICK_RATE = resolveTickRate(process.env.TICK_RATE, (settings as any)?.tickRate);
export const TICK_MS = 1000 / TICK_RATE;

/** How many ticks at `tickRate` make up `ms`, never fewer than one. */
export function ticksFor(ms: number, tickRate: number = TICK_RATE): number {
  return Math.max(1, Math.round((ms * tickRate) / 1000));
}

export function cadenceDue(elapsedMs: number, intervalMs: number, tickMs: number = TICK_MS): boolean {
  return elapsedMs >= intervalMs - tickMs / 2;
}

export function scaledStep(step30: number, carry: number, tickRate: number = TICK_RATE): { move: number; carry: number } {
  const exact = Math.round(step30) * (BASE_TICK_RATE / tickRate) + carry;
  const move = Math.round(exact);
  return { move, carry: exact - move };
}
