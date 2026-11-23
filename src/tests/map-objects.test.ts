import { describe, expect, test } from "bun:test";
import { CHEST_RESET_DEFAULT_MIN, MAP_OBJECT_LIMIT, MAP_OBJECT_REFUSED, cleanChests, cleanPortals, loadedMapObjects, mapObjectOptionsFor, portalFrom, portalsFrom, portalTiledProperties, readChestObject, readPortalObject } from "../systems/mapobjects";

describe("mapObjectOptionsFor", () => {
  test("an editor without map rights gets empty lists and the reason, nothing is loaded", async () => {
    let loaded = 0;
    const load = async () => { loaded++; return { dungeons: [{ id: 2, name: "Crypt" }], lootTables: [{ id: "3", name: "Gold" }] }; };
    expect(await mapObjectOptionsFor(false, load)).toEqual({ dungeons: [], lootTables: [], message: MAP_OBJECT_REFUSED });
    expect(loaded).toBe(0);
    expect(await mapObjectOptionsFor(true, load)).toEqual({ dungeons: [{ id: 2, name: "Crypt" }], lootTables: [{ id: 3, name: "Gold" }] });
  });
});

const chest = (name: string) => ({ name, lootTableId: 1, resetMinutes: 30, position: { x: 0, y: 0 }, layer: null });
const portal = (name: string) => ({ name, kind: "dungeon" as const, dungeonId: 1 as number | null, mirror: true, target: null as { map: string; x: number; y: number } | null, position: { x: 0, y: 0 }, size: { width: 32, height: 32 }, layer: null });
const teleport = (name: string) => ({ ...portal(name), kind: "teleport" as const, dungeonId: null, target: { map: "town", x: 100, y: 200 } });

describe("readChestObject", () => {
  test("reads a Tiled chest with the default reset", () => {
    expect(readChestObject({ name: "C1", x: 10.7, y: 20.2, properties: [{ name: "loot_table", value: 4 }] }, "Chests"))
      .toEqual({ name: "C1", lootTableId: 4, resetMinutes: 30, position: { x: 10, y: 20 }, layer: "Chests" });
    expect(CHEST_RESET_DEFAULT_MIN).toBe(30);
  });
  test("reads reset_minutes", () => {
    expect(readChestObject({ name: "C", x: 0, y: 0, properties: [{ name: "loot_table", value: 2 }, { name: "reset_minutes", value: 5 }] }, null)?.resetMinutes).toBe(5);
  });
  test("a reset_minutes out of range is brought into 1 to 1440 minutes, and one that is no number is the default", () => {
    const reset = (value: unknown, notes: string[] = []) =>
      readChestObject({ name: "C", x: 0, y: 0, properties: [{ name: "loot_table", value: 2 }, { name: "reset_minutes", value }] }, null, (m) => notes.push(m))?.resetMinutes;
    const notes: string[] = [];
    expect(reset(0, notes)).toBe(1);
    expect(reset(-5)).toBe(1);
    expect(reset(5000)).toBe(1440);
    expect(reset("2000")).toBe(1440);
    expect(reset(2.6)).toBe(3);
    expect(reset("soon")).toBe(CHEST_RESET_DEFAULT_MIN);
    expect(reset(null)).toBe(CHEST_RESET_DEFAULT_MIN);
    expect(notes).toEqual(["C: reset_minutes 0 is not a whole number of 1 to 1440, so it is 1"]);
    const quiet: string[] = [];
    expect(reset(45, quiet)).toBe(45);
    expect(quiet).toEqual([]);
  });
  test("a chest without a loot table is refused", () => {
    expect(readChestObject({ name: "C2", x: 0, y: 0, properties: [] }, null)).toBeNull();
    expect(readChestObject({ name: "C2", x: 0, y: 0 }, null)).toBeNull();
    expect(readChestObject({ name: "C2", x: 0, y: 0, properties: [{ name: "loot_table", value: 0 }] }, null)).toBeNull();
  });
});

describe("readPortalObject", () => {
  test("reads a Tiled portal", () => {
    expect(readPortalObject({ name: "P", x: 5, y: 6, width: 32, height: 48, properties: [{ name: "dungeon", value: 2 }] }, null))
      .toEqual({ name: "P", kind: "dungeon", dungeonId: 2, mirror: true, target: null, position: { x: 5, y: 6 }, size: { width: 32, height: 48 }, layer: null });
  });
  test("a portal without a dungeon is kept, linked to nothing", () => {
    expect(readPortalObject({ name: "P", x: 5, y: 6, width: 32, height: 48, properties: [] }, null)?.dungeonId).toBeNull();
    expect(readPortalObject({ name: "P", x: 5, y: 6, width: 0, height: 48, properties: [] }, null)).toBeNull();
  });
  test("reads a teleport portal and Mirror other side", () => {
    const props = [{ name: "kind", value: "teleport" }, { name: "map", value: "town" }, { name: "x", value: 100 }, { name: "y", value: "200" }, { name: "mirror", value: false }];
    expect(readPortalObject({ name: "T", x: 0, y: 0, width: 32, height: 32, properties: props }, "L"))
      .toEqual({ ...teleport("T"), mirror: false, layer: "L" });
  });
});

