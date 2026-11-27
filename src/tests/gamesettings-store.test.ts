import { describe, expect, mock, test } from "bun:test";
import { databaseModule } from "./setup";

mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));

const { loadGameSettings, setting, formula, clientSettings, onSettingsChanged, saveSetting, resetSetting, overrides } =
  await import("../systems/gamesettings/store");

const row = (setting_key: string, value: string) => ({ setting_key, value, updated_by: "tester", updated_at: 1 });
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("game settings store", () => {
  test("defaults with no rows", async () => {
    await loadGameSettings({ read: async () => [] });
    expect(setting("walkSpeed")).toBe(180);
    expect(formula("xpToNextLevel")(1)).toBe(100);
  });

  test("rows override", async () => {
    await loadGameSettings({ read: async () => [row("walkSpeed", "240")] });
    expect(setting("walkSpeed")).toBe(240);
    expect(overrides().walkSpeed.updatedBy).toBe("tester");
  });

  test("bad rows fall back to defaults", async () => {
    await loadGameSettings({ read: async () => [row("xpToNextLevel", "foo("), row("walkSpeed", "0"), row("nope", "1")] });
    expect(setting("walkSpeed")).toBe(180);
    expect(formula("xpToNextLevel")(1)).toBe(100);
    expect(Object.keys(overrides())).toEqual([]);
  });

  test("setting throws for a formula key", async () => {
    await loadGameSettings({ read: async () => [] });
    expect(() => setting("xpToNextLevel")).toThrow();
  });

  test("missing table gives defaults", async () => {
    await loadGameSettings({ read: async () => { throw new Error("SQLITE_ERROR: no such table: game_settings"); } });
    expect(setting("walkSpeed")).toBe(180);
  });

  test("another node's save is read again", async () => {
    let rows = [row("walkSpeed", "200")];
    // A cache of its own: other test files replace the real one, and bun keeps their mocks for the rest of the run.
    const heardBy: Array<(elsewhere: boolean) => void> = [];
    const cache = { onChange: (key: string, listener: (elsewhere: boolean) => void) => { if (key === "game_settings") heardBy.push(listener); } };
    await loadGameSettings({ read: async () => rows, cache });
    await loadGameSettings({ read: async () => rows, cache });
    expect(setting("walkSpeed")).toBe(200);
    expect(heardBy.length).toBe(1);
    let heard = 0;
    const stop = onSettingsChanged(() => heard++);
    rows = [row("walkSpeed", "260")];
    heardBy[0](false);
    await tick();
    expect(setting("walkSpeed")).toBe(200);
    heardBy[0](true);
    await tick();
    stop();
    expect(setting("walkSpeed")).toBe(260);
    expect(heard).toBe(1);
  });

  test("save and reset write, reload and notify", async () => {
    const table = new Map<string, string>();
    await loadGameSettings({
      read: async () => [...table].map(([k, v]) => row(k, v)),
      write: async (k, v) => void table.set(k, v),
      remove: async (k) => void table.delete(k),
    });
    let heard = 0;
    const stop = onSettingsChanged(() => heard++);
    await saveSetting("walkSpeed", 210, "staff");
    expect(setting("walkSpeed")).toBe(210);
    await expect(saveSetting("walkSpeed", 0, "staff")).rejects.toThrow();
    await resetSetting("walkSpeed", "staff");
    stop();
    expect(setting("walkSpeed")).toBe(180);
    expect(heard).toBe(2);
  });

  test("clientSettings carries speeds and chat length", async () => {
    await loadGameSettings({ read: async () => [row("chatMaxLength", "300")] });
    expect(clientSettings()).toEqual({ walkSpeed: 180, mountSpeedMultiplier: 1.35, ghostSpeedMultiplier: 1.35, chatMaxLength: 300 });
  });
});
