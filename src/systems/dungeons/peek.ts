import { bareName, isCopyKey, templateOf } from "./copykey";
import type { CopyRecord, DungeonPortalObject, PortalSpot } from "./types";
import { arrivalSpot } from "../portalpairs";

/**
 * Live portals: what the far side of a portal shows a viewer, and the players there. Resolving it has no side effects:
 * it never opens a copy, spends an entry or changes a copy's entered list.
 */

/** How often a peek feed is sent (ms), 30 a second. */
export const PEEK_RATE_MS = 1000 / 30;
/** Portals one viewer may stream at once. */
export const PEEK_CAP = 2;
/** Half the far side the opening shows (map pixels), with a margin, around the far place. */
export const PEEK_HALF_W = 96;
export const PEEK_HALF_H = 160;
export const PEEK_MAX_PLAYERS = 20;

export interface PeekTarget { map: string; x: number; y: number; nodeId: string | null | undefined }

export interface PeekDeps {
    copies(dungeonId: number): Promise<CopyRecord[]>;
    partyOf(username: string): Promise<string[]>;
    entrance(copy: CopyRecord): Promise<{ x: number; y: number }>;
    savedSpot(username: string): Promise<PortalSpot | null>;
    defaultSpawn(): PortalSpot;
}

const newest = (list: CopyRecord[]): CopyRecord | null => list.reduce<CopyRecord | null>((a, c) => (!a || c.openedAt > a.openedAt ? c : a), null);

/** The copy a viewer would see: the party's newest copy, else their own newest. Never a stranger's. */
export function viewerCopy(copies: CopyRecord[], username: string, party: string[]): CopyRecord | null {
    const me = username.toLowerCase();
    const others = new Set(party.map((n) => n.toLowerCase()).filter((n) => n !== me));
    const partyCopy = others.size ? newest(copies.filter((c) => c.entered.some((n) => others.has(n.toLowerCase())))) : null;
    return partyCopy ?? newest(copies.filter((c) => c.entered.some((n) => n.toLowerCase() === me)));
}

/** Where a teleport leads from a map: into the same copy when it names the copy's own template, else the live map. */
export function teleportDestination(map: string, target: PortalSpot): PortalSpot {
    const to = bareName(target.map);
    if (isCopyKey(map) && to === templateOf(map)) return { map: bareName(map), x: target.x, y: target.y };
    return { map: to, x: target.x, y: target.y };
}

/** The place a portal's far side shows this viewer, or null when there is none to stream (mirror off, nothing linked, no copy of theirs open). */
export async function peekTarget(deps: PeekDeps, viewer: { username: string; map: string }, portal: DungeonPortalObject): Promise<PeekTarget | null> {
    if (!portal.mirror) return null;
    if (portal.kind === "teleport") {
        if (!portal.target) return null;
        return { ...teleportDestination(viewer.map, portal.target), nodeId: undefined };
    }
    if (isCopyKey(viewer.map)) {
        const spot = (await deps.savedSpot(viewer.username)) ?? deps.defaultSpawn();
        return { map: bareName(spot.map), x: spot.x, y: spot.y, nodeId: undefined };
    }
    if (portal.dungeonId === null) return null;
    const copy = viewerCopy(await deps.copies(portal.dungeonId), viewer.username, await deps.partyOf(viewer.username));
    if (!copy) return null;
    const at = await deps.entrance(copy);
    return { map: copy.key, x: at.x, y: at.y, nodeId: copy.nodeId };
}

/**
 * The line a portal's far side is mirrored about: the far portal's foot, where it meets the ground. Players come out of
 * a portal just in front of it (portalpairs arrivalSpot) and a dungeon's saved spot is its portal's centre, so either
 * gives that portal's foot; any other spot is the line itself.
 */
export function mirrorLine(spot: { x: number; y: number }, portals: DungeonPortalObject[] | null | undefined): { x: number; y: number } {
    const far = portals?.find((o) => {
        const a = arrivalSpot("", o);
        if (a.x === spot.x && a.y === spot.y) return true;
        return Math.round(o.position.x + o.size.width / 2) === spot.x && Math.round(o.position.y + o.size.height / 2) === spot.y;
    });
    return far ? { x: far.position.x + Math.floor(far.size.width / 2), y: far.position.y + far.size.height } : { x: spot.x, y: spot.y };
}

export interface PeekPlayer { id: string; x: number; y: number; direction: string; moving: boolean }
export interface PeekRow { i: string; x: number; y: number; d: string; m: 0 | 1 }

/** The players the opening shows, relative to the far place, in id order, at most PEEK_MAX_PLAYERS. */
export function peekFrame(players: PeekPlayer[], at: { x: number; y: number }): PeekRow[] {
    return players
        .filter((p) => Math.abs(p.x - at.x) <= PEEK_HALF_W && Math.abs(p.y - at.y) <= PEEK_HALF_H)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, PEEK_MAX_PLAYERS)
        .map((p) => ({ i: p.id, x: Math.round(p.x - at.x), y: Math.round(p.y - at.y), d: p.direction, m: p.moving ? 1 : 0 }));
}

/**
 * The players in a frame whose look is to be sent: new ones and those whose look changed. The client drops a player
 * who leaves the frame, so the held looks keep only this frame's players: one who comes back gets their look again.
 */
export function peekLooksDue(held: Map<string, string>, rows: Array<{ i: string; look: string }>): string[] {
    const inFrame = new Set(rows.map((r) => r.i));
    for (const id of [...held.keys()]) if (!inFrame.has(id)) held.delete(id);
    const due: string[] = [];
    for (const r of rows) {
        if (held.get(r.i) === r.look) continue;
        held.set(r.i, r.look);
        due.push(r.i);
    }
    return due;
}

/** A viewer's streamed portals after a subscribe (on) or an unsubscribe (off), at most PEEK_CAP. */
export function peekSubscribe(subs: string[], portal: string, on: boolean): string[] {
    if (!on) return subs.filter((s) => s !== portal);
    if (subs.includes(portal) || subs.length >= PEEK_CAP) return subs;
    return [...subs, portal];
}
