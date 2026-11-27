import { afterAll, describe, expect, mock, test } from "bun:test";
import { databaseModule } from "./setup";

mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));

mock.module("../config/settings.json", () => ({
  default: { creatures: {} },
  creatures: {},
}));

const { loadGameSettings } = await import("../systems/gamesettings/store");
const { joinOutcome, canInvite } = await import("../systems/partyrules");
const { maxChatLength, maxCommandLength, chatRateMax, chatRateWindow, chatTooLong } = await import("../systems/chatlimits");
const { CreatureRegistry } = await import("../systems/creatures/registry");
const { CreatureSpawner, rollRespawnMs } = await import("../systems/creatures/spawner");
const { normalizeSpawn, normalizeTemplate } = await import("../systems/creatures/repository");
const { corpseWithLootMs, corpseEmptyMs } = await import("../systems/creatures/constants");
const { regenAmount, healthRegenAmount, staminaRegenAmount, pvpFlagExpired } = await import("../systems/regen");
const resurrection = await import("../systems/resurrection");
const { castTimeCoefficient, rollHeal, gcdSeconds } = await import("../systems/spellmath");
const { nextCycleIn, weatherCycleMs } = await import("../systems/weathercycle");
const { postageFor, mailRange, mailDays } = await import("../systems/mail");
const { tradeRange, tradeItemsMax, acceptDelayMs } = await import("../systems/trades");
const { default: loot } = await import("../systems/loot");

const row = (setting_key: string, value: string) => ({ setting_key, value, updated_by: "tester", updated_at: 1 });
const load = (...rows: Array<[string, string]>) => loadGameSettings({ read: async () => rows.map(([k, v]) => row(k, v)) });

afterAll(() => load());