describe("portalTiledProperties", () => {
  test("a portal's Tiled properties read back as the same portal", () => {
    for (const p of [portal("P"), teleport("T"), { ...portal("U"), dungeonId: null, mirror: false }]) {
      const obj = { name: p.name, x: 0, y: 0, width: 32, height: 32, properties: portalTiledProperties(p) };
      expect(readPortalObject(obj, null)).toEqual(p);
    }
  });
});

describe("portalFrom", () => {
  test("an old portal without kind or mirror is a dungeon portal that mirrors", () => {
    expect(portalFrom({ name: "p", dungeonId: 3, position: { x: 1, y: 2 }, size: { width: 32, height: 32 }, layer: null }))
      .toEqual({ ...portal("p"), dungeonId: 3, position: { x: 1, y: 2 } });
  });
  test("mirror is off only when it says false", () => {
    expect(portalFrom({ ...portal("p"), mirror: false })!.mirror).toBe(false);
    expect(portalFrom({ ...portal("p"), mirror: "false" })!.mirror).toBe(false);
    expect(portalFrom({ ...portal("p"), mirror: undefined })!.mirror).toBe(true);
  });
  test("a teleport keeps its target and has no dungeon; a dungeon portal has no target", () => {
    expect(portalFrom({ ...teleport("t"), dungeonId: 4 })).toEqual(teleport("t"));
    expect(portalFrom({ ...portal("p"), target: { map: "town", x: 1, y: 1 } })!.target).toBeNull();
    expect(portalFrom({ ...teleport("t"), target: { map: "", x: 1, y: 1 } })!.target).toBeNull();
  });
  test("a return portal keeps the link to its source, a teleport's return or a dungeon's exit", () => {
    const ret = { ...teleport("r"), returnOf: { map: "fields", name: "Gate" } };
    expect(portalFrom(ret)).toEqual(ret);
    expect(portalFrom({ ...ret, returnOf: { map: "fields.json", name: " Gate " } })!.returnOf).toEqual({ map: "fields", name: "Gate" });
    expect("returnOf" in portalFrom(teleport("t"))!).toBe(false);
    const exit = { ...portal("e"), dungeonId: null, returnOf: { map: "overworld", name: "Gate" } };
    expect(portalFrom(exit)).toEqual(exit);
    expect(readPortalObject({ name: "e", x: 0, y: 0, width: 32, height: 32, properties: portalTiledProperties(exit) }, null)).toMatchObject({ returnOf: exit.returnOf });
    expect("returnOf" in portalFrom({ ...ret, returnOf: { map: "", name: "Gate" } })!).toBe(false);
    const obj = { name: "r", x: 0, y: 0, width: 32, height: 32, properties: portalTiledProperties(ret) };
    expect(readPortalObject(obj, null)).toEqual(ret);
    expect(cleanPortals([ret])).toEqual({ portals: [ret] });
  });
  test("a portal with no place or size is dropped", () => {
    expect(portalFrom({ ...portal("p"), position: null })).toBeNull();
    expect(portalFrom(null)).toBeNull();
    expect(portalsFrom([portal("a"), { name: "b" }, "x"]).map((p) => p.name)).toEqual(["a"]);
    expect(portalsFrom(undefined)).toEqual([]);
  });
});

