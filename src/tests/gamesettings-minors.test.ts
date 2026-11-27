import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { characterDatabaseModule } from "./setup";

mock.module("../controllers/sqldatabase", () => characterDatabaseModule({ default: async () => [] }));

const store = await import("../systems/gamesettings/store");
const { compileFormula } = await import("../systems/gamesettings/formula");
const { defOf, validateValue, MAX_XP_VALUE } = await import("../systems/gamesettings/registry");
const editor: any = await import("../systems/gamesettingseditor");
const { default: assetCache } = await import("../services/assetCache");
const { default: log } = await import("../modules/logger");
const { joinOutcome, canInvite, afterLeaving } = await import("../systems/partyrules");
const { settledPick, nextCycleIn, weatherCycleMs } = await import("../systems/weathercycle");

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
const def = (key: string) => defOf(key)!;
const packet = (type: string, data: any) => editor.handleEditorPacket(staff, type, data) as Promise<any>;
const save = (key: string, value: unknown) => packet("GAME_SETTINGS_EDITOR_SAVE", { key, value });
const reset = (key: string) => packet("GAME_SETTINGS_EDITOR_RESET", { key });
const defaults = (k: string) => defOf(k)!.default;
const publishes = (spy: ReturnType<typeof spyOn>) => spy.mock.calls.filter((c: any[]) => c[0] === "game_settings").length;

beforeEach(async () => {
  db.clear();
  removed = 0;
  await store.loadGameSettings(io);
});

afterAll(async () => {
  db.clear();
  await store.loadGameSettings(io);
});

describe("E1: function calls evaluate their arguments without a new array", () => {
  test("every function gives the same result as Math", () => {
    const at = (text: string, level: number) => { const r = compileFormula(text); if (!r.ok) throw new Error(r.error); return r.fn(level); };
    for (const level of [1, 2, 7, 50]) {
      expect(at("min(level)", level)).toBe(Math.min(level));
      expect(at("min(level, 3)", level)).toBe(Math.min(level, 3));
      expect(at("min(level, 3, 10 - level)", level)).toBe(Math.min(level, 3, 10 - level));
      expect(at("max(level)", level)).toBe(Math.max(level));
      expect(at("max(level, 3)", level)).toBe(Math.max(level, 3));
      expect(at("max(level, 3, 10 - level, 4)", level)).toBe(Math.max(level, 3, 10 - level, 4));
      expect(at("pow(level, 1.5)", level)).toBe(Math.pow(level, 1.5));
      expect(at("floor(level / 3)", level)).toBe(Math.floor(level / 3));
      expect(at("ceil(level / 3)", level)).toBe(Math.ceil(level / 3));
      expect(at("round(level / 3)", level)).toBe(Math.round(level / 3));
      expect(at("abs(5 - level)", level)).toBe(Math.abs(5 - level));
      expect(at("sqrt(level)", level)).toBe(Math.sqrt(level));
      expect(at("log(level)", level)).toBe(Math.log(level));
      expect(at("exp(level / 10)", level)).toBe(Math.exp(level / 10));
    }
    expect(Number.isNaN(at("min(level, 0 / 0)", 1))).toBe(true);
    expect(Object.is(at("min(0, -0)", 1), -0)).toBe(true);
  });

  test("the call path builds no argument array per evaluation", async () => {
    const source = await Bun.file(new URL("../systems/gamesettings/formula.ts", import.meta.url)).text();
    expect(source).not.toContain("args.map(");
  });
});

describe("E2: numbers are plain decimals only", () => {
  test("hex, exponent, Infinity and blank are refused", () => {
    for (const raw of ["0x10", "1e3", "Infinity", " ", "", "1_000", "12abc"]) {
      expect(validateValue(def("mailRange"), raw, { maxLevel: 0 }).ok).toBe(false);
    }
  });
  test("plain decimals with a sign and a fraction are taken", () => {
    expect(validateValue(def("mailRange"), "16", { maxLevel: 0 })).toEqual({ ok: true, value: 16 });
    expect(validateValue(def("mountSpeedMultiplier"), "+1.25", { maxLevel: 0 })).toEqual({ ok: true, value: 1.25 });
    expect(validateValue(def("mailRange"), " 20 ", { maxLevel: 0 })).toEqual({ ok: true, value: 20 });
    expect(validateValue(def("mailRange"), 16, { maxLevel: 0 })).toEqual({ ok: true, value: 16 });
    expect(validateValue(def("mailRange"), "-3", { maxLevel: 0 }).ok).toBe(false); // a number, under the minimum
  });
});

