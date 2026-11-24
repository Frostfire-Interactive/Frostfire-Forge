import * as settings from "../config/settings.json";
import { ARRIVAL_FACING, markPortalArrival } from "../systems/portalpairs";
import { randomUUID } from "node:crypto";
import { clusterBlocks, clusterNodes, clusterPinMap, clusterSelf, clusterUnpinMap } from "../cluster";
import { objectViews } from "../cluster/kinds/objects";
import log from "../modules/logger";
import { getWorldMap } from "../modules/worldmaps";
import assetCache from "../services/assetCache";
import mapIndex from "../services/mapindex";
import playerCache from "../services/playermanager";
import spatialGrid from "../services/spatialgrid";
import creatures from "../systems/creatures";
import { dungeonCharacters } from "../systems/dungeons/characterstate";
import { copyBook } from "../systems/dungeons/copybook";
import { bareName as bare, copyKey, isCopyKey, newCopyId, templateOf } from "../systems/dungeons/copykey";
import { dungeonDefs } from "../systems/dungeons/definitions";
import { enterDungeon, type EntryDeps } from "../systems/dungeons/entry";
import { copyKilled, dungeonTick, leaveCopy, loginSpot, pickSize, portalCrossing, portalStep, type PortalDeps, type TickInside } from "../systems/dungeons/glue";
import { AIState } from "../systems/creatures/types";
import { Events, listener } from "../systems/events";
import parties from "../systems/parties";
import { WARP_COOLDOWN_MS, setWarpReadyIn, warpReadyIn } from "../systems/warpcooldown";
import { addCopyEntries, eachOrReport, removeCopyEntries } from "../systems/dungeons/maplists";
import { cloneMapEntries } from "../systems/dungeons/mapclone";
import { closeCopy, type TeardownSteps } from "../systems/dungeons/teardown";
import { DEFAULT_PORTAL_COLORS, TELEPORT_PORTAL_COLOR, portalColorOf, type CopyRecord, type DungeonDef, type DungeonPortalObject, type DungeonSize, type PortalPreviewData, type PortalSpot } from "../systems/dungeons/types";
import { PEEK_RATE_MS, mirrorLine, peekFrame, peekLooksDue, peekSubscribe, peekTarget, teleportDestination, type PeekDeps, type PeekTarget } from "../systems/dungeons/peek";
import { portalsFrom, stonesFrom, type SummoningStoneObject } from "../systems/mapobjects";
import { getMountSpriteUrl, getPlayerSpriteSheetData } from "../modules/spriteSheetManager";
import { broadcastToAOI, handleMapChangeAOI } from "./aoi";
import fishing from "../systems/fishing";
import { clearZonesForMap } from "../systems/groundaoe";
import loot from "../systems/loot";
import { forgetMapGeometry } from "../systems/npcStreaming";
import { despawnPlacedChests, spawnPlacedChests } from "../systems/placedchests";
import lootChest from "../systems/lootChest";
import player, { clearMapCache } from "../systems/player";
import skeletons from "../systems/skeletons";
import { nextEntityId } from "../cluster/entityids";
import { packetManager } from "./packet_manager";
import { bumpStateRevision, defaultMap, despawnBatchQueue, editorEditHistory, forceStopPlayerMovement, mapPropertiesCache, maps, placePlayer, ownedByAnotherNode, resyncNpcChunks, sendPacket, spawnBatchQueue, stateRevision, transitionPlayerToMap } from "./receiver";

const NESTED = ["collision", "nopvp"] as const;

const held = () => ({ maps: maps as MapData[], props: mapPropertiesCache as MapProperties[] });

async function freshKey(template: string): Promise<string> {
    const book = copyBook();
    for (;;) {
        const key = copyKey(template, newCopyId(nextEntityId()));
        if (!(await book.get(key)) && !(maps as MapData[]).some((m) => bare(m.name) === key)) return key;
    }
}

