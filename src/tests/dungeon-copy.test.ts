import { describe, expect, mock, test } from "bun:test";
import { databaseModule } from "./setup";

mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));
mock.module("../config/settings.json", () => ({ default: { creatures: {} }, creatures: {} }));

const { cloneMapEntries } = await import("../systems/dungeons/mapclone");
const { TEARDOWN_ORDER, closeCopy } = await import("../systems/dungeons/teardown");
const { copyInstances, scaleSpellDamage, bossCount } = await import("../systems/creatures/copyspawn");
const { computeMaxHealth } = await import("../systems/creatures/spawner");
const { normalizeSpawn, normalizeTemplate, normalizeSpawnPool } = await import("../systems/creatures/repository");
const { scaledMaxHealth } = await import("../systems/dungeons/rules");

const tplMap: any = { name: "crypt.json", data: { layers: [] }, compressed: Buffer.from("x"), chunks: null };
const tplProps: any = {
  name: "crypt.json", width: 10, height: 10, tileWidth: 32, tileHeight: 32, version: "7",
  warps: [{ name: "out", map: "main", x: 1, y: 2, position: { x: 0, y: 0 }, size: { width: 32, height: 32 }, layer: null }],
  graveyards: [{ name: "g", position: { x: 5, y: 5 }, layer: null }],
  chests: [{ name: "c", lootTableId: 1, resetMinutes: 30, position: { x: 1, y: 1 }, layer: null }],
  dungeonPortals: [{ name: "p", dungeonId: 1, position: { x: 1, y: 1 }, size: { width: 32, height: 32 }, layer: null }],
};

describe("cloneMapEntries", () => {
  test("shares the map data, copies the properties", () => {
    const { map, props } = cloneMapEntries("crypt", "crypt~a1", [tplMap], [tplProps]);
    expect(map.name).toBe("crypt~a1.json");
    expect(map.data).toBe(tplMap.data);
    expect(map.compressed).toBe(tplMap.compressed);
    expect(props.name).toBe("crypt~a1.json");
    expect(props.version).toBe("7");
    for (const field of ["warps", "graveyards", "chests", "dungeonPortals"] as const) {
      expect(props[field]).not.toBe(tplProps[field]);
      expect(props[field]).toEqual(tplProps[field]);
    }
    expect(props.warps![0]).not.toBe(tplProps.warps[0]);
  });

  test("a dungeon's exit portal on the template is in every copy, with its link", async () => {
    const { portalsFrom } = await import("../systems/mapobjects");
    const exit = { name: "Gate (return)", kind: "dungeon", dungeonId: null, mirror: true, target: null, position: { x: 184, y: 252 }, size: { width: 32, height: 32 }, layer: null, returnOf: { map: "overworld", name: "Gate" } };
    const tpl = { ...tplProps, dungeonPortals: [...tplProps.dungeonPortals, exit] };
    for (const key of ["crypt~a1", "crypt~b2"]) {
      const { props } = cloneMapEntries("crypt", key, [tplMap], [tpl]);
      expect(portalsFrom(props.dungeonPortals).find((p) => p.name === "Gate (return)")).toEqual(exit as any);
    }
  });

  test("a missing template throws", () => {
    expect(() => cloneMapEntries("gone", "gone~a1", [], [])).toThrow();
    expect(() => cloneMapEntries("crypt", "crypt~a1", [tplMap], [])).toThrow();
  });

  test("a template without objects clones null lists", () => {
    const { props } = cloneMapEntries("crypt", "crypt~a1", [tplMap], [{ ...tplProps, warps: null, graveyards: null, chests: undefined, dungeonPortals: undefined }]);
    expect(props.warps).toBeNull();
    expect(props.chests).toBeUndefined();
  });
});

