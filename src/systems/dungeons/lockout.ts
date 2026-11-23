export const LOCKOUT_ENTRIES = 10;
export const LOCKOUT_WINDOW_MS = 3_600_000;

export interface Lockout { windowStart: number; used: number }

export function currentLockout(l: Lockout, now: number): Lockout {
    if (l.windowStart !== 0 && now >= l.windowStart + LOCKOUT_WINDOW_MS) return { windowStart: 0, used: 0 };
    return { windowStart: l.windowStart, used: l.used };
}

export function canSpend(l: Lockout, now: number): boolean {
    return currentLockout(l, now).used < LOCKOUT_ENTRIES;
}

export function spend(l: Lockout, now: number): Lockout {
    const c = currentLockout(l, now);
    return { windowStart: c.windowStart === 0 ? now : c.windowStart, used: c.used + 1 };
}

/** One entry given back, when it was spent in the window that started at `windowStart` and that window is still the lockout's. */
export function unspend(l: Lockout, windowStart: number): Lockout {
    if (windowStart === 0 || l.windowStart !== windowStart || l.used <= 0) return { windowStart: l.windowStart, used: l.used };
    return { windowStart: l.windowStart, used: l.used - 1 };
}

/** Milliseconds until an entry can be spent; 0 when one can be spent now. */
export function lockoutWaitMs(l: Lockout, now: number): number {
    const c = currentLockout(l, now);
    if (c.used < LOCKOUT_ENTRIES) return 0;
    return Math.max(0, c.windowStart + LOCKOUT_WINDOW_MS - now);
}
