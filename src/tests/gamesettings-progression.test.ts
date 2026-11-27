import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { characterDatabaseModule } from "./setup";

mock.module("../controllers/sqldatabase", () => characterDatabaseModule({ default: async () => ({ affectedRows: 1 }) }));

const realDatacache = await import("../services/datacache");
const realRowCache = realDatacache.rowCache;
let patches = 0;
mock.module("../services/datacache", () => ({
  ...realDatacache,
  rowCache: (...args: any[]) => {
    const rows: any = (realRowCache as any)(...args);
    const patch = rows.patch.bind(rows);
    rows.patch = (...a: any[]) => { patches++; return patch(...a); };
    return rows;
  },
}));

const realRegistry = await import("../systems/gamesettings/registry");
const realCap = realRegistry.maxLevelCap;
let ceilingCalls = 0;
mock.module("../systems/gamesettings/registry", () => ({
  ...realRegistry,
  maxLevelCap: (fn: (level: number) => number) => { ceilingCalls++; return realCap(fn); },
}));

const { loadGameSettings } = await import("../systems/gamesettings/store");
const { default: player } = await import("../systems/player");

const row = (setting_key: string, value: string) => ({ setting_key, value, updated_by: "tester", updated_at: 1 });
let current: ReturnType<typeof row>[] = [];
const load = async (...rows: ReturnType<typeof row>[]) => {
  current = rows;
  await loadGameSettings({ read: async () => current, write: async () => {}, remove: async () => {} });
};
const stats = (over: Record<string, number>) => ({ health: 100, max_health: 100, stamina: 100, max_stamina: 100, xp: 0, max_xp: 100, level: 1, ...over });
const held = (over: Record<string, number>) => spyOn(player, "getStats").mockImplementation((async () => stats(over)) as any);

afterAll(async () => { await load(); });

