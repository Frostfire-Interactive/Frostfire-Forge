export type DungeonType = "dungeon" | "raid";
export type DungeonSize = 5 | 10 | 20;
export interface ModeMultiplier { health: number; damage: number }
export interface DungeonDef {
    id: number; name: string; map: string; type: DungeonType; sizes: DungeonSize[];
    multipliers: Record<"5" | "10" | "20", ModeMultiplier>; entranceX: number; entranceY: number; enabled: boolean;
    /** The portal's colour, "#rrggbb" in lower case; null draws it in the type's default colour. */
    portalColor: string | null;
}
export interface CopyRecord {
    key: string; dungeonId: number; size: DungeonSize; entered: string[]; nodeId: string | null;
    openedAt: number; bossTotal: number; cleared: boolean; emptySince: number | null;
}
export type RefusalReason = "disabled" | "copy_full" | "party_too_big" | "no_entries" | "leader_must_open";
export type EntryDecision =
    | { kind: "rejoin"; copy: CopyRecord }
    | { kind: "join"; copy: CopyRecord }
    | { kind: "open"; size: DungeonSize }
    | { kind: "choose_size"; sizes: DungeonSize[] }
    | { kind: "refuse"; reason: RefusalReason; limit?: number; waitMs?: number };
export interface PortalSpot { map: string; x: number; y: number }
/** dungeon: leads into a dungeon copy (or out of one, on a copy's map). teleport: leads one way to a live place. */
export type PortalKind = "dungeon" | "teleport";
export const PORTAL_KINDS: readonly PortalKind[] = ["dungeon", "teleport"];
export interface DungeonPortalObject {
    name: string; kind: PortalKind;
    /** The dungeon a dungeon portal is linked to (from the dungeon editor); null when it is linked to none. */
    dungeonId: number | null;
    /** Mirror other side: draw the far side in the opening. Off draws the arch and swirl only. */
    mirror: boolean;
    /** Where a teleport portal leads; null for a dungeon portal. */
    target: PortalSpot | null;
    position: { x: number; y: number }; size: { width: number; height: number }; layer: string | null;
    /** Set only on a return portal: a teleport's way back, or a dungeon's exit on its map; names the portal it follows (not edited on its own). */
    returnOf?: PortalLink;
}
/** A portal named by its map (bare name) and its name. */
export interface PortalLink { map: string; name: string }
/** What a portal leads to, for the picture drawn inside it; map null when there is nothing to draw. */
export type PortalPreviewData =
    | { portal?: string; dungeonId?: number; map: string; x: number; y: number; tilewidth: number; tileheight: number; tilesets: any[]; color: string }
    | { portal?: string; dungeonId?: number; map: null; color?: string };
export interface MapChestObject {
    name: string; lootTableId: number; resetMinutes: number; position: { x: number; y: number }; layer: string | null;
}

export const DEFAULT_MULTIPLIERS: DungeonDef["multipliers"] = {
    "5": { health: 1, damage: 1 },
    "10": { health: 2, damage: 1.5 },
    "20": { health: 4, damage: 2 },
};

/** A dungeon's portal is blue and a raid's green, unless the dungeon has a colour of its own. */
export const DEFAULT_PORTAL_COLORS: Record<DungeonType, string> = { dungeon: "#6eaaff", raid: "#6eff8c" };
/** A teleport portal's colour. */
export const TELEPORT_PORTAL_COLOR = "#c08cff";
export const PORTAL_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/** The colour a dungeon's portal is drawn in. */
export function portalColorOf(def: Pick<DungeonDef, "type" | "portalColor">): string {
    return def.portalColor && PORTAL_COLOR_PATTERN.test(def.portalColor) ? def.portalColor.toLowerCase() : DEFAULT_PORTAL_COLORS[def.type];
}