describe("E3: a level cap under an XP curve invalid at level 1", () => {
  test("says the XP formula is invalid at level 1", () => {
    const r = validateValue(def("maxLevel"), 5, { maxLevel: 0, current: (k) => (k === "xpToNextLevel" ? "0" : defaults(k)) });
    expect(r.ok).toBe(false);
    const error = (r as any).error as string;
    expect(error).toContain("The XP formula is invalid at level 1");
    expect(error).not.toContain("at most 0");
  });
});

describe("E4: a save is published even when the reload after it fails", () => {
  test("the publish happens and the error still reaches the caller", async () => {
    let broken = false;
    await store.loadGameSettings({ ...io, write: async (k, v, by) => { await io.write(k, v, by); broken = true; }, read: async () => { if (broken) throw new Error("read failed"); return io.read(); } });
    const spy = spyOn(assetCache, "set");
    try {
      await expect(store.saveSetting("walkSpeed", 200, "t")).rejects.toThrow(/read failed/);
      expect(publishes(spy)).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("E5: loading the same settings again publishes nothing", () => {
  test("a second load with the same rows does not publish", async () => {
    db.set("mailRange", row("mailRange", "117"));
    const spy = spyOn(assetCache, "set");
    try {
      await store.loadGameSettings(io);
      const first = publishes(spy);
      await store.loadGameSettings(io);
      expect(first).toBe(1);
      expect(publishes(spy)).toBe(1);
      db.set("mailRange", row("mailRange", "118"));
      await store.loadGameSettings(io);
      expect(publishes(spy)).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("E8: lowering party and raid sizes", () => {
  test("existing groups are kept; only new joins past the limit are blocked", async () => {
    await store.saveSetting("partySize", 3, "t");
    await store.saveSetting("raidSize", 4, "t");
    // A party of 5 formed before: nothing in the rules breaks it up; a member leaving leaves the rest together.
    expect(afterLeaving(["a", "b", "c", "d", "e"], "a", "e")).toEqual({ kind: "stay", leader: "a", members: ["a", "b", "c", "d"] });
    expect(joinOutcome(5, false)).toBe("full");
    expect(joinOutcome(5, true)).toBe("full");
    expect(canInvite(5)).toBe(false);
    expect(joinOutcome(3, false)).toBe("convert");
    expect(joinOutcome(3, true)).toBe("join");
    expect(joinOutcome(2, false)).toBe("join");
  });
});

describe("E9: the XP curve must fit up to a new cap, for every caller", () => {
  test("saveSetting refuses a cap past where the XP curve fits", async () => {
    await store.saveSetting("xpToNextLevel", "level ^ 3", "t");
    await expect(store.saveSetting("maxLevel", 1500, "t")).rejects.toThrow(/XP curve does not fit up to level 1500/);
    expect(store.setting("maxLevel")).toBe(0);
    await store.saveSetting("maxLevel", 1290, "t");
    expect(store.setting("maxLevel")).toBe(1290);
  });
});

describe("E10, E11, E12: the editor's level cap, reset and store errors", () => {
  test("raising the cap past the XP curve is refused in the editor", async () => {
    await store.saveSetting("xpToNextLevel", "level ^ 3", "t");
    const answer = await save("maxLevel", 1500);
    expect(answer.ok).toBe(false);
    expect(answer.fields.maxLevel).toContain("XP curve does not fit up to level 1500");
    expect(db.has("maxLevel")).toBe(false);
  });

  test("lowering the cap is checked again and taken", async () => {
    expect((await save("maxLevel", 50)).ok).toBe(true);
    expect((await save("maxHealth", "100 + 2 ^ (level / 3)")).ok).toBe(true);
    const lower = await save("maxLevel", 40);
    expect(lower.ok).toBe(true);
    expect(store.setting("maxLevel")).toBe(40);
    // Back up past where the health formula fits is refused again.
    expect((await save("maxLevel", 120)).ok).toBe(false);
  });

  test("a reset the default would not hold under is refused, saying so", async () => {
    await store.saveSetting("maxLevel", 30, "t");
    await store.saveSetting("xpToNextLevel", "2 ^ level", "t");
    const answer = await reset("maxLevel");
    expect(answer.ok).toBe(false);
    expect(answer.fields.maxLevel.startsWith("The default would not hold: ")).toBe(true);
    expect(store.setting("maxLevel")).toBe(30);
    expect(db.has("maxLevel")).toBe(true);
  });

  test("a store that throws is an error answer", async () => {
    const quiet = spyOn(log, "error").mockImplementation(() => {});
    try {
      await store.loadGameSettings({ ...io, write: async () => { throw new Error("disk on fire"); } });
      const answer = await save("walkSpeed", 200);
      expect(answer.ok).toBe(false);
      expect(answer.fields.walkSpeed).toContain("disk on fire");
      expect(answer.changed).toBeUndefined();
      db.set("walkSpeed", row("walkSpeed", "200"));
      await store.loadGameSettings({ ...io, remove: async () => { throw new Error("no delete"); } });
      const undone = await reset("walkSpeed");
      expect(undone.ok).toBe(false);
      expect(undone.fields.walkSpeed).toContain("no delete");
    } finally {
      quiet.mockRestore();
    }
  });

  test("resetting a setting with no saved value changes nothing", async () => {
    const spy = spyOn(assetCache, "set");
    try {
      const answer = await reset("walkSpeed");
      expect(answer.ok).toBe(true);
      expect(answer.changed).toBeFalsy();
      expect(removed).toBe(0);
      expect(publishes(spy)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("E13: the preview floors only the formulas the game floors", () => {
  test("XP, health and stamina are floored; another formula shows its real value", () => {
    const ratio = { key: "someRatio", section: "Test", label: "Ratio", help: "", kind: "formula" as const, default: "level / 2" };
    expect(editor.previewRows(ratio, "level / 2", 0)[0]).toEqual([1, 0.5]);
    expect(editor.previewRows(def("xpToNextLevel"), "level / 2", 0)[0]).toEqual([1, 0]);
    expect(editor.previewRows(def("maxHealth"), "level * 1.5", 0)[0]).toEqual([1, 1]);
    expect(editor.previewRows(def("maxStamina"), "level * 1.5", 0)[0]).toEqual([1, 1]);
  });
});

describe("M2: a weather cycle change applies from the next weather change", () => {
  test("the current weather holds until its stretch ends, then the new length is used", async () => {
    const table = ["rain", "snow", "fog", "clear", "thunderstorm", "drizzle", "hail"].map((name) => ({ name }));
    const worlds = Array.from({ length: 24 }, (_, n) => `m2world${n}`);
    const now = Date.now();
    const oldCycle = weatherCycleMs();
    const end = now + nextCycleIn(now);
    const before = worlds.map((w) => settledPick(table, w, now)!.name);
    db.set("weatherCycleMinutes", row("weatherCycleMinutes", "7"));
    await store.loadGameSettings(io);
    expect(weatherCycleMs()).toBe(7 * 60_000);
    expect(worlds.map((w) => settledPick(table, w, now)!.name)).toEqual(before);
    expect(worlds.map((w) => settledPick(table, w, end - 1)!.name)).toEqual(before);
    expect(nextCycleIn(now)).toBe(end - now);
    // From the end of the stretch, the new length's stretches.
    const later = end + 3 * 7 * 60_000;
    const plain = (w: string) => table.slice().sort((a, b) => (a.name < b.name ? -1 : 1))[Number(BigInt(Bun.hash(`${w}:${Math.floor(later / (7 * 60_000))}`)) % BigInt(table.length))].name;
    expect(worlds.map((w) => settledPick(table, w, later)!.name)).toEqual(worlds.map(plain));
    expect(nextCycleIn(later)).toBe(7 * 60_000 - (later % (7 * 60_000)));
    expect(oldCycle).toBe(30 * 60_000);
  });
});

describe("M3: health and stamina are checked to the level a character can reach", () => {
  test("with no cap and a flat XP curve, a health formula that outgrows the column past level 1000 is refused", async () => {
    await store.saveSetting("xpToNextLevel", "100", "t");
    await expect(store.saveSetting("maxHealth", "100 + level * 30000", "t")).rejects.toThrow(/level/);
    expect(store.formula("maxHealth")(10)).toBe(Math.floor(100 + 10 ** 1.5 * 5));
  });

  test("a flatter XP curve is refused when it lets levelling past where the health formula fits", async () => {
    await store.saveSetting("maxHealth", "100 + level * 30000", "t"); // fits to level 1000 under today's curve
    await expect(store.saveSetting("xpToNextLevel", "100", "t")).rejects.toThrow(/Max health/);
  });

  test("health and stamina never go past the stats column at run time", () => {
    expect(store.formula("maxHealth")(10_000_000)).toBe(MAX_XP_VALUE);
    expect(store.formula("maxStamina")(10_000_000)).toBe(MAX_XP_VALUE);
  });
});

describe("M4: a reload from another node finishes before the editor answers", () => {
  test("LIST waits for the reload in flight", async () => {
    const heard: Array<(elsewhere: boolean) => void> = [];
    let rows: R[] = [];
    let release: () => void = () => {};
    let gate: Promise<void> | null = null;
    const cache = { onChange: (key: string, listener: (elsewhere: boolean) => void) => { if (key === "game_settings") heard.push(listener); } };
    await store.loadGameSettings({ ...io, cache, read: async () => { if (gate) await gate; return rows; } });
    rows = [row("walkSpeed", "222")];
    gate = new Promise<void>((r) => { release = r; });
    heard[0]!(true);
    const listed = packet("GAME_SETTINGS_EDITOR_LIST", null);
    setTimeout(() => { gate = null; release(); }, 30);
    const answer = await listed;
    expect(answer.data.settings.find((s: any) => s.key === "walkSpeed").value).toBe(222);
  });
});

describe("M5: a save or reset the server did not keep is an error", () => {
  test("a reload that drops the row answers with a field error", async () => {
    await store.loadGameSettings({ ...io, read: async () => [...db.values()].filter((r) => r.setting_key !== "walkSpeed") });
    const answer = await save("walkSpeed", 220);
    expect(answer.ok).toBe(false);
    expect(answer.fields.walkSpeed).toContain("did not keep");
  });

  test("the reason is given when the reload refused the row", async () => {
    await store.saveSetting("raidSize", 50, "t");
    const quiet = spyOn(log, "warn").mockImplementation(() => {});
    try {
      let hide = false;
      await store.loadGameSettings({ ...io, read: async () => [...db.values()].filter((r) => !(hide && r.setting_key === "raidSize")) });
      expect(store.setting("raidSize")).toBe(50);
      hide = true;
      const answer = await save("partySize", 30);
      expect(answer.ok).toBe(false);
      expect(answer.fields.partySize).toContain("did not keep");
      expect(answer.fields.partySize).toContain("raid size");
    } finally {
      quiet.mockRestore();
    }
  });

  test("a kept save is still ok", async () => {
    const answer = await save("walkSpeed", 220);
    expect(answer.ok).toBe(true);
  });
});

describe("M6: a bad saved row is warned of once", () => {
  test("the same unknown key and bad value warn once across reloads", async () => {
    const spy = spyOn(log, "warn").mockImplementation(() => {});
    try {
      db.set("m6_unknown", row("m6_unknown", "1"));
      db.set("mailDays", row("mailDays", "-77"));
      await store.loadGameSettings(io);
      await store.loadGameSettings(io);
      await store.saveSetting("walkSpeed", 201, "t");
      const about = (text: string) => spy.mock.calls.filter((c: any[]) => String(c[0]).includes(text)).length;
      expect(about("m6_unknown")).toBe(1);
      expect(about("mailDays")).toBe(1);
      db.set("mailDays", row("mailDays", "-78"));
      await store.loadGameSettings(io);
      expect(about("mailDays")).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});
