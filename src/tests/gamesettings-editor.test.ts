import { beforeEach, describe, expect, mock, test } from "bun:test";
import { databaseModule } from "./setup";

mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));

const { loadGameSettings, setting, formula, overrides } = await import("../systems/gamesettings/store");
const editor = await import("../systems/gamesettingseditor");

const staff = { username: "staff", permissions: ["tools.gamesettings"] };
const nobody = { username: "nobody", permissions: [] as string[] };
const TYPES = ["GAME_SETTINGS_EDITOR_LIST", "GAME_SETTINGS_EDITOR_SAVE", "GAME_SETTINGS_EDITOR_RESET", "GAME_SETTINGS_EDITOR_PREVIEW"];

let table: Map<string, string>;

beforeEach(async () => {
  table = new Map();
  await loadGameSettings({
    read: async () => [...table].map(([k, v]) => ({ setting_key: k, value: v, updated_by: "staff", updated_at: 1 })),
    write: async (k, v) => void table.set(k, v),
    remove: async (k) => void table.delete(k),
    cache: { onChange() {} },
  });
});

describe("game settings editor", () => {
  test("denied without permission", async () => {
    for (const type of TYPES) {
      const answer: any = await editor.handleEditorPacket(nobody, type, { key: "walkSpeed", value: 200 });
      expect(answer.kind).toBe("result");
      expect(answer.denied).toBe(true);
      expect(answer.ok).toBe(false);
    }
    expect(table.size).toBe(0);
  });

  test("tools.gamesettings may list", async () => {
    const answer: any = await editor.handleEditorPacket(staff, "GAME_SETTINGS_EDITOR_LIST", null);
    expect(answer.kind).toBe("data");
    expect(answer.data.sections).toContain("Progression");
    expect(answer.data.settings.find((s: any) => s.key === "walkSpeed")).toMatchObject({ value: 180, overridden: false });
    expect(answer.data.maxLevel).toBe(0);
  });

  test("save writes and reports changed", async () => {
    const answer: any = await editor.handleEditorPacket(staff, "GAME_SETTINGS_EDITOR_SAVE", { key: "walkSpeed", value: 220 });
    expect(answer.ok).toBe(true);
    expect(answer.changed).toBe(true);
    expect(answer.name).toBe("walkSpeed");
    expect(table.get("walkSpeed")).toBe("220");
    expect(setting("walkSpeed")).toBe(220);
    expect(overrides().walkSpeed.updatedBy).toBe("staff");
    expect(answer.data.settings.find((s: any) => s.key === "walkSpeed")).toMatchObject({ value: 220, overridden: true, updatedBy: "staff" });
  });

  test("a bad value is a field error and writes nothing", async () => {
    const answer: any = await editor.handleEditorPacket(staff, "GAME_SETTINGS_EDITOR_SAVE", { key: "walkSpeed", value: 0 });
    expect(answer.ok).toBe(false);
    expect(answer.changed).toBeUndefined();
    expect(answer.fields.walkSpeed).toBeTruthy();
    expect(table.size).toBe(0);
  });

  test("bad formula refused with a field error naming the level", async () => {
    const answer: any = await editor.handleEditorPacket(staff, "GAME_SETTINGS_EDITOR_SAVE", { key: "xpToNextLevel", value: "10 - level" });
    expect(answer.ok).toBe(false);
    expect(answer.fields.xpToNextLevel).toMatch(/level \d+/);
    expect(table.size).toBe(0);
    expect(formula("xpToNextLevel")(1)).toBe(100);
  });

  test("reset deletes the row and returns the default", async () => {
    await editor.handleEditorPacket(staff, "GAME_SETTINGS_EDITOR_SAVE", { key: "walkSpeed", value: 220 });
    const answer: any = await editor.handleEditorPacket(staff, "GAME_SETTINGS_EDITOR_RESET", { key: "walkSpeed" });
    expect(answer.ok).toBe(true);
    expect(answer.changed).toBe(true);
    expect(table.has("walkSpeed")).toBe(false);
    expect(answer.data.settings.find((s: any) => s.key === "walkSpeed")).toMatchObject({ value: 180, overridden: false });
  });

  test("preview gives levels 1-20 and the cap", async () => {
    await editor.handleEditorPacket(staff, "GAME_SETTINGS_EDITOR_SAVE", { key: "maxLevel", value: 30 });
    const answer: any = await editor.handleEditorPacket(staff, "GAME_SETTINGS_EDITOR_PREVIEW", { key: "maxHealth", value: "level * 10" });
    expect(answer.ok).toBe(true);
    const rows: Array<[number, number]> = answer.data.rows;
    expect(rows.length).toBe(21);
    expect(rows[0]).toEqual([1, 10]);
    expect(rows[19]).toEqual([20, 200]);
    expect(rows[20]).toEqual([30, 300]);
    expect(table.has("maxHealth")).toBe(false);

    const bad: any = await editor.handleEditorPacket(staff, "GAME_SETTINGS_EDITOR_PREVIEW", { key: "maxHealth", value: "level *" });
    expect(bad.ok).toBe(false);
    expect(bad.data.rows).toEqual([]);
  });

  test("a level cap preview shows XP rows under the current curve", async () => {
    const answer: any = await editor.handleEditorPacket(staff, "GAME_SETTINGS_EDITOR_PREVIEW", { key: "maxLevel", value: 25 });
    expect(answer.ok).toBe(true);
    expect(answer.data.rows[0]).toEqual([1, 100]);
    expect(answer.data.rows.at(-1)[0]).toBe(25);
  });
});