describe("copyInstances", () => {
  const template = (over: any = {}) => normalizeTemplate({ id: 1, name: "Wolf", level_min: 3, level_max: 5, health_base: 50, health_per_level: 10, ...over });
  const spawn = (id: number, map: string, over: any = {}) => normalizeSpawn({ id, template_id: 1, map, x: 100 + id, y: 200, ...over });
  const ids = (() => { let n = 100; return () => ++n; })();

  test("takes the template map's spawns and scales them", () => {
    const t = template();
    const templates = new Map([[1, t]]);
    const inst = copyInstances([spawn(1, "crypt"), spawn(2, "other")], templates, "crypt", "crypt~a1", { health: 2, damage: 1.5 }, ids);
    expect(inst.length).toBe(1);
    expect(inst[0]!.map).toBe("crypt~a1");
    expect(inst[0]!.spawnId).toBe(0);
    expect(inst[0]!.copySpawnId).toBe(1);
    expect(inst[0]!.layerId).toBeNull();
    expect(inst[0]!.maxHealth).toBe(scaledMaxHealth(computeMaxHealth(t, inst[0]!.level), 2));
    expect(inst[0]!.health).toBe(inst[0]!.maxHealth);
    expect(inst[0]!.damageMult).toBe(1.5);
    expect([inst[0]!.x, inst[0]!.y, inst[0]!.homeX, inst[0]!.homeY]).toEqual([101, 200, 101, 200]);
  });

  test("a spawn named with .json counts, a missing template is skipped", () => {
    const inst = copyInstances([spawn(1, "crypt.json"), spawn(3, "crypt", { template_id: 9 })], new Map([[1, template()]]), "crypt", "crypt~a1", { health: 1, damage: 1 }, ids);
    expect(inst.length).toBe(1);
  });

  test("a pool's rare replaces the placeholder once", () => {
    const pool = normalizeSpawnPool({ id: 9, max_active: 2, rare_chance_pct: 50, rare_template_id: 2 });
    const templates = new Map([[1, template()], [2, template({ id: 2, name: "Old Greymane", rank: "rare" })]]);
    const inst = copyInstances(
      [spawn(1, "crypt", { pool_id: 9 }), spawn(2, "crypt", { pool_id: 9 })], templates, "crypt", "crypt~a1",
      { health: 1, damage: 1 }, ids, { pools: new Map([[9, pool]]), r: () => 0 },
    );
    expect(inst.map((i) => i.templateId)).toEqual([2, 1]);
  });

  test("bossCount counts boss rank", () => {
    const templates = new Map([[1, template()], [2, template({ id: 2, rank: "boss" })]]);
    const inst = copyInstances([spawn(1, "crypt"), spawn(2, "crypt", { template_id: 2 }), spawn(3, "crypt", { template_id: 2 })], templates, "crypt", "crypt~a1", { health: 1, damage: 1 }, ids);
    expect(bossCount(inst, templates)).toBe(2);
    expect(bossCount([], templates)).toBe(0);
  });
});

describe("scaleSpellDamage", () => {
  const spell: any = {
    id: 1, name: "Rend", damage: 20,
    effects: [
      { type: "damage_over_time", value: 7, duration: 6, interval: 1 },
      { type: "heal_over_time", value: 5, duration: 6, interval: 1 },
      { type: "stun", value: 0, duration: 2 },
    ],
  };

  test("multiplies damage over time, leaves the rest and the original", () => {
    const scaled = scaleSpellDamage(spell, 2);
    expect(scaled.effects[0].value).toBe(14);
    expect(scaled.effects[1].value).toBe(5);
    expect(scaled.effects[2].value).toBe(0);
    expect(spell.effects[0].value).toBe(7);
    expect(scaled).not.toBe(spell);
  });

  test("a multiplier of 1 returns the spell as is", () => {
    expect(scaleSpellDamage(spell, 1)).toBe(spell);
  });
});

