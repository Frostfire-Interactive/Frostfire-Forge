import query from "../../controllers/sqldatabase";
import log from "../../modules/logger";
import { tableCache } from "../../services/datacache";
import { DEFAULT_MULTIPLIERS, PORTAL_COLOR_PATTERN, type DungeonDef, type DungeonSize } from "./types";
import { templateOf } from "./copykey";

const SIZES: DungeonSize[] = [5, 10, 20];

/** The sizes column ("5", "10", "20" or "10,20"), read as a sorted list of the sizes that exist. */
export function parseSizes(raw: unknown): DungeonSize[] {
    const found = String(raw ?? "").split(",").map((s) => Number(s.trim())).filter((n): n is DungeonSize => (SIZES as number[]).includes(n));
    return [...new Set(found)].sort((a, b) => a - b);
}

/** The multipliers column: JSON text or parsed. A size that is missing or unreadable has the default. */
export function parseMultipliers(raw: unknown): DungeonDef["multipliers"] {
    let value: any = raw;
    if (typeof raw === "string") {
        try { value = JSON.parse(raw); } catch { value = null; }
    }
    const out = {} as DungeonDef["multipliers"];
    for (const size of ["5", "10", "20"] as const) {
        const given = value?.[size];
        const health = Number(given?.health), damage = Number(given?.damage);
        out[size] = Number.isFinite(health) && Number.isFinite(damage)
            ? { health, damage }
            : { ...DEFAULT_MULTIPLIERS[size] };
    }
    return out;
}

function toDef(row: any): DungeonDef {
    return {
        id: Number(row.id),
        name: String(row.name ?? ""),
        map: String(row.map ?? ""),
        type: row.type === "raid" ? "raid" : "dungeon",
        sizes: parseSizes(row.sizes),
        multipliers: parseMultipliers(row.multipliers),
        entranceX: Number(row.entrance_x ?? row.entranceX) || 0,
        entranceY: Number(row.entrance_y ?? row.entranceY) || 0,
        enabled: row.enabled === true || Number(row.enabled) === 1,
        portalColor: typeof row.portal_color === "string" && PORTAL_COLOR_PATTERN.test(row.portal_color) ? row.portal_color.toLowerCase() : null,
    };
}

const rows = tableCache<DungeonDef>("dungeons", async () => {
    let list: any[];
    try {
        list = (await query("SELECT * FROM dungeons")) as any[];
    } catch (error) {
        // A database set up without the dungeons table has none, and must not stop the server from starting.
        if (!/no such table|doesn't exist|does not exist/i.test(String((error as Error)?.message ?? error))) throw error;
        log.warn(`Could not read the dungeons (run the database setup script): ${error}`);
        return [];
    }
    return (list || []).map(toDef);
});

export const dungeonDefs = {
    async all(): Promise<DungeonDef[]> {
        return (await rows.all()).sort((a, b) => a.name.localeCompare(b.name));
    },
    async get(id: number): Promise<DungeonDef | null> {
        const wanted = Number(id);
        if (!Number.isInteger(wanted)) return null;
        return (await rows.find((d) => d.id === wanted)) ?? null;
    },
    /** The dungeon on a map, by the template's bare name (a copy key or a .json name finds it too). */
    async byMap(map: string): Promise<DungeonDef | null> {
        const wanted = templateOf(String(map ?? ""));
        return (await rows.find((d) => d.map === wanted)) ?? null;
    },
    /** Insert (id null) or update, then the cache. Returns the id. */
    async save(def: Omit<DungeonDef, "id"> & { id: number | null }): Promise<number> {
        const columns = ["name", "map", "type", "sizes", "multipliers", "entrance_x", "entrance_y", "enabled", "portal_color"];
        const values = [def.name, def.map, def.type, [...def.sizes].sort((a, b) => a - b).join(","), JSON.stringify(def.multipliers), def.entranceX, def.entranceY, def.enabled ? 1 : 0, def.portalColor ?? null];
        let id = def.id;
        try {
            if (id !== null) {
                await query(`UPDATE dungeons SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, [...values, id]);
            } else {
                const result = (await query(`INSERT INTO dungeons (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, values)) as any;
                id = Number(result?.lastInsertRowid ?? result?.insertId) || null;
            }
        } catch (error) {
            await rows.drop();
            throw error;
        }
        if (id === null) {
            await rows.reload();
            const found = await rows.find((d) => d.map === def.map);
            if (!found) throw new Error("The dungeon was not kept.");
            return found.id;
        }
        const saved = { ...def, id } as DungeonDef;
        await rows.put(saved, (d) => d.id === saved.id);
        return id;
    },
    /** Deletes a dungeon. False when there was none. */
    async remove(id: number): Promise<boolean> {
        const had = await dungeonDefs.get(id);
        if (!had) return false;
        try {
            await query("DELETE FROM dungeons WHERE id = ?", [had.id]);
        } catch (error) {
            await rows.drop();
            throw error;
        }
        await rows.remove((d) => d.id === had.id);
        return true;
    },
};