describe("game settings progression", () => {
  test("the level ceiling is worked out once, not on every call", async () => {
    await load(row("xpToNextLevel", "100"));
    const spy = held({ level: 1, xp: 0, max_xp: 100 });
    ceilingCalls = 0;
    await player.increaseXp("pc_hero", 1);
    await player.increaseXp("pc_hero", 1);
    spy.mockRestore();
    expect(ceilingCalls).toBe(1);
  });

  test("the cached ceiling follows a save that changes the curve", async () => {
    await load(row("xpToNextLevel", "level ^ 3"));
    const spy = held({ level: 1, xp: 0, max_xp: 1 });
    const steep: any = await player.increaseXp("pc_hero", Number.MAX_SAFE_INTEGER);
    spy.mockRestore();
    await load(row("xpToNextLevel", "100"));
    const flat = held({ level: 1, xp: 0, max_xp: 100 });
    const longer: any = await player.increaseXp("pc_hero", 1_000_000);
    flat.mockRestore();
    expect(longer.level).toBeGreaterThan(steep.level);
  });

  test("a gain refused at the cap in a batch writes nothing", async () => {
    await load(row("maxLevel", "5"));
    const spy = held({ level: 8, xp: 3, max_xp: 200 });
    const queries: string[] = [];
    const batch: any = {
      pending: async (_rows: any, _name: string, start: () => Promise<any>) => start(),
      kept: (fn: () => any) => kept.push(fn),
      after: () => {}, undone: () => {}, add: (q: any) => queries.push(q.sql),
    };
    const kept: Array<() => any> = [];
    patches = 0;
    expect(await player.increaseXp("pc_hero", 100, batch)).toEqual({ xp: 3, level: 8, max_xp: 200 });
    expect(kept.length).toBeGreaterThan(0);
    for (const step of kept) await step();
    spy.mockRestore();
    expect(queries).toEqual([]);
    expect(patches).toBe(0);
  });

  test("default curve unchanged", async () => {
    await load();
    expect(player.getNewMaxXp(10)).toBe(Math.floor(100 * 1.1 ** 9));
    expect(player.getMaxHealthForLevel(4)).toBe(Math.floor(100 + 4 ** 1.5 * 5));
    expect(player.getMaxStaminaForLevel(4)).toBe(Math.floor(100 + 4 ** 1.5 * 3));
  });

  test("edited curve used at next level-up", async () => {
    await load(row("xpToNextLevel", "level * 10"));
    const spy = held({ level: 3, xp: 0, max_xp: 30 });
    const result: any = await player.increaseXp("pc_hero", 35);
    spy.mockRestore();
    expect(result.level).toBe(4);
    expect(result.max_xp).toBe(40);
    expect(result.xp).toBe(5);
  });

  test("above the cap gains nothing", async () => {
    await load(row("maxLevel", "5"));
    const spy = held({ level: 8, xp: 3, max_xp: 200 });
    const result: any = await player.increaseXp("pc_hero", 100);
    spy.mockRestore();
    expect(result).toEqual({ xp: 3, level: 8, max_xp: 200 });
  });

  test("levelling stops at the cap with a full bar", async () => {
    await load(row("maxLevel", "3"));
    const spy = held({ level: 2, xp: 0, max_xp: 110 });
    const result: any = await player.increaseXp("pc_hero", 1_000_000);
    spy.mockRestore();
    expect(result.level).toBe(3);
    // Stored below the target, so a later cap raise asks for the level's XP; the bar is full only in what is sent.
    expect(result.xp).toBeLessThan(result.max_xp);
    const { shownStats } = await import("../systems/xpshown");
    expect(shownStats(result).xp).toBe(result.max_xp);
  });

  test("a full bar at the cap is what every XP and stats packet sends", async () => {
    await load(row("maxLevel", "3"));
    const { packetManager } = await import("../socket/packet_manager");
    const sent = (frames: any[]) => JSON.parse(new TextDecoder().decode(frames[0])).data;
    const capped = { id: "p1", xp: 0, level: 3, max_xp: 121, health: 10 };
    expect(sent(packetManager.updateXp({ id: "p1", xp: 0, level: 3, max_xp: 121 })).xp).toBe(121);
    expect(sent(packetManager.stats(capped)).xp).toBe(121);
    expect(sent(packetManager.updateStats({ id: "p1", target: "p1", stats: capped })).stats.xp).toBe(121);
    expect(sent(packetManager.revive({ id: "p1", target: "p1", stats: capped })).stats.xp).toBe(121);
    expect(capped.xp).toBe(0);
    // Below the cap the stored XP is sent as it is.
    expect(sent(packetManager.updateXp({ id: "p1", xp: 5, level: 2, max_xp: 110 })).xp).toBe(5);
  });

  test("after a cap raise a character who reached the old cap needs the curve's XP to level", async () => {
    await load(row("maxLevel", "3"));
    const first = held({ level: 2, xp: 0, max_xp: 110 });
    const capped: any = await player.increaseXp("pc_hero", 1_000_000);
    first.mockRestore();
    await load(row("maxLevel", "5"));
    const raised = held({ level: capped.level, xp: capped.xp, max_xp: capped.max_xp });
    const result: any = await player.increaseXp("pc_hero", 1);
    raised.mockRestore();
    expect(result.level).toBe(3);
    expect(result.xp).toBe(capped.xp + 1);
  });

  test("a character stored at the old cap with a full bar (xp = max_xp) does not level on 1 XP after a raise", async () => {
    await load(row("maxLevel", "5"));
    const spy = held({ level: 3, xp: 121, max_xp: 121 });
    const result: any = await player.increaseXp("pc_hero", 1);
    spy.mockRestore();
    expect(result.level).toBe(3);
    expect(result.xp).toBe(1);
  });

  test("E6: a character above a lowered cap is shown a full bar and keeps what is stored", async () => {
    await load(row("maxLevel", "5"));
    const { shownStats } = await import("../systems/xpshown");
    const stored = { level: 8, xp: 3, max_xp: 200 };
    expect(shownStats(stored)).toEqual({ level: 8, xp: 200, max_xp: 200 });
    expect(stored.xp).toBe(3);
    const spy = held({ level: 8, xp: 3, max_xp: 200 });
    expect(await player.increaseXp("pc_hero", 50)).toEqual({ xp: 3, level: 8, max_xp: 200 });
    spy.mockRestore();
  });

  test("E7: LOGIN_SUCCESS and GAME_SETTINGS carry the client's settings in their shape", async () => {
    await load(row("walkSpeed", "200"), row("chatMaxLength", "300"));
    const { packetManager } = await import("../socket/packet_manager");
    const { clientSettings } = await import("../systems/gamesettings/store");
    const decode = (frames: any[]) => JSON.parse(new TextDecoder().decode(frames[0]));
    const shape = { walkSpeed: 200, mountSpeedMultiplier: 1.35, ghostSpeedMultiplier: 1.35, chatMaxLength: 300 };
    const login = decode(packetManager.login({ data: { id: "p1", secret: "s", chatDecryptionKey: "k" } }));
    expect(login.type).toBe("LOGIN_SUCCESS");
    expect(login.settings).toEqual(shape);
    const pushed = decode(packetManager.gameSettings(clientSettings()));
    expect(pushed).toEqual({ type: "GAME_SETTINGS", data: shape });
  });

  test("M7: with no cap a character at the default curve's reach gains nothing, is shown a full bar, and is not corrupted", async () => {
    await load();
    const { DEFAULT_CURVE_REACH, MAX_XP_VALUE } = await import("../systems/gamesettings/registry");
    const { shownStats } = await import("../systems/xpshown");
    const top = DEFAULT_CURVE_REACH;
    expect(top).toBe(178);
    const maxXp = player.getNewMaxXp(top);
    expect(maxXp).toBeLessThanOrEqual(MAX_XP_VALUE);
    const spy = held({ level: top, xp: 7, max_xp: maxXp });
    const result: any = await player.increaseXp("pc_hero", 1_000_000_000);
    spy.mockRestore();
    expect(result).toEqual({ xp: 7, level: top, max_xp: maxXp });
    expect(shownStats(result).xp).toBe(maxXp);
    // One level below the reach levels into it and stops there, its target within the column.
    const below = held({ level: top - 1, xp: 0, max_xp: player.getNewMaxXp(top - 1) });
    const up: any = await player.increaseXp("pc_hero", Number.MAX_SAFE_INTEGER);
    below.mockRestore();
    expect(up.level).toBe(top);
    expect(up.max_xp).toBe(maxXp);
    expect(up.xp).toBeLessThan(up.max_xp);
    expect(shownStats(up).xp).toBe(maxXp);
  });

  test("no cap on a steep curve (level ^ 3) stops at the last level whose XP target fits", async () => {
    await load(row("xpToNextLevel", "level ^ 3"));
    const { maxLevelCap } = await import("../systems/gamesettings/registry");
    const { formula } = await import("../systems/gamesettings/store");
    const ceiling = maxLevelCap(formula("xpToNextLevel"));
    expect(ceiling).toBeGreaterThan(1);
    const spy = held({ level: ceiling - 1, xp: 0, max_xp: (ceiling - 1) ** 3 });
    const result: any = await player.increaseXp("pc_hero", Number.MAX_SAFE_INTEGER);
    spy.mockRestore();
    expect(result.level).toBe(ceiling);
    expect(result.xp).toBeLessThan(result.max_xp);
    const again = held({ level: ceiling, xp: result.xp, max_xp: result.max_xp });
    expect(await player.increaseXp("pc_hero", 50)).toEqual({ xp: result.xp, level: ceiling, max_xp: result.max_xp });
    again.mockRestore();
  });
});