describe("closeCopy", () => {
  test("runs every step in order, continues past a failure and names it", async () => {
    const seen: string[] = [];
    const steps = Object.fromEntries(TEARDOWN_ORDER.map((s) => [s, () => { seen.push(s); if (s === "despawnChests") throw new Error("x"); }]));
    expect(await closeCopy("crypt~a1", steps)).toEqual(["despawnChests"]);
    expect(seen).toEqual(TEARDOWN_ORDER);
  });

  test("order is exact and async steps are awaited", async () => {
    expect(TEARDOWN_ORDER).toEqual(["movePlayersOut", "despawnCreatures", "despawnChests", "despawnGroundLoot", "despawnSkeletons", "clearGroundAoe", "clearSpatialGrid", "forgetCaches", "unregisterMap", "unpinCluster", "removeBookRecord"]);
    const seen: string[] = [];
    const steps: Record<string, () => Promise<void>> = {
      movePlayersOut: async () => { await Promise.resolve(); seen.push("a"); },
      despawnCreatures: async () => { seen.push("b"); throw new Error("y"); },
    };
    expect(await closeCopy("k", steps)).toEqual(["despawnCreatures"]);
    expect(seen).toEqual(["a", "b"]);
  });
});

describe("copy map lists", () => {
  const { addCopyEntries, removeCopyEntries, eachOrReport } = require("../systems/dungeons/maplists");

  function freshCache(initial: Record<string, any>) {
    const store = new Map<string, string>(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
    return {
      get: async (k: string) => JSON.parse(store.get(k) ?? "null"),
      add: async (k: string, v: any) => { store.set(k, JSON.stringify(v)); },
      peek: (k: string) => JSON.parse(store.get(k)!),
    };
  }

  test("a copy added through a cache that returns copies is kept", async () => {
    const cache = freshCache({ maps: [{ name: "crypt.json" }], mapProperties: [{ name: "crypt.json" }] });
    await addCopyEntries(cache, {}, { name: "crypt~a1.json" }, { name: "crypt~a1.json" });
    expect(cache.peek("maps").map((m: any) => m.name)).toEqual(["crypt.json", "crypt~a1.json"]);
    expect(cache.peek("mapProperties").map((m: any) => m.name)).toEqual(["crypt.json", "crypt~a1.json"]);
    await removeCopyEntries(cache, {}, "crypt~a1");
    expect(cache.peek("maps").map((m: any) => m.name)).toEqual(["crypt.json"]);
    expect(cache.peek("mapProperties").map((m: any) => m.name)).toEqual(["crypt.json"]);
  });

  test("the receiver's own lists follow", async () => {
    const cache = freshCache({ maps: [{ name: "crypt.json" }], mapProperties: [{ name: "crypt.json" }] });
    const held = { maps: [{ name: "crypt.json" }] as any[], props: [{ name: "crypt.json" }] as any[] };
    await addCopyEntries(cache, held, { name: "crypt~a1.json" } as any, { name: "crypt~a1.json" } as any);
    expect(held.maps.length).toBe(2);
    expect(held.props.length).toBe(2);
    await removeCopyEntries(cache, held, "crypt~a1");
    expect(held.maps.length).toBe(1);
    expect(held.props.length).toBe(1);
  });

  test("a left-over entry of the same name is replaced by the new copy's, not kept in its place", async () => {
    const cache = freshCache({ maps: [{ name: "crypt.json" }, { name: "crypt~a1", stale: true }], mapProperties: [{ name: "crypt~a1.json", stale: true }] });
    const held = { maps: [{ name: "crypt~a1.json", stale: true }] as any[], props: [] as any[] };
    await addCopyEntries(cache, held, { name: "crypt~a1.json" } as any, { name: "crypt~a1.json", chests: [] } as any);
    expect(cache.peek("maps")).toEqual([{ name: "crypt.json" }, { name: "crypt~a1.json" }]);
    expect(cache.peek("mapProperties")).toEqual([{ name: "crypt~a1.json", chests: [] }]);
    expect(held.maps).toEqual([{ name: "crypt~a1.json" }]);
    expect(held.props).toEqual([{ name: "crypt~a1.json", chests: [] }]);
  });

  test("every player is attempted when one move throws, and the step fails", async () => {
    const moved: string[] = [];
    const reported: string[] = [];
    await expect(eachOrReport(["a", "b", "c"], (p: string) => { if (p === "a") throw new Error("x"); moved.push(p); }, (p: string) => reported.push(p))).rejects.toThrow();
    expect(moved).toEqual(["b", "c"]);
    expect(reported).toEqual(["a"]);
    await eachOrReport(["a"], () => {}, () => {});
  });
});
