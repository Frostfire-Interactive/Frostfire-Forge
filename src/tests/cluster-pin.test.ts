import { expect, test } from "bun:test";
import { BlockTable } from "../cluster/blocks";
import { MapCatalogue, extentOf } from "../cluster/maps";
import { MemoryStore } from "../cluster/memorystore";
import { pinMapHere, pinMapWithSnapshots, unpinMap } from "../cluster/pin";

function setup() {
  const store = new MemoryStore();
  const blocks = new BlockTable(store);
  const maps: string[] = [];
  return { store, blocks, maps, ctx: { store, blocks, nodeId: "n1", maps } };
}

test("pinMapHere owns every block and publishes the map", async () => {
  const { store, blocks, maps, ctx } = setup();
  await pinMapHere(ctx, extentOf("vault~a1", 8192, 4096));
  expect((await blocks.load("vault~a1")).owners).toMatchObject({ "0,0": { nodeId: "n1" }, "1,0": { nodeId: "n1" } });
  expect(blocks.ownerOf("vault~a1", 5000, 10)?.nodeId).toBe("n1");
  expect((await new MapCatalogue(store).all()).map((e) => e.name)).toContain("vault~a1");
  expect(maps).toContain("vault~a1");
  expect((await blocks.load("vault~a1")).epoch).toBeGreaterThan(0);
});

test("unpinMap removes the catalogue entry, keys, cache and map list entry", async () => {
  const { store, blocks, maps, ctx } = setup();
  await pinMapHere(ctx, extentOf("vault~a1", 8192, 4096));
  await store.set("cells:layerseq:vault~a1", "3");
  await unpinMap(ctx, "vault~a1");
  expect((await new MapCatalogue(store).all()).map((e) => e.name)).not.toContain("vault~a1");
  expect(await store.get("cells:blocks:vault~a1")).toBeNull();
  expect(await store.get("cells:blocksepoch:vault~a1")).toBeNull();
  expect(await store.get("cells:layerseq:vault~a1")).toBeNull();
  expect(blocks.ownerOf("vault~a1", 10, 10)).toBeNull();
  expect(blocks.maps()).not.toContain("vault~a1");
  expect(maps).not.toContain("vault~a1");
});

test("unpinMap tells the world the map closed", async () => {
  const { blocks, ctx } = setup();
  const heard: unknown[] = [];
  const bus = { toWorld: async (kind: string, data: unknown) => { heard.push([kind, data]); } };
  await pinMapHere({ ...ctx, bus } as any, extentOf("vault~a1", 4096, 4096));
  await unpinMap({ ...ctx, bus } as any, "vault~a1");
  expect(heard).toContainEqual(["map-closed", { map: "vault~a1" }]);
  expect(blocks.ownerOf("vault~a1", 1, 1)).toBeNull();
});

test("a pin that fails takes back the map it let snapshots be placed on", async () => {
  const { ctx } = setup();
  await pinMapHere(ctx, extentOf("vault~a1", 4096, 4096));
  const known = new Set<string>();
  const snapshots = { add: (map: { name: string }) => { known.add(map.name); }, remove: (name: string) => { known.delete(name); } };
  // The table is there already, so the second pin throws.
  await expect(pinMapWithSnapshots(ctx, extentOf("vault~a1", 4096, 4096), snapshots)).rejects.toThrow(/already exists/);
  expect([...known]).toEqual([]);

  await pinMapWithSnapshots(ctx, extentOf("vault~b2", 4096, 4096), snapshots);
  expect([...known]).toEqual(["vault~b2"]);
});