/** Opens a copy of the dungeon's map on this node: clones the map, spawns its creatures, pins it and records it. Its chests drop when its last boss dies; a copy without bosses has them from the start. */
export async function openCopyHere(def: DungeonDef, size: DungeonSize): Promise<CopyRecord> {
    const template = templateOf(def.map);
    const key = await freshKey(template);
    const mult = def.multipliers[String(size) as "5" | "10" | "20"];

    const { map, props } = cloneMapEntries(template, key, (await assetCache.get("maps")) as MapData[], (await assetCache.get("mapProperties")) as MapProperties[]);

    try {
        await addCopyEntries(assetCache, held(), map, props);
        for (const nested of NESTED) {
            const value = await assetCache.getNested(template, nested);
            if (value !== undefined) await assetCache.addNested(key, nested, value);
        }
        clearMapCache(key);
        // A copy of a world has the world's collision bitset (modules/worldmaps.ts), not run lengths.
        const world = getWorldMap(key);
        if (world) {
            creatures.navGrids.useBits(key, world.collision, world.width, world.height, world.tileWidth, world.tileHeight);
        } else {
            const rle = await assetCache.getNested(key, "collision");
            creatures.navGrids.update(key, Array.isArray(rle) ? rle : null, Number(props.tileWidth) || 32, Number(props.tileHeight) || 32);
        }

        await clusterPinMap(key, props.width * props.tileWidth, props.height * props.tileHeight);

        const { instances, bosses } = await creatures.copyCreatures(template, key, mult);
        creatures.spawnCopyCreatures(key, instances);
        if (bosses <= 0) spawnPlacedChests(key, props.chests ?? [], { resets: false });

        const now = Date.now();
        const record: CopyRecord = { key, dungeonId: def.id, size, entered: [], nodeId: clusterSelf(), openedAt: now, bossTotal: bosses, cleared: false, emptySince: now };
        await copyBook().put(record);
        return record;
    } catch (error) {
        await closeCopyHere(key).catch(() => []);
        throw error;
    }
}

function defaultSpawn(): { map: string; x: number; y: number } {
    const props = (mapPropertiesCache as MapProperties[]).find((m) => m.name === `${defaultMap}.json`);
    const s = settings as any;
    return {
        map: defaultMap,
        x: s.spawn_x ?? props?.spawn?.x ?? (props ? (props.width * props.tileWidth) / 2 : 0),
        y: s.spawn_y ?? props?.spawn?.y ?? (props ? (props.height * props.tileHeight) / 2 : 0),
    };
}

/** Moves a player to the spot they entered from, else the default map's spawn, with that spot saved as their location. */
export async function sendToPortal(target: any): Promise<void> {
    await leaveCopy({
        portal: (username) => dungeonCharacters.portal(username),
        defaultSpawn,
        arriveAt: (p, map, at) => player.arriveAt(p.id, map, at),
        place: (p, map, x, y) => {
            markPortalArrival(p, Date.now());
            return placePlayer(p, map, x, y);
        },
        warn: (message) => log.warn(message),
    }, target);
}

export function copyTeardownSteps(key: string): TeardownSteps {
    return {
        movePlayersOut: async () => {
            const players = [...(mapIndex.getPlayersOnMap(key) ?? [])].map((id) => playerCache.get(id)).filter(Boolean);
            await eachOrReport(players, sendToPortal, (p, error) => log.error(`Copy ${key}: ${p.username} could not be sent out: ${error}`));
        },
        despawnCreatures: () => { creatures.despawnCopyCreatures(key); },
        despawnChests: () => {
            for (const id of despawnPlacedChests(key)) objectViews.hideChest({ id, map: key });
        },
        despawnGroundLoot: () => { for (const item of [...loot.getOnMap(key)]) loot.despawn(item.id); },
        despawnSkeletons: () => { for (const s of [...skeletons.all()]) if (s.map === key) skeletons.despawn(s.id); },
        clearGroundAoe: () => clearZonesForMap(key),
        clearSpatialGrid: () => spatialGrid.clearMap(key),
        forgetCaches: async () => {
            clearMapCache(key);
            creatures.navGrids.delete(key);
            forgetMapGeometry(key);
            fishing.forgetMap(key);
            for (const nested of NESTED) await assetCache.removeNested(key, nested);
            editorEditHistory.delete(key);
        },
        unregisterMap: async () => {
            await removeCopyEntries(assetCache, held(), key);
        },
        unpinCluster: () => clusterUnpinMap(key),
        removeBookRecord: () => copyBook().remove(key),
    };
}

