import { expect, test } from "bun:test";
import { packetTypes } from "../socket/types";
import { packetManager } from "../socket/packet_manager";
import { applyZones, cleanZones, cleanZonesLenient, fillHoles, separateZones, sizeAfterSave, zonesForSave, zonesOfKind, type MapZone } from "../modules/zones";
import { ringRelation } from "../modules/zoneoverlap";

const square = (x: number, y: number, size: number) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size]];
const zone = (over: Record<string, unknown> = {}) => ({ name: "Town", outline: [square(10, 10, 5)], ...over });
const ok = (result: ReturnType<typeof cleanZones>): MapZone[] => {
  if ("error" in result) throw new Error(result.error);
  return result.zones;
};
const refused = (list: unknown) => {
  const result = cleanZones(list, 100, 100);
  return "error" in result ? result.error : null;
};

test("cleanZones keeps a good zone and works out its bounds", () => {
  const [town] = ok(cleanZones([{ name: " Town ", text: "", music: "Town Theme", kind: "snow", outline: [[[10, 10], [20, 10], [20, 30]]], bbox: { x: 0, y: 0, w: 1, h: 1 } }], 100, 100));
  expect(town!.name).toBe("Town");
  expect(town!.bbox).toEqual({ x: 10, y: 10, w: 10, h: 20 });
  expect(town!.music).toBe("town theme");
  expect("text" in town!).toBe(false);
  expect(town!.kind).toBe("snow");
});

test("cleanZones keeps the keys it does not know, such as a generated zone's", () => {
  const [wind] = ok(cleanZones([zone({ id: 7, levels: [1, 10], hub: "Ashfield", start: true })], 100, 100));
  expect(wind).toMatchObject({ id: 7, levels: [1, 10], hub: "Ashfield", start: true });
});

test("cleanZones takes an empty list", () => {
  expect(cleanZones([], 100, 100)).toEqual({ zones: [] });
});

test("cleanZones refuses a bad list and names the zone", () => {
  const many = Array.from({ length: 513 }, (_, i) => [i % 100, Math.floor(i / 100)]);
  expect(refused([zone({ outline: [[[0, 0], [1, 1]]] })])).toContain("Town");
  expect(refused([zone({ outline: [many] })])).toContain("Town");
  expect(refused([zone({ outline: [[[101, 5], [0, 0], [5, 5]]] })])).toContain("Town");
  expect(refused([zone({ outline: [[[1.5, 2], [0, 0], [5, 5]]] })])).toContain("Town");
  expect(refused([zone(), zone({ name: "town" })])).toContain("town");
  expect(refused([zone({ name: "  " })])).not.toBeNull();
  expect(refused([zone({ name: "x".repeat(65) })])).not.toBeNull();
  expect(refused([zone({ text: "x".repeat(81) })])).toContain("Town");
  expect(refused([zone({ kind: "Snow!" })])).toContain("Town");
  expect(refused([zone({ music: "../x" })])).toContain("Town");
  expect(refused(Array.from({ length: 257 }, (_, i) => zone({ name: `Z${i}` })))).not.toBeNull();
  expect(refused("zones")).not.toBeNull();
});

test("zonesOfKind gives only the zones of that kind, with name, bounds and rings", () => {
  const zones = ok(cleanZones([zone({ name: "Peaks", kind: "snow" }), zone({ name: "Dunes", kind: "desert" })], 100, 100));
  expect(zonesOfKind(zones, "snow")).toEqual([{ name: "Peaks", bbox: { x: 10, y: 10, w: 5, h: 5 }, outline: [square(10, 10, 5)] }]);
});

test("applyZones sets deserts and snowfields by kind", () => {
  const zones = ok(cleanZones([zone({ name: "Peaks", kind: "snow" }), zone({ name: "Dunes", kind: "desert" }), zone({ name: "Town" })], 100, 100));
  const data: any = {};
  applyZones(data, zones);
  expect(data.zones.map((z: any) => z.name)).toEqual(["Peaks", "Dunes", "Town"]);
  expect(data.deserts.map((z: any) => z.name)).toEqual(["Dunes"]);
  expect(data.snowfields.map((z: any) => z.name)).toEqual(["Peaks"]);
});

test("applyZones removes snowfields when no snow zone is left", () => {
  const data: any = { snowfields: [{ name: "Old" }], deserts: [{ name: "Old" }] };
  applyZones(data, ok(cleanZones([zone({ name: "Town" })], 100, 100)));
  expect(data.zones.map((z: any) => z.name)).toEqual(["Town"]);
  expect("snowfields" in data).toBe(false);
  expect("deserts" in data).toBe(false);
});