describe("the remaining constants follow the game settings", () => {
  test("defaults equal today's constants", async () => {
    await load();
    expect(joinOutcome(5, false)).toBe("convert");
    expect(joinOutcome(20, true)).toBe("full");
    expect(maxChatLength()).toBe(500);
    expect(maxCommandLength()).toBe(600);
    expect([chatRateMax(), chatRateWindow()]).toEqual([5, 3000]);
    expect([corpseWithLootMs(), corpseEmptyMs()]).toEqual([300_000, 60_000]);
    expect(healthRegenAmount(1000)).toBe(10);
    expect(staminaRegenAmount(1000)).toBe(50);
    expect(pvpFlagExpired(5000)).toBe(false);
    expect(pvpFlagExpired(5001)).toBe(true);
    expect([resurrection.sicknessDurationMs(), resurrection.sicknessDurationSec()]).toEqual([900_000, 900]);
    expect(gcdSeconds()).toBe(1.5);
    expect(weatherCycleMs()).toBe(30 * 60 * 1000);
    expect([mailRange(), mailDays(), postageFor(0)]).toEqual([120, 30, 30]);
    expect([tradeRange(), tradeItemsMax(), acceptDelayMs()]).toEqual([120, 8, 2000]);
    expect(loot.PICKUP_RADIUS).toBe(100);
  });

  test("party join refused past partySize 2", async () => {
    await load(["partySize", "2"]);
    expect(joinOutcome(1, false)).toBe("join");
    expect(joinOutcome(2, false)).toBe("convert");
    expect(joinOutcome(2, true)).toBe("join");
    expect(canInvite(19)).toBe(true);
    await load(["partySize", "2"], ["raidSize", "3"]);
    expect(joinOutcome(3, true)).toBe("full");
    expect(canInvite(3)).toBe(false);
  });

  test("chat over chatMaxLength 60 refused/trimmed as today's code does at 500", async () => {
    await load();
    expect(chatTooLong("x".repeat(500))).toBe(false);
    expect(chatTooLong("x".repeat(501))).toBe(true);
    await load(["chatMaxLength", "60"], ["chatRateMax", "2"], ["chatRateWindowMs", "1000"]);
    expect(chatTooLong("x".repeat(60))).toBe(false);
    expect(chatTooLong("x".repeat(61))).toBe(true);
    expect(maxCommandLength()).toBe(160);
    expect([chatRateMax(), chatRateWindow()]).toEqual([2, 1000]);
  });

  test("respawn delay scales with respawnMultiplier 2", async () => {
    const spawn = normalizeSpawn({ id: 1, template_id: 1, map: "main", x: 100, y: 200, respawn_min_s: 10, respawn_max_s: 20, layer_policy: "shared" });
    const template = normalizeTemplate({ id: 1, name: "Wolf", level_min: 3, level_max: 5, health_base: 50, health_per_level: 10 });
    const build = (multiplier?: number) => {
      const spawner = new CreatureSpawner(new CreatureRegistry(64), {}, () => 0, multiplier);
      spawner.load({ templates: new Map([[1, template]]), spawns: new Map([[1, spawn]]), pools: new Map(), patrolPaths: new Map() }, 1000);
      return spawner;
    };

    await load(["respawnMultiplier", "2"]);
    expect(rollRespawnMs(spawn, undefined, () => 0)).toBe(20_000);
    const live = build();
    live.despawn(live.getLiveInstanceId(1)!, 2000);
    expect(live.getPendingAt(1)).toBe(2000 + 20_000);

    // The live value applies to the next respawn scheduled, not the one made at load.
    await load(["respawnMultiplier", "3"]);
    live.tick(22_000);
    live.despawn(live.getLiveInstanceId(1)!, 25_000);
    expect(live.getPendingAt(1)).toBe(25_000 + 30_000);

    // A multiplier handed to the constructor wins over the setting.
    const pinned = build(1);
    pinned.despawn(pinned.getLiveInstanceId(1)!, 2000);
    expect(pinned.getPendingAt(1)).toBe(12_000);
  });

  test("corpse times are read in seconds", async () => {
    await load(["corpseWithLootSeconds", "100"], ["corpseEmptySeconds", "20"]);
    expect([corpseWithLootMs(), corpseEmptyMs()]).toEqual([100_000, 20_000]);
  });

  test("regen tick heals healthRegenPercent 10", async () => {
    expect(regenAmount(1000, 10)).toBe(100);
    expect(regenAmount(5, 1)).toBe(1);
    expect(regenAmount(1000, 0)).toBe(0);
    await load(["healthRegenPercent", "10"], ["staminaRegenPercent", "20"]);
    expect(healthRegenAmount(1000)).toBe(100);
    expect(staminaRegenAmount(1000)).toBe(200);
  });

  test("resurrection sickness uses edited minutes", async () => {
    await load(["resSicknessMinutes", "5"], ["resSicknessHealthMultiplier", "0.5"], ["resSicknessStatMultiplier", "0.7"]);
    const player: any = { id: 9001, username: "sick", stats: {} };
    const before = Date.now();
    const until = resurrection.applySickness(player);
    expect(until - before).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(until - before).toBeLessThan(5 * 60 * 1000 + 1000);
    expect(resurrection.sicknessDurationSec()).toBe(300);
    const stats = resurrection.applySicknessToStats({ total_max_health: 1000, total_max_stamina: 1000, stat_damage: 100, health: 1000, stamina: 1000 });
    expect(stats.total_max_health).toBe(500);
    expect(stats.total_max_stamina).toBe(700);
    expect(stats.stat_damage).toBe(70);
    resurrection.clearSickness(player);
  });

  test("pvp flag lasts pvpFlagSeconds", async () => {
    await load(["pvpFlagSeconds", "20"]);
    expect(pvpFlagExpired(5001)).toBe(false);
    expect(pvpFlagExpired(20_000)).toBe(false);
    expect(pvpFlagExpired(20_001)).toBe(true);
  });

  test("GCD reads globalCooldownSeconds", async () => {
    await load();
    expect(castTimeCoefficient(0)).toBeCloseTo(1.5 / 3.5);
    await load(["globalCooldownSeconds", "2.5"]);
    expect(gcdSeconds()).toBe(2.5);
    expect(castTimeCoefficient(0)).toBeCloseTo(2.5 / 3.5);
    expect(castTimeCoefficient(3)).toBeCloseTo(3 / 3.5);
  });

  test("crit heal reads critHealMultiplier", async () => {
    const caster = { level: 1, stat_damage: 0, stat_critical_chance: 100 };
    await load();
    expect(rollHeal(20, caster, 0, () => 0).amount).toBe(30);
    await load(["critHealMultiplier", "2"]);
    expect(rollHeal(20, caster, 0, () => 0).amount).toBe(40);
  });

  test("weather cycle reads weatherCycleMinutes", async () => {
    await load(["weatherCycleMinutes", "10"]);
    expect(weatherCycleMs()).toBe(600_000);
    expect(nextCycleIn(5 * 600_000)).toBe(600_000);
    expect(nextCycleIn(5 * 600_000 + 1)).toBe(599_999);
  });

  test("mail, trade and loot limits read the settings", async () => {
    await load(["postageCopper", "50"], ["mailRange", "200"], ["tradeRange", "300"], ["tradeItemsMax", "4"], ["acceptDelayMs", "0"], ["lootPickupRadius", "250"]);
    expect(postageFor(0)).toBe(50);
    expect(postageFor(3)).toBe(150);
    expect(mailRange()).toBe(200);
    expect([tradeRange(), tradeItemsMax(), acceptDelayMs()]).toEqual([300, 4, 0]);
    expect(loot.PICKUP_RADIUS).toBe(250);
  });
});