/** Closes a copy: players out, then everything of it removed, in the teardown order. */
export async function closeCopyHere(key: string): Promise<string[]> {
    const failed = await closeCopy(key, copyTeardownSteps(key));
    if (failed.length) log.warn(`Copy ${key} closed with failed steps: ${failed.join(", ")}`);
    return failed;
}

const sendIfOpen = (p: any, packets: any[]) => { if (p?.wt) sendPacket(p.wt, packets); };

const hereKnown = (key: string): boolean => (maps as MapData[]).some((m) => bare(m.name) === key);

function mapCentre(key: string): { x: number; y: number } {
    // A copy on another node is not in this node's lists: its template's size is the copy's.
    const list = mapPropertiesCache as MapProperties[];
    const props = list.find((m) => bare(m.name) === key) ?? list.find((m) => bare(m.name) === templateOf(key));
    return props ? { x: Math.round((props.width * props.tileWidth) / 2), y: Math.round((props.height * props.tileHeight) / 2) } : { x: 0, y: 0 };
}

/** Where players appear inside a copy: the dungeon's entrance, or null when its definition is gone. */
export async function copyEntrance(key: string): Promise<{ x: number; y: number } | null> {
    const copy = await copyBook().get(bare(key));
    const def = copy ? await dungeonDefs.get(copy.dungeonId) : null;
    return def ? { x: def.entranceX, y: def.entranceY } : null;
}

const entryDeps = (): EntryDeps => ({ book: copyBook(), def: (id) => dungeonDefs.get(id), lockouts: dungeonCharacters, openCopy: openCopyHere, now: Date.now });

function portalDeps(): PortalDeps {
    const deps = entryDeps();
    return {
        enter: (req) => enterDungeon(deps, req),
        partyOf: async (p: any) => {
            const id = p.party_id ?? await parties.getPartyId(p.username);
            if (!id) return { party: [], leader: null };
            return { party: (await parties.getPartyMembers(id)) ?? [], leader: await parties.getPartyLeader(id) };
        },
        setPortal: (username, spot) => dungeonCharacters.setPortal(username, spot),
        entrance: async (copy) => (await copyEntrance(copy.key)) ?? mapCentre(copy.key),
        moveInto: async (p: any, key, at) => {
            const direction = ARRIVAL_FACING;
            if (!(await player.arriveAt(p.id, key, { x: at.x, y: at.y, direction } as any))) return false;
            markPortalArrival(p, Date.now());
            await transitionPlayerToMap(p, key, { x: at.x, y: at.y, direction }, p.wt, spawnBatchQueue, despawnBatchQueue);
            return true;
        },
        teleport: (p: any, spot) => teleportPlayer(p, spot),
        sendOut: (p) => sendToPortal(p),
        stop: (p) => forceStopPlayerMovement(p),
        offerSizes: (p, offer) => sendIfOpen(p, packetManager.dungeonSizeChoice(offer)),
        dungeonName: async (id) => (await dungeonDefs.get(id))?.name ?? "Dungeon",
        notify: (p, message) => sendIfOpen(p, packetManager.notify({ message })),
        authorization: () => randomUUID(),
        now: Date.now,
        warpCooldownLeft: (username) => warpReadyIn(username),
        startWarpCooldown: (username) => setWarpReadyIn(username, WARP_COOLDOWN_MS),
        endWarpCooldown: (username) => setWarpReadyIn(username, 0),
        warn: (message) => log.warn(message),
    };
}

