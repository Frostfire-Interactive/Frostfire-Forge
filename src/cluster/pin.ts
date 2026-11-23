import type { ClusterBus } from "./bus";
import { blockEpochKey, blockKey, blockTableKey, type BlockOwner, type BlockTable } from "./blocks";
import { MapCatalogue, takeInMap, type MapExtent } from "./maps";
import type { ClusterStore } from "./store";

export interface PinContext {
  store: ClusterStore;
  blocks: BlockTable;
  nodeId: string;
  maps: string[];
  bus?: Pick<ClusterBus, "toWorld">;
}

/** Takes the map off the catalogue first, so nothing assigns it again, then drops its keys. */
export async function dropMapKeys(store: ClusterStore, name: string): Promise<void> {
  await new MapCatalogue(store).remove(name);
  await store.del(blockTableKey(name));
  await store.del(blockEpochKey(name));
  await store.del(`cells:layerseq:${name}`);
}

/** Writes a table with every block on this node before the map is published: the coordinator then has nothing to give. */
export async function pinMapHere(ctx: PinContext, extent: MapExtent): Promise<void> {
  const name = extent.name.replace(/\.json$/, "");
  const epoch = await ctx.blocks.nextEpoch(name, 0);
  const since = Date.now();
  const owners: Record<string, BlockOwner> = {};
  for (let bx = 0; bx < extent.blocksX; bx++) {
    for (let by = 0; by < extent.blocksY; by++) owners[blockKey(bx, by)] = { nodeId: ctx.nodeId, epoch, since };
  }
  if (!(await ctx.blocks.writeIfEpoch(name, 0, { epoch, owners }))) throw new Error(`The block table of map ${name} already exists`);
  await takeInMap(ctx, { ...extent, name });
}

/** Snapshots may be placed on the map once it is pinned; a pin that throws takes that back. */
export async function pinMapWithSnapshots(ctx: PinContext, extent: MapExtent, snapshots: { add(map: MapExtent): void; remove(name: string): void }): Promise<void> {
  snapshots.add(extent);
  try {
    await pinMapHere(ctx, extent);
  } catch (error) {
    snapshots.remove(extent.name);
    throw error;
  }
}

export async function unpinMap(ctx: PinContext, name: string): Promise<void> {
  await dropMapKeys(ctx.store, name);
  await ctx.bus?.toWorld("map-closed", { map: name });
  ctx.blocks.forget(name);
  const at = ctx.maps.indexOf(name);
  if (at !== -1) ctx.maps.splice(at, 1);
}
