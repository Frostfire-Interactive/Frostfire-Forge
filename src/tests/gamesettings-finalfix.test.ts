import { beforeEach, describe, expect, mock, test } from "bun:test";
import { databaseModule } from "./setup";

mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));

const store = await import("../systems/gamesettings/store");
const { defOf, validateValue } = await import("../systems/gamesettings/registry");
const editor = await import("../systems/gamesettingseditor");
const { overriddenSpeed } = await import("../systems/speedoverride");

const staff = { username: "staff", permissions: ["tools.gamesettings"] };

type R = { setting_key: string; value: string; updated_by: string; updated_at: number };
const db = new Map<string, R>();
const io = {
  read: async () => [...db.values()],
  write: async (k: string, v: string, by: string) => { db.set(k, { setting_key: k, value: v, updated_by: by, updated_at: 1 }); },
  remove: async (k: string) => { db.delete(k); },
  cache: { onChange() {} },
};
const def = (key: string) => defOf(key)!;
const save = (key: string, value: unknown) => editor.handleEditorPacket(staff, "GAME_SETTINGS_EDITOR_SAVE", { key, value }) as Promise<any>;

beforeEach(async () => {
  db.clear();
  await store.loadGameSettings(io);
});

describe("I1: party and raid sizes are checked against the rows being loaded", () => {
  test("a party size above the default raid size survives its own save", async () => {
    await store.saveSetting("raidSize", 50, "t");
    await store.saveSetting("partySize", 30, "t");
    expect(store.setting("raidSize")).toBe(50);
    expect(store.setting("partySize")).toBe(30);
  });

  test("a party row larger than its raid row is still refused on load", async () => {
    await store.loadGameSettings({ ...io, read: async () => [
      { setting_key: "partySize", value: "30", updated_by: "t", updated_at: 1 },
      { setting_key: "raidSize", value: "25", updated_by: "t", updated_at: 1 },
    ] });
    expect(store.setting("partySize")).toBe(5);
    expect(store.setting("raidSize")).toBe(25);
  });
});

describe("I2: a level cap change is held to the saved health and stamina formulas", () => {
  test("raising the cap past where the saved max health fits is refused, naming the formula", async () => {
    expect((await save("maxLevel", 50)).ok).toBe(true);
    expect((await save("maxHealth", "100 + 2 ^ (level / 3)")).ok).toBe(true);
    const before = store.formula("maxHealth")(50);
    const answer = await save("maxLevel", 150);
    expect(answer.ok).toBe(false);
    expect(answer.fields.maxLevel).toContain("Max health");
    expect(store.setting("maxLevel")).toBe(50);
    expect(store.formula("maxHealth")(50)).toBe(before);
    await expect(store.saveSetting("maxLevel", 150, "t")).rejects.toThrow(/Max health/);
  });

  test("removing the cap is refused for a stamina formula that only fits under it", async () => {
    await store.saveSetting("maxLevel", 50, "t");
    await store.saveSetting("maxStamina", "100 + 2 ^ (level / 3)", "t");
    const answer = await save("maxLevel", 0);
    expect(answer.ok).toBe(false);
    expect(answer.fields.maxLevel).toContain("Max stamina");
    expect(store.setting("maxLevel")).toBe(50);
  });

  test("a cap the formulas fit under is still saved", async () => {
    await store.saveSetting("maxLevel", 50, "t");
    await store.saveSetting("maxHealth", "100 + 2 ^ (level / 3)", "t");
    expect((await save("maxLevel", 60)).ok).toBe(true);
    expect(store.setting("maxLevel")).toBe(60);
  });
});

describe("I3: a tick's step stays within 30 px", () => {
  test("walk speed is at most 900 px/s", () => {
    expect(def("walkSpeed").max).toBe(900);
    expect(validateValue(def("walkSpeed"), 1000, { maxLevel: 0 }).ok).toBe(false);
  });

  test("walk speed times the larger of the mount and ghost multipliers is at most 900", async () => {
    // 700 x 1.35 is 945 px/s, 31.5 px a tick.
    const walk = await save("walkSpeed", 700);
    expect(walk.ok).toBe(false);
    expect(walk.fields.walkSpeed).toBeTruthy();
    expect(store.setting("walkSpeed")).toBe(180);
    await expect(store.saveSetting("mountSpeedMultiplier", 5.5, "t")).rejects.toThrow();
    expect((await save("mountSpeedMultiplier", 5)).ok).toBe(true); // 180 x 5 = 900
    await store.saveSetting("mountSpeedMultiplier", 1, "t");
    await store.saveSetting("walkSpeed", 200, "t");
    const ghost = await save("ghostSpeedMultiplier", 5); // 200 x 5 = 1000
    expect(ghost.ok).toBe(false);
    expect(ghost.fields.ghostSpeedMultiplier).toBeTruthy();
    expect((await save("ghostSpeedMultiplier", 4.5)).ok).toBe(true); // 900
  });

  test("the defaults are unchanged", () => {
    expect(def("walkSpeed").default).toBe(180);
    expect(def("mountSpeedMultiplier").default).toBe(1.35);
    expect(def("ghostSpeedMultiplier").default).toBe(1.35);
  });

  test("/speed never takes more than 30 px a tick, whatever the base step", () => {
    expect(overriddenSpeed({ speedOverride: 5 }, 30)).toBe(30);
    expect(overriddenSpeed({ speedOverride: 5 }, 10)).toBe(30);
    expect(overriddenSpeed({ speedOverride: 2 }, 6)).toBe(12);
  });
});

describe("I4: the instant spell time says what it is", () => {
  test("label and help speak of instant spells and the coefficient, and the time is at least 0.5", () => {
    const d = def("globalCooldownSeconds");
    expect(d.default).toBe(1.5);
    expect(d.min).toBe(0.5);
    expect(d.label.toLowerCase()).not.toContain("global cooldown");
    expect(d.label.toLowerCase()).toContain("instant");
    expect(d.help).toContain("3.5");
    expect(d.help.toLowerCase()).toContain("instant");
    expect(validateValue(d, 0, { maxLevel: 0 }).ok).toBe(false);
    expect(validateValue(d, 0.5, { maxLevel: 0 }).ok).toBe(true);
  });
});
