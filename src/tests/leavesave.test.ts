import { beforeEach, describe, expect, test } from "bun:test";
import { databaseModule, mockQuery, standInFor } from "./setup";

const wrote: string[] = [];
const seen = (line: string) => { wrote.push(line); };

await standInFor("../controllers/sqldatabase", () => databaseModule({ default: mockQuery }));
await standInFor("../services/effectmanager", () => ({
  default: {
    saveDots: (u: string, list: any[]) => seen(`dots ${u} ${JSON.stringify(list)}`),
    saveBarriers: (u: string, list: any[]) => seen(`barriers ${u} ${JSON.stringify(list)}`),
    saveStuns: (u: string, list: any[]) => seen(`stuns ${u} ${JSON.stringify(list)}`),
    saveSlows: (u: string, list: any[]) => seen(`slows ${u} ${JSON.stringify(list)}`),
  },
}));
await standInFor("../systems/dots", () => ({ default: { getPlayerDots: (id: string) => (id === "7" ? [{ id: "burn" }] : undefined) } }));
await standInFor("../systems/spelleffects", () => ({
  getStunsForPlayer: (id: string) => (id === "7" ? [{ until: 1 }] : null),
  getSlowsForPlayer: (id: string) => (id === "7" ? [{ until: 2 }] : null),
}));
await standInFor("../systems/resurrection", () => ({ saveOnDisconnect: (p: any) => seen(`sickness ${p.username}`) }));
await standInFor("../systems/player", () => ({
  default: {
    setStats: async (who: any, stats: any) => seen(`stats ${who.username} ${JSON.stringify(stats)}`),
    setLocation: async (id: string, map: string, position: any) => seen(`location by session ${id} ${map} ${position.x},${position.y}`),
    setLocationByUsername: async (u: string, map: string, position: any) => seen(`location of ${u} ${map} ${position.x},${position.y}`),
  },
}));

const { saveLeavingEffects, saveLeavingState } = await import("../socket/leavesave");

const hero = (more: Record<string, any> = {}) => ({
  id: 7, username: "Hero", barriers: [{ id: "shield" }], stats: { health: 3 }, location: { map: "main", position: { x: 4, y: 5 } }, ...more,
});

beforeEach(() => { wrote.length = 0; });

describe("saveLeavingEffects", () => {
  test("saves the dots, barriers, stuns and slows on the player under its lowercased name, then its sickness", () => {
    saveLeavingEffects(hero());
    expect(wrote).toEqual([
      'dots hero [{"id":"burn"}]',
      'barriers hero [{"id":"shield"}]',
      'stuns hero [{"until":1}]',
      'slows hero [{"until":2}]',
      "sickness Hero",
    ]);
  });

  test("saves empty lists for a player with no effects", () => {
    saveLeavingEffects(hero({ id: 8, barriers: undefined }));
    expect(wrote).toEqual(["dots hero []", "barriers hero []", "stuns hero []", "slows hero []", "sickness Hero"]);
  });

  test("saves nothing for a guest, nobody, or a player with no name", () => {
    saveLeavingEffects(hero({ isGuest: true }));
    saveLeavingEffects(null);
    saveLeavingEffects(hero({ username: "" }));
    expect(wrote).toEqual([]);
  });
});

describe("saveLeavingState", () => {
  test("a disconnect: the stats, then the location by the session", async () => {
    await saveLeavingState(hero(), true);
    expect(wrote).toEqual(['stats Hero {"health":3}', "location by session 7 main 4,5"]);
  });

  test("a kick: the stats, then the location by the character", async () => {
    await saveLeavingState(hero(), false);
    expect(wrote).toEqual(['stats Hero {"health":3}', "location of Hero main 4,5"]);
  });

  test("no stats, no stats write; no full location, no location write", async () => {
    await saveLeavingState(hero({ stats: null }), true);
    await saveLeavingState(hero({ location: { map: "main" } }), false);
    await saveLeavingState(hero({ location: null }), false);
    expect(wrote).toEqual(["location by session 7 main 4,5", 'stats Hero {"health":3}', 'stats Hero {"health":3}']);
  });

  test("saves nothing for a guest", async () => {
    await saveLeavingState(hero({ isGuest: true }), true);
    expect(wrote).toEqual([]);
  });
});
