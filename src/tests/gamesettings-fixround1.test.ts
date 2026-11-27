import { afterAll, describe, expect, mock, test } from "bun:test";
import { databaseModule } from "./setup";

mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));

const { loadGameSettings } = await import("../systems/gamesettings/store");
const { SETTINGS, defOf, validateValue } = await import("../systems/gamesettings/registry");
const resurrection = await import("../systems/resurrection");
const { getEffectsPayload } = await import("../systems/spelleffects");
const { arrivalLimits, handoffStateOf } = await import("../socket/arrival");

const row = (setting_key: string, value: string) => ({ setting_key, value, updated_by: "tester", updated_at: 1 });
const load = (...rows: Array<[string, string]>) => loadGameSettings({ read: async () => rows.map(([k, v]) => row(k, v)) });
afterAll(() => load());

const statsOf = () => ({ total_max_health: 1000, total_max_stamina: 1000, stat_damage: 100, health: 1000, stamina: 1000 });
const sickLine = (player: any) => getEffectsPayload({ ...player, barriers: [], visualEffects: [] }).find((e: any) => e.id === "resurrection-sickness");

describe("sickness stays as it was given", () => {
  test("a sickness given before an edit keeps its stats, description and length; the next one uses the new values", async () => {
    await load();
    const player: any = { id: 9101, username: "GivenSick", stats: {} };
    resurrection.applySickness(player);
    await load(["resSicknessMinutes", "60"], ["resSicknessHealthMultiplier", "0.5"], ["resSicknessStatMultiplier", "0.7"]);

    const stats = resurrection.applySicknessToStats(statsOf(), player);
    expect([stats.total_max_health, stats.total_max_stamina, stats.stat_damage]).toEqual([800, 900, 90]);
    const line = sickLine(player);
    expect(line.duration).toBe(900);
    expect(line.description).toBe("-20% max health, -10% all other stats");
    expect(line.remaining).toBeLessThanOrEqual(900);
    expect(line.remaining).toBeGreaterThan(890);

    // After a logout and login on this node the sickness is the same.
    resurrection.saveOnDisconnect(player);
    const back: any = { id: 9102, username: "GivenSick", stats: statsOf() };
    expect(resurrection.restoreOnLogin(back)).toBe(true);
    expect(back.stats.total_max_health).toBe(800);

    resurrection.clearSickness(player);
    resurrection.forgetSickness(player);
    const next: any = { id: 9103, username: "GivenSick", stats: {} };
    resurrection.applySickness(next);
    const fresh = resurrection.applySicknessToStats(statsOf(), next);
    expect([fresh.total_max_health, fresh.stat_damage]).toEqual([500, 70]);
    const nextLine = sickLine(next);
    expect(nextLine.duration).toBe(3600);
    expect(nextLine.description).toBe("-50% max health, -30% all other stats");
    resurrection.clearSickness(next);
  });

  test("a handoff carries what the sickness was given with, and the clamp does not cut it", async () => {
    await load();
    const now = Date.now();
    const limits = arrivalLimits([], now);
    const known = { maps: [{ name: "main.json" }], caster: () => true };
    const given = { durationMs: 3_600_000, healthMult: 0.5, statMult: 0.7 };
    const kept = handoffStateOf({ sickUntil: now + 3_500_000, sickGiven: given }, limits, "Long", known);
    expect(kept.sickUntil).toBe(now + 3_500_000);
    expect(kept.sickGiven).toEqual(given);
    // Without it the clamp is the live length, as before.
    const cut = handoffStateOf({ sickUntil: now + 3_500_000 }, limits, "Long", known);
    expect(cut.sickUntil).toBe(now + 15 * 60 * 1000);
    // A forged record cannot stretch the sickness past what the setting allows.
    const forged = handoffStateOf({ sickUntil: now + 9e9, sickGiven: { durationMs: 9e9, healthMult: 5, statMult: -1 } }, limits, "Forger", known);
    expect(forged.sickUntil).toBeLessThanOrEqual(now + 240 * 60 * 1000 + 60_000);
    expect(forged.sickGiven!.healthMult).toBeLessThanOrEqual(1);
    expect(forged.sickGiven!.statMult).toBeGreaterThan(0);
  });
});

describe("limits fit their columns", () => {
  test("subjectMax cannot pass the 64 character column", () => {
    expect(defOf("subjectMax")!.max).toBe(64);
    expect(validateValue(defOf("subjectMax")!, "65", { maxLevel: 0 }).ok).toBe(false);
    expect(validateValue(defOf("subjectMax")!, "64", { maxLevel: 0 }).ok).toBe(true);
  });

  test("no other mail or trade limit can pass its column", () => {
    // body and items are TEXT (65535 bytes): 4 bytes a character, and about 100 bytes of JSON an item.
    expect(defOf("bodyMax")!.max! * 4).toBeLessThan(65535);
    expect(defOf("mailItemsMax")!.max! * 100).toBeLessThan(65535);
    expect(defOf("tradeItemsMax")!.max! * 100).toBeLessThan(65535);
    // expires_at is BIGINT milliseconds.
    expect(defOf("mailDays")!.max! * 86_400_000).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(SETTINGS.length).toBeGreaterThan(0);
  });
});

describe("regen with nothing to restore", () => {
  test("a regen percent of 0 leaves the pool as it was, so no stats frame is due", async () => {
    const { regenTo } = await import("../systems/regen");
    expect(regenTo(500, 1000, 0)).toBe(500);
    expect(regenTo(500, 1000, 10)).toBe(600);
    expect(regenTo(990, 1000, 10)).toBe(1000);
    expect(regenTo(1000, 1000, 10)).toBe(1000);
  });
});