/** A move through a teleport portal, as a warp moves a player: saved first, then to the other map (or node), or to the place on this map. */
async function teleportPlayer(p: any, spot: PortalSpot): Promise<boolean> {
    const direction = ARRIVAL_FACING;
    if (!(await player.arriveAt(p.id, spot.map, { x: spot.x, y: spot.y, direction } as any))) return false;
    const at = { x: spot.x, y: spot.y, direction };
    markPortalArrival(p, Date.now());
    if (bare(String(p.location?.map ?? "")) !== bare(spot.map) || ownedByAnotherNode(spot.map, spot.x, spot.y)) {
        await transitionPlayerToMap(p, spot.map, at, p.wt, spawnBatchQueue, despawnBatchQueue);
        return true;
    }
    await handleMapChangeAOI(p, spot.map, at, spawnBatchQueue, despawnBatchQueue);
    p.location.position.direction = direction;
    bumpStateRevision();
    broadcastToAOI(p, packetManager.moveXY({
        i: p.id, d: { x: Number(p.location.position.x), y: Number(p.location.position.y), dr: direction }, r: stateRevision(), s: p.isStealth ? 1 : 0,
    }), true);
    // the NPCs round the place on this map it put them (as placePlayer does): not only after their next step
    await resyncNpcChunks(p, p.wt);
    return true;
}

const PORTAL_PROPS_MS = 1000;
const portalProps = new Map<string, { at: number; portals: DungeonPortalObject[] | null }>();

/** The map's portals as kept (old ones without kind or mirror are dungeon portals that mirror), cached for a second. */
export function portalsOn(map: string): DungeonPortalObject[] | null {
    const key = bare(map);
    const now = Date.now();
    const cached = portalProps.get(key);
    if (cached && now - cached.at < PORTAL_PROPS_MS) return cached.portals;
    const props = (mapPropertiesCache as any[]).find((m) => bare(String(m.name)) === key);
    const list = portalsFrom(props?.dungeonPortals);
    const portals = list.length ? list : null;
    portalProps.set(key, { at: now, portals });
    return portals;
}

/** Forgets the cached portal lists, after a portal save. */
export function forgetPortalsOn(): void {
    portalProps.clear();
}

const stoneProps = new Map<string, { at: number; stones: SummoningStoneObject[] | null }>();

/** The map's summoning stones as kept, cached for a second as portalsOn is. */
export function stonesOn(map: string): SummoningStoneObject[] | null {
    const key = bare(map);
    const now = Date.now();
    const cached = stoneProps.get(key);
    if (cached && now - cached.at < PORTAL_PROPS_MS) return cached.stones;
    const props = (mapPropertiesCache as any[]).find((m) => bare(String(m.name)) === key);
    const list = stonesFrom(props?.summoningStones);
    const stones = list.length ? list : null;
    stoneProps.set(key, { at: now, stones });
    return stones;
}

/** Forgets the cached stone lists, after a stone save. */
export function forgetStonesOn(): void {
    stoneProps.clear();
}

/** A player's accepted step: true when a dungeon portal moved them off the map. */
export async function dungeonPortalStep(p: any, before: { x: number; y: number }, after: { x: number; y: number }, _wt?: any): Promise<boolean> {
    const map = String(p?.location?.map ?? "");
    const portals = portalsOn(map);
    if (!portals) return false;
    return portalStep(portalDeps(), p, bare(map), portals, before, { x: Number(after.x), y: Number(after.y) });
}

/** Steps replayed in one go (a catch-up or a handoff's gap), checked as the walk: the first step into a portal from its front fires. True when a portal moved the player off the map. */
export async function dungeonPortalWalk(p: any, path: Array<{ x: number; y: number }>): Promise<boolean> {
    const crossing = portalCrossing(portalsOn(String(p?.location?.map ?? "")), path);
    if (!crossing) return false;
    return dungeonPortalStep(p, crossing.before, crossing.after);
}

/** The tiles a picture of a place needs: a copy is drawn from its template's tiles. */
/** The portals on a far map; a copy has its template's. */
const farPortals = (map: string) => portalsOn(map) ?? (isCopyKey(map) ? portalsOn(templateOf(map)) : null);

