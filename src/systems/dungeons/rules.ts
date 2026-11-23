import { canSpend, lockoutWaitMs, type Lockout } from "./lockout";
import { isCopyKey } from "./copykey";
import type { CopyRecord, DungeonDef, DungeonPortalObject, DungeonSize, EntryDecision, PortalSpot } from "./types";

export const EMPTY_CLOSE_MS = 300_000;
export const STRANDED_MS = 60_000;
const DUNGEON_PARTY_LIMIT = 5;

const newest = (copies: CopyRecord[]): CopyRecord | null =>
    copies.reduce<CopyRecord | null>((best, c) => (best === null || c.openedAt > best.openedAt ? c : best), null);

export function decideEntry(input: {
    username: string; party: string[]; leader: string | null; def: DungeonDef;
    copies: CopyRecord[]; lockout: Lockout; now: number; size?: DungeonSize;
}): EntryDecision {
    const { username, party, leader, def, copies, lockout, now, size } = input;

    // Names compare without case: parties store them lowercase.
    const me = username.toLowerCase();
    const hasMe = (c: CopyRecord) => c.entered.some((name) => name.toLowerCase() === me);

    // In a party, the party's copy wins over the player's own.
    const others = new Set(party.map((name) => name.toLowerCase()).filter((name) => name !== me));
    const partyCopy = newest(copies.filter((c) => c.entered.some((name) => others.has(name.toLowerCase()))));
    if (partyCopy && hasMe(partyCopy)) return { kind: "rejoin", copy: partyCopy };

    const own = partyCopy ? null : newest(copies.filter(hasMe));
    if (own) return { kind: "rejoin", copy: own };

    if (!def.enabled) return { kind: "refuse", reason: "disabled" };

    const spendable = canSpend(lockout, now);
    const noEntries = (): EntryDecision => ({ kind: "refuse", reason: "no_entries", waitMs: lockoutWaitMs(lockout, now) });

    if (partyCopy) {
        if (partyCopy.entered.length >= partyCopy.size) return { kind: "refuse", reason: "copy_full" };
        if (!spendable) return noEntries();
        return { kind: "join", copy: partyCopy };
    }

    if (def.type === "dungeon" && party.length > DUNGEON_PARTY_LIMIT) {
        return { kind: "refuse", reason: "party_too_big", limit: DUNGEON_PARTY_LIMIT };
    }
    if (def.type === "raid" && party.length > 0 && leader?.toLowerCase() !== me) {
        return { kind: "refuse", reason: "leader_must_open" };
    }

    let chosen: DungeonSize;
    if (size !== undefined) chosen = size;
    else if (def.sizes.length === 1) chosen = def.sizes[0]!;
    else return { kind: "choose_size", sizes: def.sizes };

    if (party.length > chosen) return { kind: "refuse", reason: "party_too_big", limit: chosen };
    if (!spendable) return noEntries();
    return { kind: "open", size: chosen };
}

export function refusalMessage(d: Extract<EntryDecision, { kind: "refuse" }>): string {
    switch (d.reason) {
        case "disabled": return "This dungeon is closed.";
        case "copy_full": return "This dungeon is full.";
        case "party_too_big": return `Your group is too large for this dungeon (limit ${d.limit}).`;
        case "leader_must_open": return "Your party leader must open this raid.";
        case "no_entries": return `You have used all 10 dungeon entries this hour. Next entry in ${Math.ceil((d.waitMs ?? 0) / 60000)} min.`;
    }
}

export function closeDue(copy: CopyRecord, playersInside: number, now: number): boolean {
    if (playersInside > 0) return false;
    if (copy.cleared) return true;
    return copy.emptySince !== null && now - copy.emptySince >= EMPTY_CLOSE_MS;
}

/** Players with no one else in the copy in a party with them. A player alone in the copy is never stranded. */
export function strandedPlayers(inside: Array<{ username: string; partyId: number | null }>): string[] {
    if (inside.length <= 1) return [];
    const counts = new Map<number, number>();
    for (const p of inside) if (p.partyId !== null) counts.set(p.partyId, (counts.get(p.partyId) ?? 0) + 1);
    return inside.filter((p) => p.partyId === null || (counts.get(p.partyId) ?? 0) < 2).map((p) => p.username);
}

