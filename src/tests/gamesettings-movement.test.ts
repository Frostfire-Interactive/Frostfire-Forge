import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { databaseModule } from "./setup";

mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));

const { loadGameSettings, setting } = await import("../systems/gamesettings/store");
const { overriddenSpeed } = await import("../systems/speedoverride");

// movement.ts starts the world when imported, so the speed functions are cut out of its source.
const source = readFileSync(new URL("../socket/handlers/movement.ts", import.meta.url), "utf8");
const cut = (start: string, until: RegExp): string => {
  const at = source.indexOf(start);
  if (at < 0) throw new Error(`Not found in movement.ts: ${start}`);
  const rest = source.slice(at);
  return rest.slice(0, rest.search(until));
};
const code = `${cut("const baseSpeed", /\r?\n\r?\n/)}\n${cut("function walkSpeedOf(", /\r?\n}\r?\n/)}\n}`;
const walkSpeedOf: (player: any) => number = new Function(
  "setting", "overriddenSpeed",
  `"use strict";\n${new Bun.Transpiler({ loader: "ts" }).transformSync(code)}\nreturn walkSpeedOf;`,
)(setting, overriddenSpeed);

const row = (setting_key: string, value: string) => ({ setting_key, value, updated_by: "tester", updated_at: 1 });

describe("walk speed follows the game settings", () => {
  test("default walk is 6 px a tick", async () => {
    await loadGameSettings({ read: async () => [] });
    expect(walkSpeedOf({})).toBe(6);
  });

  test("walkSpeed 240 gives 8", async () => {
    await loadGameSettings({ read: async () => [row("walkSpeed", "240")] });
    expect(walkSpeedOf({})).toBe(8);
  });

  test("mounted x mount", async () => {
    await loadGameSettings({ read: async () => [row("mountSpeedMultiplier", "2")] });
    expect(walkSpeedOf({ mounted: true })).toBe(12);
    expect(walkSpeedOf({})).toBe(6);
  });

  test("ghost x ghost when the two differ", async () => {
    await loadGameSettings({ read: async () => [row("mountSpeedMultiplier", "2"), row("ghostSpeedMultiplier", "3")] });
    expect(walkSpeedOf({ isGhost: true })).toBe(18);
    expect(walkSpeedOf({ mounted: true })).toBe(12);
    expect(walkSpeedOf({ mounted: true, isGhost: true })).toBe(12);
  });
});
