import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { characterDatabaseModule } from "./setup";

mock.module("../controllers/sqldatabase", () => characterDatabaseModule({ default: async () => [] }));

const store: any = await import("../systems/gamesettings/store");
const { defOf, validateValue } = await import("../systems/gamesettings/registry");
const editor: any = await import("../systems/gamesettingseditor");
const { default: log } = await import("../modules/logger");
const { settledPick, nextCycleIn } = await import("../systems/weathercycle");

const staff = { username: "staff", permissions: ["tools.gamesettings"] };

type R = { setting_key: string; value: string; updated_by: string; updated_at: number };
const db = new Map<string, R>();
let removed = 0;
const io = {
  read: async () => [...db.values()],
  write: async (k: string, v: string, by: string) => { db.set(k, { setting_key: k, value: v, updated_by: by, updated_at: 1 }); },
  remove: async (k: string) => { removed++; db.delete(k); },
  cache: { onChange() {} },
};
const row = (setting_key: string, value: string): R => ({ setting_key, value, updated_by: "t", updated_at: 1 });
const packet = (type: string, data: any) => editor.handleEditorPacket(staff, type, data) as Promise<any>;
const entry = (answer: any, key: string) => answer.data.settings.find((s: any) => s.key === key);

beforeEach(async () => {
  db.clear();
  removed = 0;
  await store.loadGameSettings(io);
});

afterAll(async () => {
  db.clear();
  await store.loadGameSettings(io);
});

describe("N2: readAgain reads the settings again after any reload in flight", () => {
  test("it reloads and tells the listeners", async () => {
    let told = 0;
    const off = store.onSettingsChanged(() => { told++; });
    try {
      db.set("walkSpeed", row("walkSpeed", "222"));
      await store.readAgain();
      expect(store.setting("walkSpeed")).toBe(222);
      expect(told).toBe(1);
    } finally {
      off();
    }
  });

  test("it runs after a reload already in flight, so it reads what was saved since", async () => {
    const heard: Array<(elsewhere: boolean) => void> = [];
    let rows: R[] = [row("walkSpeed", "210")];
    let release: () => void = () => {};
    let gate: Promise<void> | null = null;
    const cache = { onChange: (key: string, listener: (elsewhere: boolean) => void) => { if (key === "game_settings") heard.push(listener); } };
    await store.loadGameSettings({ ...io, cache, read: async () => { const now = rows; if (gate) await gate; return now; } });
    gate = new Promise<void>((r) => { release = r; });
    heard[0]!(true);
    await Bun.sleep(1); // the first reload has read the 210 row and waits on the gate
    rows = [row("walkSpeed", "240")];
    const again = store.readAgain();
    gate = null;
    release();
    await again;
    expect(store.setting("walkSpeed")).toBe(240);
  });
});

describe("N3: a preview answer says which value it previewed", () => {
  test("formulas, numbers and refused values are echoed as sent", async () => {
    const formula = await packet("GAME_SETTINGS_EDITOR_PREVIEW", { key: "maxHealth", value: "100 + level * 2" });
    expect(formula.ok).toBe(true);
    expect(formula.data.value).toBe("100 + level * 2");
    const number = await packet("GAME_SETTINGS_EDITOR_PREVIEW", { key: "maxLevel", value: 40 });
    expect(number.data.value).toBe(40);
    const bad = await packet("GAME_SETTINGS_EDITOR_PREVIEW", { key: "maxHealth", value: "level +" });
    expect(bad.ok).toBe(false);
    expect(bad.data.value).toBe("level +");
  });
});

describe("N4: a saved row the reload refused is listed as saved, with why, and can be reset", () => {
  test("listed as overridden with the refusal; a reset deletes it", async () => {
    const quiet = spyOn(log, "warn").mockImplementation(() => {});
    try {
      db.set("mailDays", row("mailDays", "-77"));
      await store.loadGameSettings(io);
      const listed = await packet("GAME_SETTINGS_EDITOR_LIST", null);
      const mail = entry(listed, "mailDays");
      expect(mail.overridden).toBe(true);
      expect(typeof mail.refused).toBe("string");
      expect(mail.refused).toBe(store.refusalOf("mailDays"));
      expect(mail.value).toBe(defOf("mailDays")!.default);
      expect(entry(listed, "walkSpeed").overridden).toBe(false);
      expect(entry(listed, "walkSpeed").refused).toBeUndefined();

      const answer = await packet("GAME_SETTINGS_EDITOR_RESET", { key: "mailDays" });
      expect(answer.ok).toBe(true);
      expect(answer.changed).toBe(true);
      expect(removed).toBe(1);
      expect(db.has("mailDays")).toBe(false);
      const after = entry(await packet("GAME_SETTINGS_EDITOR_LIST", null), "mailDays");
      expect(after.overridden).toBe(false);
      expect(after.refused).toBeUndefined();
    } finally {
      quiet.mockRestore();
    }
  });
});