function pictureOf(map: string, x: number, y: number, color: string, portal?: string, dungeonId?: number): PortalPreviewData {
    const name = templateOf(map);
    const held = (maps as any[]).find((m) => m.name === `${name}.json` || m.name === name);
    if (!held?.data) return { portal, dungeonId, map: null, color };
    const at = mirrorLine({ x, y }, farPortals(map));
    return {
        portal, dungeonId, map: name, x: at.x, y: at.y, color,
        tilewidth: held.data.tilewidth || 32, tileheight: held.data.tileheight || 32, tilesets: held.data.tilesets || [],
    };
}

/** The dungeon's map, entrance and tilesets: the client draws the entrance inside the portal, in the portal's colour. */
export async function portalPreview(dungeonId: number): Promise<PortalPreviewData | null> {
    const def = await dungeonDefs.get(dungeonId);
    if (!def) return null;
    return pictureOf(def.map, def.entranceX, def.entranceY, portalColorOf(def), undefined, def.id);
}

async function portalColour(map: string, portal: DungeonPortalObject): Promise<string> {
    if (portal.kind === "teleport") return TELEPORT_PORTAL_COLOR;
    const id = portal.dungeonId ?? (isCopyKey(map) ? (await copyBook().get(bare(map)))?.dungeonId : undefined);
    const def = id ? await dungeonDefs.get(id) : null;
    return def ? portalColorOf(def) : DEFAULT_PORTAL_COLORS.dungeon;
}

/**
 * The still picture a portal on the viewer's map shows them: a teleport's place, an exit portal's saved spot outside
 * (else the default spawn), or the dungeon's entrance. Mirror off, or nothing linked: no picture, only the colour.
 */
export async function portalPreviewFor(p: any, name: string): Promise<PortalPreviewData> {
    const map = bare(String(p?.location?.map ?? ""));
    const portal = portalsOn(map)?.find((o) => o.name === name);
    if (!portal) return { portal: name, map: null };
    const color = await portalColour(map, portal);
    if (!portal.mirror) return { portal: name, map: null, color };
    if (portal.kind === "teleport") {
        if (!portal.target) return { portal: name, map: null, color };
        const spot = teleportDestination(map, portal.target);
        return pictureOf(spot.map, spot.x, spot.y, color, name);
    }
    if (isCopyKey(map)) {
        const spot = (await dungeonCharacters.portal(String(p.username))) ?? defaultSpawn();
        return pictureOf(bare(spot.map), spot.x, spot.y, color, name);
    }
    const def = portal.dungeonId ? await dungeonDefs.get(portal.dungeonId) : null;
    if (!def) return { portal: name, map: null, color };
    return pictureOf(def.map, def.entranceX, def.entranceY, color, name, def.id);
}

/* Portal peek feed: while a portal near a viewer is awake, the players on its far side, 30 times a second. */

const PEEK_RESOLVE_MS = 2000;
interface PeekSub { map: string; target: PeekTarget | null; resolvedAt: number; last: string; looks: Map<string, string> }
const peeks = new Map<string, Map<string, PeekSub>>();

const peekDeps = (): PeekDeps => ({
    copies: (id) => copyBook().list(id),
    partyOf: async (username) => {
        const id = await parties.getPartyId(username);
        return id ? (await parties.getPartyMembers(id)) ?? [] : [];
    },
    entrance: async (copy) => (await copyEntrance(copy.key)) ?? mapCentre(copy.key),
    savedSpot: (username) => dungeonCharacters.portal(username),
    defaultSpawn,
});

/** Whether the far place is on this node: a copy opened here, or a live map whose block this node holds. */
function peekHere(t: PeekTarget): boolean {
    if (isCopyKey(t.map)) return hereKnown(t.map) && (!t.nodeId || t.nodeId === clusterSelf());
    const owner = clusterBlocks()?.ownerOf(t.map, t.x, t.y);
    return !owner || owner.nodeId === clusterSelf();
}

