import type { CopyBook } from "./copybook";
import { bareName as bare, isCopyKey } from "./copykey";
import type { EntryRequest, EntryResult } from "./entry";
import { closeDue, dueStranded, loginPlacement, portalEntered, strandedPlayers, strandedSince } from "./rules";
import type { CopyRecord, DungeonPortalObject, DungeonSize, PortalSpot } from "./types";
import { warpCooldownNotice } from "../warpcooldown";
import { teleportDestination } from "./peek";
import { ARRIVAL_FACING, arrivalSpot } from "../portalpairs";

export const SIZE_CHOICE_MS = 60_000;
export const SIZE_CHOICE_REACH = 64;

export interface PortalArea { position: { x: number; y: number }; size: { width: number; height: number } }

export interface PendingChoice { dungeonId: number; sizes: DungeonSize[]; authorization: string; portal: PortalSpot; area: PortalArea; until: number }

export interface PortalPlayer {
    username: string; isDead?: boolean; isGhost?: boolean; pvp?: boolean;
    _portalBusy?: boolean; _dungeonChoice?: PendingChoice;
    location?: { map?: string; position?: { x: number; y: number } };
}

export interface PortalDeps {
    enter(req: EntryRequest): Promise<EntryResult>;
    partyOf(player: PortalPlayer): Promise<{ party: string[]; leader: string | null }>;
    setPortal(username: string, spot: PortalSpot): Promise<void>;
    entrance(copy: CopyRecord): Promise<{ x: number; y: number }>;
    moveInto(player: PortalPlayer, key: string, at: { x: number; y: number }): Promise<boolean>;
    /** Moves a player through a teleport portal, as a warp does (same map, another map, or another node). False when it failed. */
    teleport(player: PortalPlayer, spot: PortalSpot): Promise<boolean>;
    sendOut(player: PortalPlayer): Promise<void>;
    stop(player: PortalPlayer): Promise<void>;
    offerSizes(player: PortalPlayer, offer: { dungeonId: number; name: string; sizes: DungeonSize[]; authorization: string; expiresInMs: number }): void;
    dungeonName(id: number): Promise<string>;
    notify(player: PortalPlayer, message: string): void;
    authorization(): string;
    now(): number;
    /** The warp cooldown left (ms), and its start and end (systems/warpcooldown.ts). */
    warpCooldownLeft(username: string): number;
    startWarpCooldown(username: string): void;
    endWarpCooldown(username: string): void;
    warn(message: string): void;
}

export const PORTAL_COMBAT_NOTICE = "You can't use a portal while in combat.";
export const PORTAL_FAILED_NOTICE = "The dungeon portal failed. Try again.";

/** The refusals warps have: corpses, ghosts and players in combat. */
export const mayUsePortal = (p: PortalPlayer): boolean => !p.isDead && !p.isGhost && !p.pvp;

export const portalCentre = (map: string, portal: DungeonPortalObject): PortalSpot => ({
    map: bare(map),
    x: Math.round(portal.position.x + portal.size.width / 2),
    y: Math.round(portal.position.y + portal.size.height / 2),
});

/** A refused portal: a player in combat is told why; corpses and ghosts are not. */
function refusePortal(deps: PortalDeps, p: PortalPlayer): false {
    if (p.pvp && !p.isDead && !p.isGhost) deps.notify(p, PORTAL_COMBAT_NOTICE);
    return false;
}

/** A portal move that threw: logged, and the player told, so their walk goes on. */
function portalFailed(deps: PortalDeps, p: PortalPlayer, error: unknown): false {
    deps.warn(`Dungeon portal of ${p.username} failed: ${error}`);
    deps.notify(p, PORTAL_FAILED_NOTICE);
    return false;
}

/** True when the player must wait out the warp cooldown first: they are told how long. */
function waitingToWarp(deps: PortalDeps, p: PortalPlayer): boolean {
    const left = deps.warpCooldownLeft(p.username);
    if (left <= 0) return false;
    deps.notify(p, warpCooldownNotice(left));
    return true;
}

/** A move through a portal, with the warp cooldown started first so a move to a copy on another node takes it along. A move that fails ends it. */
async function warpWithCooldown(deps: PortalDeps, p: PortalPlayer, move: () => Promise<boolean>): Promise<boolean> {
    deps.startWarpCooldown(p.username);
    let moved = false;
    try {
        moved = await move();
        return moved;
    } finally {
        if (!moved) deps.endWarpCooldown(p.username);
    }
}