test("a world's zones are loaded one by one: a bad generated zone is left out, the rest come through", () => {
  const { zones, dropped } = cleanZonesLenient([zone({ name: "Wind Fields", kind: "grassland", id: 0 }), zone({ name: "Broken", outline: [[[0, 0], [1, 1]]] })], 100, 100);
  const data: any = {};
  applyZones(data, zones);
  expect(data.zones.map((z: any) => z.name)).toEqual(["Wind Fields"]);
  expect(data.zones[0]).toMatchObject({ id: 0, kind: "grassland" });
  expect(dropped.length).toBe(1);
});

test("zonesForSave gives nothing when zones is missing", () => {
  expect(zonesForSave(undefined, 100, 100)).toEqual({});
  expect(zonesForSave(null, 100, 100)).toEqual({});
});

test("zonesForSave cleans an array", () => {
  const result = zonesForSave([zone({ music: "Town Theme" })], 100, 100) as { zones: MapZone[] };
  expect(result.zones[0]).toMatchObject({ name: "Town", music: "town theme", bbox: { x: 10, y: 10, w: 5, h: 5 } });
  expect(zonesForSave([], 100, 100)).toEqual({ zones: [] });
});

test("zonesForSave passes an error", () => {
  const result = zonesForSave([zone({ outline: [[[0, 0], [1, 1]]] })], 100, 100) as { error: string };
  expect(result.error).toContain("Town");
  expect((zonesForSave("zones", 100, 100) as { error: string }).error).toBeTruthy();
});

test("packetManager.mapZones encodes type MAP_ZONES", () => {
  expect(packetTypes.MAP_ZONES).toBe("MAP_ZONES");
  const zones = ok(cleanZones([zone()], 100, 100));
  const [encoded] = packetManager.mapZones({ mapName: "town.json", zones });
  expect(JSON.parse(new TextDecoder().decode(encoded))).toEqual({ type: "MAP_ZONES", data: { mapName: "town.json", zones } });
});

test("sizeAfterSave is the size in tiles a plain map's zones are checked against, grown by the save", () => {
  const map = { width: 50, height: 40, layers: [{ type: "tilelayer", width: 50, height: 40, data: [] }] };
  expect(sizeAfterSave(map, undefined)).toEqual({ width: 50, height: 40 });
  expect(sizeAfterSave(map, { width: 70, height: 30 })).toEqual({ width: 70, height: 40 });
  // grown left and up: the origin moves, the map gets that much bigger
  expect(sizeAfterSave(map, { minTileX: -10, minTileY: -5, width: 50, height: 40 })).toEqual({ width: 60, height: 45 });
});

test("fillHoles drops a ring that lies inside another ring of the zone", () => {
  expect(fillHoles([square(10, 10, 20), square(15, 15, 3)])).toEqual([square(10, 10, 20)]);
});

test("fillHoles drops a hole listed before the ring around it", () => {
  expect(fillHoles([square(15, 15, 3), square(10, 10, 20)])).toEqual([square(10, 10, 20)]);
});

test("fillHoles drops a hole that touches the ring around it", () => {
  expect(fillHoles([square(10, 10, 20), [[10, 10], [15, 10], [10, 15]]])).toEqual([square(10, 10, 20)]);
});

test("fillHoles drops an island inside a hole as well", () => {
  expect(fillHoles([square(10, 10, 30), square(15, 15, 20), square(20, 20, 5)])).toEqual([square(10, 10, 30)]);
});

test("fillHoles keeps one of two rings that are the same", () => {
  expect(fillHoles([square(10, 10, 5), square(10, 10, 5)])).toEqual([square(10, 10, 5)]);
});

test("fillHoles keeps rings that lie apart", () => {
  expect(fillHoles([square(10, 10, 5), square(30, 30, 5)])).toEqual([square(10, 10, 5), square(30, 30, 5)]);
});

test("fillHoles keeps a ring in the notch of another ring, outside it", () => {
  const u = [[0, 0], [30, 0], [30, 30], [20, 30], [20, 10], [10, 10], [10, 30], [0, 30]];
  expect(fillHoles([u, square(12, 15, 5)])).toEqual([u, square(12, 15, 5)]);
});

test("cleanZones fills the holes of a zone it keeps", () => {
  const [town] = ok(cleanZones([zone({ outline: [square(10, 10, 20), square(15, 15, 3)] })], 100, 100));
  expect(town!.outline).toEqual([square(10, 10, 20)]);
});

test("a world's zones are loaded with their holes filled", () => {
  const { zones } = cleanZonesLenient([zone({ outline: [square(10, 10, 20), square(15, 15, 3)] })], 100, 100);
  expect(zones[0]!.outline).toEqual([square(10, 10, 20)]);
});