/** When each stranded player was first seen stranded; anyone not stranded now is dropped. */
export function strandedSince(prev: Map<string, number>, stranded: string[], now: number): Map<string, number> {
    const next = new Map<string, number>();
    for (const name of stranded) next.set(name, prev.get(name) ?? now);
    return next;
}

export function dueStranded(since: Map<string, number>, now: number): string[] {
    return [...since].filter(([, at]) => now - at >= STRANDED_MS).map(([name]) => name);
}

/** Where a released spirit goes: the graveyard outside copies, the entrance inside one, the portal when the entrance is not known. */
export function releasePlan(map: string, entrance: { x: number; y: number } | null):
    { kind: "graveyard" } | { kind: "entrance"; x: number; y: number } | { kind: "portal" } {
    if (!isCopyKey(map)) return { kind: "graveyard" };
    return entrance ? { kind: "entrance", x: entrance.x, y: entrance.y } : { kind: "portal" };
}

export const COPY_EDITOR_NOTICE = "Leave the dungeon to edit its map";

/** The editor packets that write a map. Each is one editors.ts handles (dungeon-glue.test.ts checks it). */
export const COPY_EDITOR_REFUSED: ReadonlySet<string> = new Set([
    "EDITOR_TILE_EDIT", "EDITOR_LAYER_LOCK", "EDITOR_OPEN", "SAVE_MAP",
    "MAILBOX_EDITOR_SAVE", "MAILBOX_EDITOR_DELETE", "GATHERING_EDITOR_SAVE", "GATHERING_EDITOR_DELETE", "FISHING_EDITOR_SAVE",
    "CREATURE_EDITOR_SAVE_SPAWN", "CREATURE_EDITOR_DELETE_SPAWN", "CREATURE_EDITOR_SAVE_PATH", "CREATURE_EDITOR_DELETE_PATH",
    "PORTAL_EDITOR_LIST", "PORTAL_EDITOR_SAVE", "PORTAL_EDITOR_DELETE",
]);

const copyName = (map: unknown): boolean => typeof map === "string" && isCopyKey(map);

/** Map editor actions on a copy are refused: its map is a clone, and a save would land on the template. A copy is the map the player stands on, or the map the packet names (mapName or map). */
export function editorRefusedInCopy(type: string, map: string | null | undefined, data?: unknown): boolean {
    if (!COPY_EDITOR_REFUSED.has(type)) return false;
    const named = data && typeof data === "object" ? data as { mapName?: unknown; map?: unknown } : null;
    return copyName(map) || copyName(named?.mapName) || copyName(named?.map);
}

const within = (portal: DungeonPortalObject, p: { x: number; y: number }): boolean =>
    p.x >= portal.position.x && p.x < portal.position.x + portal.size.width &&
    p.y >= portal.position.y && p.y < portal.position.y + portal.size.height;

/** In front of a portal: on or below its rectangle's bottom edge (its arch's foot). */
const inFront = (portal: DungeonPortalObject, p: { x: number; y: number }): boolean =>
    p.y >= portal.position.y + portal.size.height;

/**
 * A portal fires only when the player walks into it from the front: from in front of its rectangle (up across its
 * bottom edge, diagonals included) to inside it. Coming from behind or from a side never fires it; its arch blocks
 * those ways in anyway (systems/portalarch.ts).
 */
export function portalEntered(portals: DungeonPortalObject[], before: { x: number; y: number }, after: { x: number; y: number }): DungeonPortalObject | null {
    for (const portal of portals) if (inFront(portal, before) && within(portal, after)) return portal;
    return null;
}

export function loginPlacement(i: { savedMap: string; copyOpen: boolean; onEnteredList: boolean; portal: PortalSpot | null }):
    { kind: "as_saved" } | { kind: "portal"; spot: PortalSpot } | { kind: "default" } {
    if (!isCopyKey(i.savedMap)) return { kind: "as_saved" };
    if (i.copyOpen && i.onEnteredList) return { kind: "as_saved" };
    return i.portal ? { kind: "portal", spot: i.portal } : { kind: "default" };
}

export function scaledMaxHealth(base: number, mult: number): number {
    return Math.max(1, Math.round(base * mult));
}
