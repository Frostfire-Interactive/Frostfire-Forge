/** How long after a warp from one map to another (a map warp or a dungeon portal, in or out) a player waits before the next. */
export const WARP_COOLDOWN_MS = 1000;
/** How often a player walking into a warp during the wait is told how long is left. */
export const WARP_NOTICE_MS = 1000;

const lower = (username: string): string => String(username ?? "").toLowerCase();

// When each player can warp again (ms, as Date.now counts).
const readyAt = new Map<string, number>();

/** How long (ms) until `username` can warp again: 0 when they can now. Carried across a handoff. */
export function warpReadyIn(username: string, now: number = Date.now()): number {
    const name = lower(username);
    const at = readyAt.get(name);
    if (at === undefined) return 0;
    if (at <= now) {
        readyAt.delete(name);
        return 0;
    }
    return at - now;
}

/** Sets the wait left, at most a full cooldown. 0 or less ends it. */
export function setWarpReadyIn(username: string, ms: number, now: number = Date.now()): void {
    const name = lower(username);
    if (!name) return;
    const left = Math.min(Number(ms) || 0, WARP_COOLDOWN_MS);
    if (left > 0) readyAt.set(name, now + left);
    else readyAt.delete(name);
}

export function warpCooldownNotice(ms: number): string {
    const seconds = Math.max(1, Math.ceil(ms / 1000));
    return `You can warp again in ${seconds} second${seconds === 1 ? "" : "s"}.`;
}

/** A warp walked into: whether it waits out the cooldown, and the notice to show (null when one was shown under WARP_NOTICE_MS ago). */
export function warpWait(p: { username: string; _warpNoticeAt?: number }, now: number = Date.now()): { wait: false } | { wait: true; notice: string | null } {
    const left = warpReadyIn(p.username, now);
    if (left <= 0) return { wait: false };
    if (p._warpNoticeAt !== undefined && now - p._warpNoticeAt < WARP_NOTICE_MS) return { wait: true, notice: null };
    p._warpNoticeAt = now;
    return { wait: true, notice: warpCooldownNotice(left) };
}