describe("N6: the first stretch of a new weather cycle length is at least that length", () => {
  test("after the held stretch, the next one ends at least one new length later, then epoch stretches", async () => {
    const c30 = 30 * 60_000;
    const c7 = 7 * 60_000;
    // A 30-minute boundary one minute before a 7-minute one, two days ahead (clear of any stretch held at the real time).
    let j = Math.ceil((Date.now() + 2 * 86_400_000) / c30);
    j += (((3 - (j % 7)) % 7) + 7) % 7;
    const end = j * c30;
    expect(Math.ceil(end / c7) * c7 - end).toBe(60_000);
    const table = ["rain", "snow", "fog", "clear", "thunderstorm", "drizzle", "hail"].map((name) => ({ name }));
    const worlds = Array.from({ length: 24 }, (_, n) => `n6world${n}`);
    const clock = spyOn(Date, "now").mockImplementation(() => end - 10 * 60_000);
    try {
      db.set("weatherCycleMinutes", row("weatherCycleMinutes", "7"));
      await store.loadGameSettings(io);
      expect(nextCycleIn(end - 1)).toBe(1);
      // The first new stretch runs from the held end to the first 7-minute boundary at least 7 minutes on.
      const bridgeEnd = end + 8 * 60_000;
      expect(nextCycleIn(end)).toBe(bridgeEnd - end);
      expect(nextCycleIn(end)).toBeGreaterThanOrEqual(c7);
      const first = worlds.map((w) => settledPick(table, w, end)!.name);
      expect(worlds.map((w) => settledPick(table, w, end + 90_000)!.name)).toEqual(first);
      expect(worlds.map((w) => settledPick(table, w, bridgeEnd - 1)!.name)).toEqual(first);
      // Then the epoch's 7-minute stretches, as on any node.
      expect(nextCycleIn(bridgeEnd)).toBe(c7);
      const sorted = table.slice().sort((a, b) => (a.name < b.name ? -1 : 1));
      const plain = (w: string, at: number) => sorted[Number(BigInt(Bun.hash(`${w}:${Math.floor(at / c7)}`)) % BigInt(sorted.length))]!.name;
      expect(worlds.map((w) => settledPick(table, w, bridgeEnd + 1)!.name)).toEqual(worlds.map((w) => plain(w, bridgeEnd + 1)));
      // Back to the default, still at the far time, so nothing is held at the real one.
      db.delete("weatherCycleMinutes");
      await store.loadGameSettings(io);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("N7: checking the same formulas again costs next to nothing", () => {
  test("a second check of a flat no-cap XP curve is served from what the first worked out", () => {
    const vals: Record<string, string | number> = { xpToNextLevel: "107 + level", maxLevel: 0 };
    const ctx = { maxLevel: 0, current: (k: string) => vals[k] ?? defOf(k)!.default };
    const xp = defOf("xpToNextLevel")!;
    const cap = defOf("maxLevel")!;
    let t = performance.now();
    const first = [validateValue(xp, vals.xpToNextLevel, ctx), validateValue(cap, 0, ctx)];
    const cold = performance.now() - t;
    t = performance.now();
    const second = [validateValue(xp, vals.xpToNextLevel, ctx), validateValue(cap, 0, ctx)];
    const warm = performance.now() - t;
    expect(second).toEqual(first);
    expect(first.every((r) => r.ok)).toBe(true);
    expect(warm).toBeLessThan(cold / 4);
  });

  test("a misfit is still refused, and named, when served again", () => {
    const vals: Record<string, string | number> = { xpToNextLevel: "100", maxHealth: "100 + level * 30000" };
    const ctx = { maxLevel: 0, current: (k: string) => vals[k] ?? defOf(k)!.default };
    const a = validateValue(defOf("xpToNextLevel")!, "100", ctx);
    const b = validateValue(defOf("xpToNextLevel")!, "100", ctx);
    expect(a.ok).toBe(false);
    expect(b).toEqual(a);
    if (!a.ok) expect(a.error).toContain("Max health formula does not fit with no level cap (checked to level 100000)");
  });
});