const rect = (x: number, y: number, w: number, h: number) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const area = (outline: number[][][]) => outline.reduce((sum, ring) => {
  let twice = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) twice += ring[j]![0]! * ring[i]![1]! - ring[i]![0]! * ring[j]![1]!;
  return sum + Math.abs(twice) / 2;
}, 0);
const named = (zones: MapZone[], name: string) => zones.find((z) => z.name === name)!;
// Zones as cleanZones gives them, before they are pulled apart
const placed = (list: Array<{ name: string; outline: number[][][] }>): MapZone[] => list.map((z) => {
  const xs = z.outline.flat().map((p) => p[0]!), ys = z.outline.flat().map((p) => p[1]!);
  return { ...z, bbox: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) } };
});

test("separateZones cuts the larger of two overlapping zones back to the edge of the smaller one", () => {
  const { zones, notes } = separateZones(placed([zone({ name: "Forest", outline: [square(0, 0, 30)] }), zone({ name: "Town", outline: [square(20, 20, 20)] })]));
  expect(named(zones, "Town").outline).toEqual([square(20, 20, 20)]);
  const forest = named(zones, "Forest");
  expect(area(forest.outline)).toBe(800);
  expect(forest.outline.every((ring) => ringRelation(ring, square(20, 20, 20)) === "apart")).toBe(true);
  expect(forest.bbox).toEqual({ x: 0, y: 0, w: 30, h: 30 });
  expect(notes).toEqual(["Zone Forest was cut back to the edge of Town"]);
});

test("separateZones keeps the zones in their order", () => {
  const { zones } = separateZones(placed([zone({ name: "Town", outline: [square(20, 20, 20)] }), zone({ name: "Forest", outline: [square(0, 0, 30)] })]));
  expect(zones.map((z) => z.name)).toEqual(["Town", "Forest"]);
});

test("separateZones leaves a zone inside another one, and zones apart, as they are", () => {
  const list = placed([zone({ name: "Forest", outline: [square(0, 0, 30)] }), zone({ name: "Town", outline: [square(5, 5, 5)] }), zone({ name: "Lake", outline: [square(30, 0, 10)] })]);
  const { zones, notes } = separateZones(list);
  expect(zones).toEqual(list);
  expect(notes).toEqual([]);
});

test("separateZones cuts a zone back to every smaller zone over it", () => {
  const { zones, notes } = separateZones(placed([
    zone({ name: "Forest", outline: [square(0, 0, 40)] }),
    zone({ name: "Camp", outline: [square(35, 5, 10)] }),
    zone({ name: "Mill", outline: [square(10, 35, 10)] }),
  ]));
  expect(area(named(zones, "Forest").outline)).toBe(1500);
  expect(notes).toEqual(["Zone Forest was cut back to the edge of Camp, Mill"]);
});

test("separateZones cuts a zone in two where a smaller one crosses it", () => {
  const { zones } = separateZones(placed([zone({ name: "Field", outline: [rect(0, 5, 30, 10)] }), zone({ name: "Road", outline: [rect(10, 0, 10, 20)] })]));
  const field = named(zones, "Field");
  expect(field.outline).toHaveLength(2);
  expect(field.outline.map((ring) => area([ring]))).toEqual([100, 100]);
});

test("separateZones keeps a zone as it is, with a note, when its cut cannot be made in whole tiles", () => {
  const list = placed([zone({ name: "Wood", outline: [[[3, 5], [10, 2], [6, 8]]] }), zone({ name: "Pond", outline: [[[2, 5], [4, 3], [8, 6]]] })]);
  const { zones, notes } = separateZones(list);
  expect(zones).toEqual(list);
  expect(notes).toEqual(["Zone Wood overlaps Pond and could not be cut back to its edge"]);
});

test("a map's zones are loaded with overlaps cut back to the smaller zone's edge", () => {
  const { zones, fixed } = cleanZonesLenient([zone({ name: "Forest", outline: [square(0, 0, 30)] }), zone({ name: "Town", outline: [square(20, 20, 20)] })], 100, 100);
  expect(area(named(zones, "Forest").outline)).toBe(800);
  expect(fixed).toEqual(["Zone Forest was cut back to the edge of Town"]);
});

test("cleanZones cuts overlapping zones of a save back to the smaller zone's edge", () => {
  const zones = ok(cleanZones([zone({ name: "Forest", outline: [square(0, 0, 30)] }), zone({ name: "Town", outline: [square(20, 20, 20)] })], 100, 100));
  expect(area(named(zones, "Forest").outline)).toBe(800);
});