/** One step of a player on a map. True when the player was moved off it. */
export async function portalStep(deps: PortalDeps, p: PortalPlayer, map: string, portals: DungeonPortalObject[] | null | undefined,
    before: { x: number; y: number }, after: { x: number; y: number }): Promise<boolean> {
    if (!portals?.length || p._portalBusy) return false;
    const portal = portalEntered(portals, before, after);
    if (!portal) return false;
    // A teleport with no place, or a dungeon portal linked to no dungeon outside a copy, leads nowhere.
    if (portal.kind === "teleport" ? !portal.target : portal.dungeonId === null && !isCopyKey(map)) return false;
    if (!mayUsePortal(p)) return refusePortal(deps, p);
    if (waitingToWarp(deps, p)) return false;
    p._portalBusy = true;
    try {
        await deps.stop(p);
        if (portal.kind === "teleport") {
            const spot = teleportDestination(map, portal.target!);
            return await warpWithCooldown(deps, p, () => deps.teleport(p, spot));
        }
        if (isCopyKey(map)) {
            return await warpWithCooldown(deps, p, async () => {
                await deps.sendOut(p);
                return true;
            });
        }
        return await portalEntry(deps, p, portal.dungeonId!, arrivalSpot(map, portal), undefined, portal);
    } catch (error) {
        return portalFailed(deps, p, error);
    } finally {
        p._portalBusy = false;
    }
}

export async function portalEntry(deps: PortalDeps, p: PortalPlayer, dungeonId: number, spot: PortalSpot, size?: DungeonSize, area?: PortalArea): Promise<boolean> {
    const { party, leader } = await deps.partyOf(p);
    const result = await deps.enter({ username: p.username, party, leader, dungeonId, size });
    switch (result.kind) {
        case "enter": {
            await deps.setPortal(p.username, spot);
            return warpWithCooldown(deps, p, async () => deps.moveInto(p, result.copy.key, await deps.entrance(result.copy)));
        }
        case "choose_size": {
            const authorization = deps.authorization();
            const at = area ?? { position: { x: spot.x, y: spot.y }, size: { width: 0, height: 0 } };
            p._dungeonChoice = { dungeonId, sizes: result.sizes, authorization, portal: spot, area: at, until: deps.now() + SIZE_CHOICE_MS };
            deps.offerSizes(p, { dungeonId, name: await deps.dungeonName(dungeonId), sizes: result.sizes, authorization, expiresInMs: SIZE_CHOICE_MS });
            return false;
        }
        case "refuse":
            deps.notify(p, result.message);
            return false;
    }
}

const atPortal = (p: PortalPlayer, choice: PendingChoice): boolean => {
    const pos = p.location?.position;
    if (bare(p.location?.map ?? "") !== choice.portal.map || !pos) return false;
    const { position, size } = choice.area;
    const dx = Math.max(position.x - pos.x, 0, pos.x - (position.x + size.width));
    const dy = Math.max(position.y - pos.y, 0, pos.y - (position.y + size.height));
    return dx <= SIZE_CHOICE_REACH && dy <= SIZE_CHOICE_REACH;
};

/** A DUNGEON_SIZE_PICK: enters with the size when it answers the pending choice and the player is still at its portal. */
export async function pickSize(deps: PortalDeps, p: PortalPlayer, data: { authorization?: unknown; size?: unknown } | null | undefined): Promise<boolean> {
    const choice = p._dungeonChoice;
    if (!choice || deps.now() >= choice.until) {
        p._dungeonChoice = undefined;
        return false;
    }
    const size = Number(data?.size) as DungeonSize;
    if (typeof data?.authorization !== "string" || data.authorization !== choice.authorization || !choice.sizes.includes(size)) return false;
    p._dungeonChoice = undefined;
    if (!mayUsePortal(p)) return refusePortal(deps, p);
    if (p._portalBusy || !atPortal(p, choice) || waitingToWarp(deps, p)) return false;
    p._portalBusy = true;
    try {
        return await portalEntry(deps, p, choice.dungeonId, choice.portal, size);
    } catch (error) {
        return portalFailed(deps, p, error);
    } finally {
        p._portalBusy = false;
    }
}

/** The first step of a walked path that goes into a portal from its front, as portalStep checks one step. */
export function portalCrossing(portals: DungeonPortalObject[] | null | undefined, path: Array<{ x: number; y: number }>): { before: { x: number; y: number }; after: { x: number; y: number } } | null {
    if (!portals?.length) return null;
    for (let i = 1; i < path.length; i++) {
        if (portalEntered(portals, path[i - 1]!, path[i]!)) return { before: path[i - 1]!, after: path[i]! };
    }
    return null;
}

export interface LeavingPlayer { id: string; username: string; location?: { map?: string; position?: { direction?: string } } }

export interface LeaveDeps {
    portal(username: string): Promise<{ map: string; x: number; y: number } | null>;
    defaultSpawn(): { map: string; x: number; y: number };
    /** Saves the player's location; false when the database did not take it. */
    arriveAt(p: LeavingPlayer, map: string, at: { x: number; y: number; direction: string }): Promise<boolean>;
    place(p: LeavingPlayer, map: string, x: number, y: number): Promise<void>;
    warn(message: string): void;
}