/** A DUNGEON_PORTAL_PEEK: starts (on) or stops the feed of one portal on the viewer's map. */
export function portalPeek(p: any, data: any): void {
    const name = typeof data?.portal === "string" ? data.portal : "";
    if (!p?.id || !name) return;
    const map = bare(String(p.location?.map ?? ""));
    const subs = peeks.get(p.id) ?? new Map<string, PeekSub>();
    for (const [n, sub] of subs) if (sub.map !== map) subs.delete(n);
    const on = data?.on !== false && !!portalsOn(map)?.some((o) => o.name === name && o.mirror);
    const kept = peekSubscribe([...subs.keys()], name, on);
    for (const n of [...subs.keys()]) if (!kept.includes(n)) subs.delete(n);
    for (const n of kept) if (!subs.has(n)) subs.set(n, { map, target: null, resolvedAt: 0, last: "", looks: new Map() });
    if (subs.size) peeks.set(p.id, subs);
    else peeks.delete(p.id);
}

/** What a peeked player looks like, as SPAWN_PLAYER carries it; sent once per player and look. */
async function peekLook(o: any): Promise<any> {
    const sheet: any = await getPlayerSpriteSheetData("idle_down", o.equipment || null);
    const mountSprite = o.mount_type ? getMountSpriteUrl(o.mount_type) : null;
    if (!sheet?.bodySprite && !sheet?.headSprite && !mountSprite) return null;
    return {
        mountSprite, bodySprite: sheet.bodySprite || null, headSprite: sheet.headSprite || null,
        armorHelmetSprite: sheet.armorHelmetSprite || null, armorShoulderguardsSprite: sheet.armorShoulderguardsSprite || null,
        armorNeckSprite: sheet.armorNeckSprite || null, armorHandsSprite: sheet.armorHandsSprite || null,
        armorChestSprite: sheet.armorChestSprite || null, armorFeetSprite: sheet.armorFeetSprite || null,
        armorLegsSprite: sheet.armorLegsSprite || null, armorWeaponSprite: sheet.armorWeaponSprite || null,
        animationState: sheet.animationState,
    };
}

async function peekOnce(viewer: any, name: string, sub: PeekSub): Promise<void> {
    const portal = portalsOn(sub.map)?.find((o) => o.name === name);
    if (!portal?.mirror) {
        peeks.get(viewer.id)?.delete(name);
        return;
    }
    const now = Date.now();
    if (now - sub.resolvedAt >= PEEK_RESOLVE_MS) {
        sub.resolvedAt = now;
        sub.target = await peekTarget(peekDeps(), { username: String(viewer.username), map: sub.map }, portal);
    }
    const t = sub.target && peekHere(sub.target) ? sub.target : null;
    const near = t ? [...(mapIndex.getPlayersOnMap(bare(t.map)) ?? [])]
        .map((id) => playerCache.get(id) as any)
        .filter((o) => o?.location?.position && !o.isStealth && !o.isVanished)
        .map((o) => ({ id: String(o.id), x: Number(o.location.position.x), y: Number(o.location.position.y), direction: String(o.location.position.direction || "down"), moving: !!o.moving, o })) : [];
    const players = t ? peekFrame(near, mirrorLine(t, farPortals(t.map))) : [];
    const shown = new Map(players.map((row) => [row.i, near.find((n) => n.id === row.i)!.o]));
    const looks: Array<{ i: string; s: any }> = [];
    for (const id of peekLooksDue(sub.looks, [...shown].map(([i, o]) => ({ i, look: `${o.equipmentRevision || 0}:${o.mount_type || ""}` })))) {
        looks.push({ i: id, s: await peekLook(shown.get(id)) });
    }
    const json = JSON.stringify(players);
    if (json === sub.last && looks.length === 0) return;
    sub.last = json;
    sendIfOpen(viewer, packetManager.dungeonPortalPeek({ portal: name, players, looks }));
}

let peekTimer: ReturnType<typeof setInterval> | null = null;

