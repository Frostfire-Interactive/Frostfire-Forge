import query from "../../controllers/sqldatabase";
import { rowCache, turns } from "../../services/datacache";
import { characterIdOf, needCharacterId } from "../characterids";
import { canSpend, lockoutWaitMs, spend, unspend, type Lockout } from "./lockout";
import type { PortalSpot } from "./types";

interface Row {
    window_start: number;
    used: number;
    portal_map: string | null;
    portal_x: number | null;
    portal_y: number | null;
}

const NONE: Row = { window_start: 0, used: 0, portal_map: null, portal_x: null, portal_y: null };

const whole = (value: unknown) => (Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0);

const rows = rowCache<Row>("dungeon_characters", async (username) => {
    const characterId = await characterIdOf(String(username));
    if (characterId === null) return { ...NONE };
    const [row] = (await query("SELECT window_start, used, portal_map, portal_x, portal_y FROM dungeon_characters WHERE character_id = ?", [characterId])) as any[];
    if (!row) return { ...NONE };
    const has = row.portal_map !== null && row.portal_map !== undefined && row.portal_x !== null && row.portal_y !== null;
    return {
        window_start: whole(row.window_start),
        used: whole(row.used),
        portal_map: has ? String(row.portal_map) : null,
        portal_x: has ? whole(row.portal_x) : null,
        portal_y: has ? whole(row.portal_y) : null,
    };
}, { perPlayer: true });

const oneAtATime = turns();

async function write(username: string, sql: string, values: (characterId: number) => unknown[], columns: Partial<Row>): Promise<void> {
    const before = (await rows.get(username)) ?? { ...NONE };
    try {
        await query(sql, values(await needCharacterId(username)) as any[]);
    } catch (error) {
        await rows.drop(username);
        throw error;
    }
    await rows.set(username, { ...before, ...columns });
}

const lockoutOf = (row: Row): Lockout => ({ windowStart: row.window_start, used: row.used });

export const dungeonCharacters = {
    async lockout(username: string): Promise<Lockout> {
        return lockoutOf((await rows.get(username)) ?? NONE);
    },
    /** Checks and spends one entry inside one turn, so two entries at once cannot both take the last one. */
    trySpend(username: string, now: number): Promise<{ ok: boolean; waitMs: number; windowStart: number }> {
        return oneAtATime(username, async () => {
            const current = lockoutOf((await rows.get(username)) ?? NONE);
            if (!canSpend(current, now)) return { ok: false, waitMs: lockoutWaitMs(current, now), windowStart: current.windowStart };
            const next = spend(current, now);
            await write(
                username,
                "INSERT INTO dungeon_characters (character_id, window_start, used) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE window_start = ?, used = ?",
                (id) => [id, next.windowStart, next.used, next.windowStart, next.used],
                { window_start: next.windowStart, used: next.used },
            );
            return { ok: true, waitMs: 0, windowStart: next.windowStart };
        });
    },
    /** Gives back one entry spent in the window that started at `windowStart`; nothing once that window has gone. */
    refund(username: string, windowStart: number): Promise<void> {
        return oneAtATime(username, async () => {
            const current = lockoutOf((await rows.get(username)) ?? NONE);
            const next = unspend(current, windowStart);
            if (next.used === current.used && next.windowStart === current.windowStart) return;
            await write(
                username,
                "INSERT INTO dungeon_characters (character_id, window_start, used) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE window_start = ?, used = ?",
                (id) => [id, next.windowStart, next.used, next.windowStart, next.used],
                { window_start: next.windowStart, used: next.used },
            );
        });
    },
    reset(username: string): Promise<void> {
        return oneAtATime(username, async () => {
            const row = (await rows.get(username)) ?? NONE;
            if (row.window_start === 0 && row.used === 0) return;
            await write(
                username,
                "INSERT INTO dungeon_characters (character_id, window_start, used) VALUES (?, 0, 0) ON DUPLICATE KEY UPDATE window_start = 0, used = 0",
                (id) => [id],
                { window_start: 0, used: 0 },
            );
        });
    },
    async portal(username: string): Promise<PortalSpot | null> {
        const row = (await rows.get(username)) ?? NONE;
        if (row.portal_map === null || row.portal_x === null || row.portal_y === null) return null;
        return { map: row.portal_map, x: row.portal_x, y: row.portal_y };
    },
    setPortal(username: string, spot: PortalSpot): Promise<void> {
        return oneAtATime(username, () => write(
            username,
            "INSERT INTO dungeon_characters (character_id, portal_map, portal_x, portal_y) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE portal_map = ?, portal_x = ?, portal_y = ?",
            (id) => [id, spot.map, spot.x, spot.y, spot.map, spot.x, spot.y],
            { portal_map: spot.map, portal_x: spot.x, portal_y: spot.y },
        ));
    },
};