describe("loadedMapObjects", () => {
  test("a chest with no name, or the name of one before it, gets the first free Chest_<n>, as the map editor names them", () => {
    const list = loadedMapObjects("Chest", [chest(""), chest("Gold"), chest("Gold"), chest("Chest_1"), chest("  ")], undefined)!;
    expect(list.map((c) => c.name)).toEqual(["Chest_2", "Gold", "Chest_3", "Chest_1", "Chest_4"]);
    // The editor can save the list as it is.
    expect("error" in cleanChests(list)).toBe(false);
    // The same file gives the same names each time it is read.
    expect(loadedMapObjects("Chest", [chest(""), chest("Gold"), chest("Gold"), chest("Chest_1"), chest("  ")], undefined)!.map((c) => c.name))
      .toEqual(list.map((c) => c.name));
  });
  test("names are trimmed, and a portal is named DungeonPortal_<n>", () => {
    expect(loadedMapObjects("DungeonPortal", [portal(" Door "), portal("")], undefined)!.map((p) => p.name)).toEqual(["Door", "DungeonPortal_1"]);
  });
  test("a saved list wins over the Tiled objects; each saved one keeps the layer of the Tiled object with its name", () => {
    const tiled = [{ ...chest("A"), layer: "Upper" }, { ...chest("A"), layer: "Lower" }];
    const saved = [{ ...chest("A"), layer: null }, { ...chest("Chest_1"), layer: null }, { ...chest("Gone"), layer: "Old" }];
    expect(loadedMapObjects("Chest", tiled, saved)!.map((c) => [c.name, c.layer])).toEqual([["A", "Upper"], ["Chest_1", "Lower"], ["Gone", "Old"]]);
    expect(loadedMapObjects("Chest", tiled, { x: { ...chest("A"), layer: null } })!.map((c) => [c.name, c.layer])).toEqual([["A", "Upper"]]);
    expect(loadedMapObjects("Chest", tiled, [])).toEqual([]);
  });
  test("no Tiled objects and no saved list leave the map as it is", () => {
    expect(loadedMapObjects("Chest", [], undefined)).toBeUndefined();
  });
});

describe("cleanChests", () => {
  test("accepts a good list, empty too", () => {
    expect(cleanChests([])).toEqual({ chests: [] });
    expect(cleanChests([chest("a"), chest("b")])).toEqual({ chests: [chest("a"), chest("b")] });
  });
  test("refuses bad lists", () => {
    expect("error" in cleanChests("x")).toBe(true);
    expect("error" in cleanChests([{ ...chest("a"), resetMinutes: 0 }])).toBe(true);
    expect("error" in cleanChests([{ ...chest("a"), resetMinutes: 1441 }])).toBe(true);
    expect("error" in cleanChests([{ ...chest("a"), resetMinutes: 1.5 }])).toBe(true);
    expect("error" in cleanChests([{ ...chest("a"), lootTableId: 0 }])).toBe(true);
    expect("error" in cleanChests([{ ...chest("a"), position: { x: NaN, y: 0 } }])).toBe(true);
    expect("error" in cleanChests([chest("a"), chest("a")])).toBe(true);
    expect("error" in cleanChests([{ ...chest("a"), name: "" }])).toBe(true);
  });
  test("refuses more than the limit", () => {
    const many = Array.from({ length: MAP_OBJECT_LIMIT + 1 }, (_, i) => chest(`c${i}`));
    expect("error" in cleanChests(many)).toBe(true);
    expect("error" in cleanChests(many.slice(0, MAP_OBJECT_LIMIT))).toBe(false);
  });
});

describe("cleanPortals", () => {
  test("accepts a good list", () => {
    expect(cleanPortals([portal("p")])).toEqual({ portals: [portal("p")] });
    expect(cleanPortals([])).toEqual({ portals: [] });
    expect(cleanPortals([teleport("t")])).toEqual({ portals: [teleport("t")] });
    expect(cleanPortals([{ ...portal("p"), dungeonId: null }])).toEqual({ portals: [{ ...portal("p"), dungeonId: null }] });
  });
  test("old portals without kind or mirror come back as dungeon portals that mirror", () => {
    const old = { name: "p", dungeonId: 1, position: { x: 0, y: 0 }, size: { width: 32, height: 32 }, layer: null };
    expect(cleanPortals([old])).toEqual({ portals: [portal("p")] });
  });
  test("refuses bad lists", () => {
    expect("error" in cleanPortals([{ ...portal("p"), dungeonId: 0 }])).toBe(true);
    expect("error" in cleanPortals([{ ...portal("p"), size: { width: 0, height: 32 } }])).toBe(true);
    expect("error" in cleanPortals([portal("p"), portal("p")])).toBe(true);
    expect("error" in cleanPortals([{ ...portal("p"), position: { x: Infinity, y: 0 } }])).toBe(true);
    expect("error" in cleanPortals([{ ...portal("p"), kind: "door" }])).toBe(true);
    expect("error" in cleanPortals([{ ...teleport("t"), target: null }])).toBe(true);
    expect("error" in cleanPortals([{ ...teleport("t"), target: { map: "", x: 0, y: 0 } }])).toBe(true);
    expect("error" in cleanPortals([{ ...teleport("t"), target: { map: "town", x: -1, y: 0 } }])).toBe(true);
  });
});