/** The peek feed's timer: each viewer's portals, dropped once the viewer is gone or on another map. */
function startPortalPeekFeed(): void {
    if (peekTimer) return;
    let running = false;
    peekTimer = setInterval(async () => {
        if (running || peeks.size === 0) return;
        running = true;
        try {
            for (const [id, subs] of [...peeks]) {
                const viewer: any = playerCache.get(id);
                if (!viewer?.wt) {
                    peeks.delete(id);
                    continue;
                }
                const map = bare(String(viewer.location?.map ?? ""));
                for (const [name, sub] of [...subs]) {
                    if (sub.map !== map) subs.delete(name);
                    else await peekOnce(viewer, name, sub).catch((error) => log.warn(`Portal peek of ${viewer.username} failed: ${error}`));
                }
                if (subs.size === 0) peeks.delete(id);
            }
        } finally {
            running = false;
        }
    }, PEEK_RATE_MS);
}

export function pickDungeonSize(p: any, data: any): Promise<boolean> {
    return pickSize(portalDeps(), p, data);
}

export function dungeonLoginSpot(username: string, savedMap: string) {
    return loginSpot({
        book: copyBook(),
        portal: (name) => dungeonCharacters.portal(name),
        here: hereKnown,
        liveElsewhere: async (nodeId) => {
            if (!nodeId || nodeId === clusterSelf()) return false;
            const live = await clusterNodes()?.live().catch(() => null);
            return !!live?.some((n) => n.nodeId === nodeId);
        },
    }, username, savedMap);
}

function insideCopy(key: string): TickInside[] {
    return [...(mapIndex.getPlayersOnMap(key) ?? [])]
        .map((id) => playerCache.get(id))
        .filter(Boolean)
        .map((p: any) => ({ player: p, username: String(p.username), partyId: p.party_id ?? null, down: !!(p.isDead || p.isGhost) }));
}

function livingBosses(key: string): number {
    let count = 0;
    for (const c of creatures.registry.onMap(key)) {
        if (c.state !== AIState.DEAD && creatures.getTemplate(c.templateId)?.rank === "boss") count++;
    }
    return count;
}

/** Spawns a cleared copy's placed chests and shows them to everyone inside. */
function dropCopyChests(key: string): void {
    const props = (mapPropertiesCache as MapProperties[]).find((m) => bare(m.name) === key);
    for (const id of spawnPlacedChests(key, props?.chests ?? [], { resets: false })) {
        const chest = lootChest.getChest(id);
        if (chest) objectViews.showChest(chest);
    }
}

const DUNGEON_TICK_MS = 5000;
let tickTimer: ReturnType<typeof setInterval> | null = null;

/** Every 5 s: empty and cleared copies of this node close and stranded players are put out. Also listens for the last boss kill. */
export function startDungeonTick(): void {
    if (tickTimer) return;
    startPortalPeekFeed();
    let since = new Map<string, number>();
    let running = false;
    tickTimer = setInterval(async () => {
        if (running) return;
        running = true;
        try {
            since = await dungeonTick({
                book: copyBook(),
                self: clusterSelf(),
                liveNodes: async () => {
                    const registry = clusterNodes();
                    return registry ? (await registry.live()).map((n) => n.nodeId) : null;
                },
                known: hereKnown,
                inside: insideCopy,
                close: closeCopyHere,
                sendOut: (p) => sendToPortal(p),
                now: Date.now,
            }, since);
        } catch (error) {
            log.error(`Dungeon tick failed: ${error}`);
        } finally {
            running = false;
        }
    }, DUNGEON_TICK_MS);
    listener.on(Events.CREATURE_KILLED, (event: { creature?: any; template?: any }) => {
        const map = String(event?.creature?.map ?? "");
        if (!isCopyKey(map)) return;
        copyKilled({
            book: copyBook(),
            livingBosses,
            dropChests: dropCopyChests,
        }, map, event.template?.rank).catch((error) => log.error(`Dungeon clear check failed: ${error}`));
    });
}