/** Moves a player out of a copy to the spot they entered from, else the default spawn. A spot on another map is saved first, so a crash or log out after the move does not put them back inside. */
export async function leaveCopy(deps: LeaveDeps, p: LeavingPlayer): Promise<void> {
    const spot = (await deps.portal(String(p.username))) ?? deps.defaultSpawn();
    if (p.location?.position) p.location.position.direction = ARRIVAL_FACING;
    if (bare(spot.map) !== bare(p.location?.map ?? "")) {
        if (!(await deps.arriveAt(p, spot.map, { x: spot.x, y: spot.y, direction: ARRIVAL_FACING }))) {
            deps.warn(`The spot of ${p.username} outside the dungeon (${spot.map}) was not saved`);
        }
    }
    await deps.place(p, spot.map, spot.x, spot.y);
}

export interface TickInside { player: unknown; username: string; partyId: number | null; down?: boolean }

export interface TickDeps {
    book: CopyBook;
    self: string | null;
    liveNodes(): Promise<string[] | null>;
    known(key: string): boolean;
    inside(key: string): TickInside[];
    close(key: string): Promise<unknown>;
    sendOut(player: unknown): Promise<void>;
    now(): number;
}

async function patch(book: CopyBook, copy: Pick<CopyRecord, "key" | "dungeonId">, fields: Partial<CopyRecord>): Promise<void> {
    await book.locked(copy.dungeonId, async () => {
        const fresh = await book.get(copy.key);
        if (fresh) await book.put({ ...fresh, ...fields });
    });
}

/** One dungeon tick of this node. Returns when each stranded player was first seen stranded, for the next tick. */
export async function dungeonTick(deps: TickDeps, since: Map<string, number>): Promise<Map<string, number>> {
    const now = deps.now();
    const records = await deps.book.all();
    let live: string[] | null | undefined;
    const stranded: string[] = [];
    const players = new Map<string, unknown>();
    for (const copy of records) {
        if (copy.nodeId !== deps.self) {
            live ??= await deps.liveNodes().catch(() => null);
            if (live && copy.nodeId !== null && !live.includes(copy.nodeId)) await deps.book.remove(copy.key);
            continue;
        }
        if (!deps.known(copy.key)) {
            await deps.book.remove(copy.key);
            continue;
        }
        const inside = deps.inside(copy.key);
        if (inside.length > 0 && copy.emptySince !== null) await patch(deps.book, copy, { emptySince: null });
        if (inside.length === 0 && copy.emptySince === null) await patch(deps.book, copy, { emptySince: now });
        if (closeDue(copy, inside.length, now)) {
            await deps.close(copy.key);
            continue;
        }
        for (const name of strandedPlayers(inside)) {
            const one = inside.find((p) => p.username === name)!;
            if (one.down) continue;
            stranded.push(name);
            players.set(name, one.player);
        }
    }
    const next = strandedSince(since, stranded, now);
    for (const name of dueStranded(next, now)) {
        next.delete(name);
        await deps.sendOut(players.get(name)).catch(() => {});
    }
    return next;
}

export interface ClearDeps {
    book: CopyBook;
    livingBosses(key: string): number;
    /** Spawns the copy's placed chests: they appear when the copy is cleared. */
    dropChests(key: string): void;
}

/** Copies whose clear check is running on this node, so two boss deaths at once clear it once. */
const clearing = new Set<string>();

/** A creature died: when it was the last living boss of a copy that has bosses, the copy is cleared. */
export async function copyKilled(deps: ClearDeps, map: string, rank: string | undefined): Promise<boolean> {
    if (!isCopyKey(map) || rank !== "boss") return false;
    const key = bare(map);
    if (clearing.has(key)) return false;
    clearing.add(key);
    try {
        const copy = await deps.book.get(key);
        if (!copy || copy.cleared || copy.bossTotal <= 0 || deps.livingBosses(key) > 0) return false;
        await patch(deps.book, copy, { cleared: true });
        deps.dropChests(key);
        return true;
    } finally {
        clearing.delete(key);
    }
}

export interface LoginDeps {
    book: CopyBook;
    portal(username: string): Promise<PortalSpot | null>;
    here(key: string): boolean;
    liveElsewhere(nodeId: string | null): Promise<boolean>;
}

export async function loginSpot(deps: LoginDeps, username: string, savedMap: string): Promise<ReturnType<typeof loginPlacement>> {
    if (!isCopyKey(savedMap)) return { kind: "as_saved" };
    const key = bare(savedMap);
    const copy = await deps.book.get(key);
    const copyOpen = !!copy && (deps.here(key) || await deps.liveElsewhere(copy.nodeId));
    return loginPlacement({ savedMap: key, copyOpen, onEnteredList: !!copy?.entered.includes(username), portal: await deps.portal(username) });
}
