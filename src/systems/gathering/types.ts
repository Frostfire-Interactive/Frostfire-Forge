import type { NavGrid, Point } from "../creatures/navgrid";

export type { Rng } from "../creatures/constants";
export type { Point };

/** One row of gathering_areas: a circle on a map where nodes of one item spawn. */
export interface GatherArea {
  id: number;
  map: string;
  /** Centre, px. */
  x: number;
  y: number;
  /** px. */
  radius: number;
  /** How big a node is drawn: its picture's longest side, px. */
  size: number;
  /** Item name, as in the items table. */
  item: string;
  quantity_min: number;
  quantity_max: number;
  /** Nodes kept standing on each layer of the map. */
  max_nodes: number;
  respawn_min_s: number;
  respawn_max_s: number;
  enabled: boolean;
}

/** A node standing in the world, on one layer of its area's map. */
export interface GatherNode {
  id: number;
  areaId: number;
  map: string;
  layerId: string;
  x: number;
  y: number;
  item: string;
  /** The tile it stands on, "tx,ty": no two nodes of a layer share one. */
  tile: string;
}

/** What a client is sent of a node. */
export interface GatherNodeSnapshot {
  id: number;
  x: number;
  y: number;
  item: string;
  icon: string | null;
  /** px: the longest side of the drawn picture. */
  size: number;
}

/** What placement needs of a map's nav grid (creatures/navgrid). */
export type GatherGrid = Pick<NavGrid, "isWalkable" | "tileOf" | "anchorOfTile">;
