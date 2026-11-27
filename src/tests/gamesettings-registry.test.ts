import { describe, expect, test } from "bun:test";
import { compileFormula } from "../systems/gamesettings/formula";
import {
  DEFAULT_CURVE_REACH,
  MAX_XP_VALUE,
  SETTINGS,
  defOf,
  formulaCheckTop,
  maxLevelCap,
  validateFormula,
  validateValue,
} from "../systems/gamesettings/registry";

const def = (key: string) => {
  const d = defOf(key);
  if (!d) throw new Error(`no setting ${key}`);
  return d;
};

const compiled = (key: string) => {
  const r = compileFormula(String(def(key).default));
  if (!r.ok) throw new Error(r.error);
  return r.fn;
};

const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "" : String(r.error));

describe("game settings registry", () => {
  test("keys are unique", () => {
    const keys = SETTINGS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("every default validates", () => {
    for (const d of SETTINGS) {
      const r = validateValue(d, d.default, { maxLevel: 0 });
      if (!r.ok) throw new Error(`${d.key}: ${r.error}`);
      expect(r.ok).toBe(true);
    }
  });

  test("every setting has help text", () => {
    for (const d of SETTINGS) expect(d.help.length).toBeGreaterThan(10);
  });

  test("defaults match today's code", () => {
    const xp = compiled("xpToNextLevel");
    for (const l of [1, 2, 50]) expect(Math.floor(xp(l))).toBe(Math.floor(100 * Math.pow(1.1, l - 1)));
    expect(Math.floor(compiled("maxHealth")(7))).toBe(Math.floor(100 + 7 ** 1.5 * 5));
    expect(Math.floor(compiled("maxStamina")(7))).toBe(Math.floor(100 + 7 ** 1.5 * 3));
    expect((def("walkSpeed").default as number) / 30).toBe(6);
    expect(def("maxLevel").default).toBe(0);
  });

  test("maxLevelCap matches the player editor's level ceiling for the default curve", () => {
    let level = 1;
    while (Math.floor(100 * Math.pow(1.1, level)) <= MAX_XP_VALUE) level++;
    expect(maxLevelCap(compiled("xpToNextLevel"))).toBe(level);
  });

  test("maxLevelCap stops on a curve that never overflows", () => {
    expect(maxLevelCap(() => 100)).toBe(100000);
  });

  test("maxLevelCap is 0 when level 1 already gives no usable XP target", () => {
    expect(maxLevelCap(() => NaN)).toBe(0);
    expect(maxLevelCap(() => 0)).toBe(0);
    expect(maxLevelCap(() => MAX_XP_VALUE + 1)).toBe(0);
  });

  test("formulaCheckTop", () => {
    expect(formulaCheckTop(0)).toBe(1000);
    expect(formulaCheckTop(60)).toBe(60);
  });

  test("validateFormula refuses overflow at a named level", () => {
    const r = validateFormula(def("xpToNextLevel"), "2 ^ level", { maxLevel: 0 });
    expect(r.ok).toBe(false);
    expect(errorOf(r)).toContain("At level 31");
  });

  test("refuses a zero XP target", () => {
    const r = validateFormula(def("xpToNextLevel"), "level - 1", { maxLevel: 0 });
    expect(r.ok).toBe(false);
    expect(errorOf(r)).toContain("At level 1");
  });

  test("refuses NaN", () => {
    const r = validateValue(def("maxHealth"), "sqrt(-level)", { maxLevel: 0 });
    expect(r.ok).toBe(false);
    expect(errorOf(r)).toContain("At level 1");
  });

  test("refuses a formula that does not compile", () => {
    expect(validateValue(def("maxStamina"), "level +", { maxLevel: 0 }).ok).toBe(false);
    expect(validateValue(def("maxStamina"), 5, { maxLevel: 0 }).ok).toBe(false);
  });

  test("with no cap the curve must reach as far as today's (level 178)", () => {
    expect(DEFAULT_CURVE_REACH).toBe(178);
    const xp = def("xpToNextLevel");
    // Today's curve overflows at 179 and is still fine with no cap.
    expect(validateFormula(xp, String(xp.default), { maxLevel: 0 }).ok).toBe(true);
    // One level steeper overflows at 178, inside the reach, and is refused.
    const r = validateFormula(xp, "floor(100 * 1.1 ^ level)", { maxLevel: 0 });
    expect(r.ok).toBe(false);
    expect(errorOf(r)).toContain("At level 178");
    // Results must still be finite all the way to 1000.
    expect(validateFormula(xp, "100 + 1 / (level - 500)", { maxLevel: 0 }).ok).toBe(false);
    expect(xp.help).toContain("up to level 178; set a max level to use a steeper curve.");
  });

  test("checks only to the cap when one is set", () => {
    expect(validateFormula(def("xpToNextLevel"), "2 ^ level", { maxLevel: 20 }).ok).toBe(true);
  });

  test("number range and integer", () => {
    expect(validateValue(def("walkSpeed"), 0, { maxLevel: 0 }).ok).toBe(false);
    expect(validateValue(def("partySize"), 2.5, { maxLevel: 0 }).ok).toBe(false);
    expect(validateValue(def("walkSpeed"), "abc", { maxLevel: 0 }).ok).toBe(false);
    expect(validateValue(def("walkSpeed"), Infinity, { maxLevel: 0 }).ok).toBe(false);
    const r = validateValue(def("walkSpeed"), "240", { maxLevel: 0 });
    expect(r).toEqual({ ok: true, value: 240 });
  });

  test("maxLevel is capped by the current XP curve", () => {
    const cap = maxLevelCap(compiled("xpToNextLevel"));
    expect(validateValue(def("maxLevel"), cap, { maxLevel: 0 }).ok).toBe(true);
    expect(validateValue(def("maxLevel"), cap + 1, { maxLevel: 0 }).ok).toBe(false);
    const steep = { maxLevel: 0, current: (k: string) => (k === "xpToNextLevel" ? "2 ^ level" : def(k).default) };
    expect(validateValue(def("maxLevel"), 30, steep).ok).toBe(true);
    expect(validateValue(def("maxLevel"), 31, steep).ok).toBe(false);
  });

  test("removing the level cap needs an XP curve that fits without one", () => {
    const steep = { maxLevel: 20, current: (k: string) => (k === "xpToNextLevel" ? "2 ^ level" : def(k).default) };
    const r = validateValue(def("maxLevel"), 0, steep);
    expect(r.ok).toBe(false);
    expect(errorOf(r)).toContain("Remove the level cap only after the XP curve fits without one: ");
    expect(errorOf(r)).toContain("At level 31");
    expect(validateValue(def("maxLevel"), 20, steep).ok).toBe(true);
    expect(validateValue(def("maxLevel"), 0, { maxLevel: 20 }).ok).toBe(true);
  });

  test("maxHealth formula below 1 or above the maximum is refused", () => {
    const low = validateValue(def("maxHealth"), "0.5", { maxLevel: 0 });
    expect(low.ok).toBe(false);
    expect(errorOf(low)).toContain("At level 1");
    const high = validateValue(def("maxHealth"), "3000000000", { maxLevel: 0 });
    expect(high.ok).toBe(false);
    expect(errorOf(high)).toContain("At level 1");
    expect(validateValue(def("maxHealth"), String(MAX_XP_VALUE), { maxLevel: 0 }).ok).toBe(true);
  });

  test("respawnMultiplier default validates and out-of-range values are refused", () => {
    const d = def("respawnMultiplier");
    expect(validateValue(d, d.default, { maxLevel: 0 }).ok).toBe(true);
    expect(validateValue(d, 0.01, { maxLevel: 0 }).ok).toBe(false);
    expect(validateValue(d, 21, { maxLevel: 0 }).ok).toBe(false);
    expect(validateValue(d, 20, { maxLevel: 0 }).ok).toBe(true);
  });

  test("raidSize below partySize is refused", () => {
    const ctx = { maxLevel: 0, current: (k: string) => (k === "partySize" ? 10 : k === "raidSize" ? 20 : def(k).default) };
    expect(validateValue(def("raidSize"), 8, ctx).ok).toBe(false);
    expect(validateValue(def("raidSize"), 10, ctx).ok).toBe(true);
    expect(validateValue(def("partySize"), 25, ctx).ok).toBe(false);
  });
});
