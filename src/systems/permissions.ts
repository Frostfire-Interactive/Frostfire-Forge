import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import { rowCache, tableCache, turns } from "../services/datacache";
import { NoSuchCharacter, accountNameOf, siblingNamesOf } from "./characterids";

/** A row of the permissions table: `permissions` is the comma-separated list. */
type PermissionsRow = { permissions: string };

/** The longest list the permissions column holds as it was given. */
const LIST_LENGTH = 255;

const rows = rowCache<PermissionsRow[]>("permissions", async (username) => {
    const account = await accountNameOf(username);
    if (!account) return [];
    return (await query("SELECT permissions FROM permissions WHERE username = ?", [account])) as PermissionsRow[] || [];
}, { perPlayer: true });

const types = tableCache<{ name: string }>("permission_types", async () =>
    (await query("SELECT name FROM permission_types")) as { name: string }[] || []
);

const oneAtATime = turns();

function write(username: string, sql: string, values: (account: string) => unknown[], left: PermissionsRow[] | null): Promise<void> {
    return oneAtATime(username, async () => {
        try {
            const account = await accountNameOf(username);
            if (!account) throw new NoSuchCharacter(username);
            await query(sql, values(account));
        } catch (error) {
            await rows.drop(username);
            throw error;
        }
        if (left) await rows.set(username, left);
        else await rows.drop(username);
        // The account's other characters hold the same row.
        for (const other of await siblingNamesOf(username)) {
            if (other.toLowerCase() !== String(username).toLowerCase()) await rows.drop(other);
        }
    });
}

/** A stored comma-separated list as its names. */
export function names(list: string | null | undefined): string[] {
    return String(list ?? "").split(",").map((p) => p.trim()).filter(Boolean);
}

/** Whether `held` includes `name`, itself or as its family's `family.*`. */
export function covers(held: readonly string[], name: string): boolean {
    if (held.includes(name)) return true;
    const dot = name.indexOf(".");
    return dot > 0 && held.includes(`${name.slice(0, dot)}.*`);
}

export function canGrant(held: readonly string[], name: string): boolean {
    if (held.includes("server.*")) return true;
    if (name.startsWith("server.")) return held.includes(name);
    return held.includes("permission.*") || covers(held, name);
}

export function outranks(held: readonly string[], target: readonly string[]): boolean {
    return target.every((name) => canGrant(held, name));
}

const permissions = {
    clear: async (username: string) => {
        await write(username, "DELETE FROM permissions WHERE username = ?", (account) => [account], []);
        log.info(`Permissions cleared for ${username}`);
    },
    set: async (username: string, permissions: string | string[]) => {

        const perms = typeof permissions === "string" ? [permissions] : permissions;

        const uniquePerms = Array.from(new Set(perms));
        const list = uniquePerms.join(",");
        await write(
            username,
            "INSERT INTO permissions (username, permissions) VALUES (?, ?) ON DUPLICATE KEY UPDATE permissions = ?",
            (account) => [account, list, list],
            // A list longer than the column is cut short by some databases: what is stored is then read, not assumed.
            list.length <= LIST_LENGTH ? [{ permissions: list }] : null
        );
        log.info(`Permissions ${uniquePerms.join(",")} set for ${username}`);
    },
    get: async (username: string) => {

        const response = (await rows.get(username)) ?? [];
        if (response.length === 0) return "";
        return response[0]?.permissions || "";
    },
    /** What the player holds, as names. */
    held: async (username: string) => names(await permissions.get(username) as string),
    add: async (username: string, permission: string) => {

        const response = await permissions.get(username) as string;
        const accessSet = new Set(response.split(",").filter(Boolean));
        if (accessSet.has(permission)) return;
        accessSet.add(permission);
        await permissions.set(username, Array.from(accessSet));
        log.info(`Permission ${permission} added to ${username}`);
    },
    remove: async (username: string, permission: string) => {

        const response = await permissions.get(username) as string;
        const accessSet = new Set(response.split(",").filter(Boolean));
        if (!accessSet.has(permission)) return;
        accessSet.delete(permission);
        await permissions.set(username, Array.from(accessSet));
        log.info(`Permission ${permission} removed from ${username}`);
    },
    list: async() => {

        const response = await types.all();
        return response.map((permission) => permission.name);
    }
}

export default permissions;
