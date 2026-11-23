import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { characterDatabaseModule } from "./setup";
import type { SummoningStoneObject } from "../systems/mapobjects";

// The summoning stone editor (systems/stoneeditor.ts): its checks, list edits, permission and serialized writes.

const dungeonRows = [{ id: 1, name: "Crypt", map: "crypt", type: "dungeon", sizes: "5", multipliers: null, entrance_x: 200, entrance_y: 300, enabled: 1, portal_color: null }];
let held = "";
mock.module("../controllers/sqldatabase", () => characterDatabaseModule({ default: async (sql: string) => (/FROM dungeons/.test(sql) ? dungeonRows.map((r) => ({ ...r })) : []) }));
const cache = new Map<string, any>([["mapProperties", [{ name: "town.json", width: 1000, height: 800, tileWidth: 1, tileHeight: 1, summoningStones: [] }]]]);
mock.module("../services/assetCache", () => ({
    default: { onChange: () => () => {}, get: async (k: string) => cache.get(k), set: async (k: string, v: any) => cache.set(k, v), add: async (k: string, v: any) => cache.set(k, v) },
}));
// A spy, not mock.module: a module mock outlives this file and would answer for permissions in the files run after it.
const { default: permissions } = await import("../systems/permissions");
const permissionsSpy = spyOn(permissions, "get").mockImplementation((async () => held) as any);
afterAll(() => permissionsSpy.mockRestore());
const { stoneSave, stoneDelete, stoneMapProblem, setStoneWriter, handleStoneEditorPacket, shiftMapStones } = await import("../systems/stoneeditor");
const { handlePortalEditorPacket } = await import("../systems/portaleditor");
const { DENIED } = await import("../systems/dungeoneditor");
const { NAME_MAX } = await import("../systems/portaleditor");

const ctx = { map: "town", at: { x: 500, y: 400 }, size: { width: 1000, height: 800 } };
const stone = (name: string, over: Partial<SummoningStoneObject> = {}): SummoningStoneObject => ({ name, position: { x: 10, y: 20 }, glowColor: "#66ccff", layer: null, ...over });
const form = (over: any = {}) => ({ original: null, name: "Stone", position: { x: 100, y: 120 }, ...over });

describe("stoneSave", () => {
    test("creates a stone glowing #66ccff by default", () => {
        const out: any = stoneSave([], form(), ctx);
        expect(out.stones).toEqual([{ name: "Stone", position: { x: 100, y: 120 }, glowColor: "#66ccff", layer: null }]);
    });
    test("place at my position puts the foot under the player", () => {
        const out: any = stoneSave([], form({ atMe: true }), ctx);
        expect(out.stones[0].position).toEqual({ x: 500, y: 400 });
    });
    test("an edit keeps its layer and list place; a rename too", () => {
        const list = [stone("A"), stone("B", { layer: "Summoning Stones" })];
        const out: any = stoneSave(list, form({ original: "B", name: "C", glowColor: "#FF0000", position: { x: 1, y: 2 } }), ctx);
        expect(out.stones.map((s: any) => s.name)).toEqual(["A", "C"]);
        expect(out.stones[1]).toEqual({ name: "C", position: { x: 1, y: 2 }, glowColor: "#ff0000", layer: "Summoning Stones" });
    });
    test("refuses bad fields by name", () => {
        const fields = (data: any, list: SummoningStoneObject[] = []) => ((stoneSave(list, data, ctx) as any).fields ?? {});
        expect(fields(form({ name: " " })).name).toBeDefined();
        expect(fields(form({ name: "x".repeat(NAME_MAX + 1) })).name).toBeDefined();
        expect(fields(form({ name: "a" }), [stone("A")]).name).toBeDefined();
        expect(fields(form({ glowColor: "#12345" })).glowColor).toBeDefined();
        expect(fields(form({ position: { x: 1001, y: 5 } }))["position.x"]).toBeDefined();
        expect(fields(form({ position: { x: 5, y: -1 } }))["position.y"]).toBeDefined();
        expect(fields(form({ position: { x: "a", y: 5 } }))["position.x"]).toBeDefined();
    });
});

describe("stoneDelete", () => {
    test("removes by name; a missing one is refused", () => {
        expect(stoneDelete([stone("A"), stone("B")], "A")).toEqual({ stones: [stone("B")] });
        expect("errors" in stoneDelete([stone("A")], "Z")).toBe(true);
    });
});

describe("maps", () => {
    test("dungeon maps are refused", async () => {
        const text = "Summoning stones can only be placed on maps outside dungeons.";
        expect(await stoneMapProblem("crypt")).toBe(text);
        expect(await stoneMapProblem("crypt~7")).toBe(text);
        expect(await stoneMapProblem("town")).toBeNull();
    });
});

describe("permission", () => {
    test("tools.dungeon_editor opens the stone, portal and dungeon editors; tools.portal_editor alone opens nothing", async () => {
        const builder = { username: "b", location: { map: "town.json", position: { x: 1, y: 2 } } };
        held = "tools.portal_editor";
        const s: any = await handleStoneEditorPacket(builder, "SUMMON_STONE_EDITOR_LIST", {});
        const p: any = await handlePortalEditorPacket(builder, "PORTAL_EDITOR_LIST", {});
        expect(s.errors).toEqual([DENIED]);
        expect(p.errors).toEqual([DENIED]);
        expect(DENIED).toBe("You don't have permission to use the dungeon tool.");
        held = "tools.dungeon_editor";
        expect(((await handleStoneEditorPacket(builder, "SUMMON_STONE_EDITOR_LIST", {})) as any).kind).toBe("data");
        expect(((await handlePortalEditorPacket(builder, "PORTAL_EDITOR_LIST", {})) as any).kind).toBe("data");
    });
});

describe("writing", () => {
    test("a save writes through the writer once, serialized", async () => {
        held = "tools.dungeon_editor";
        const log: string[] = [];
        setStoneWriter(async (map, stones) => {
            log.push(`start ${stones.map((x) => x.name)}`);
            await new Promise((r) => setTimeout(r, 20));
            cache.set("mapProperties", [{ name: `${map}.json`, width: 1000, height: 800, tileWidth: 1, tileHeight: 1, summoningStones: stones }]);
            log.push(`end ${stones.map((x) => x.name)}`);
        });
        const admin = { username: "b", location: { map: "town.json", position: { x: 1, y: 2 } } };
        const [a, b]: any[] = await Promise.all([
            handleStoneEditorPacket(admin, "SUMMON_STONE_EDITOR_SAVE", form({ name: "One" })),
            handleStoneEditorPacket(admin, "SUMMON_STONE_EDITOR_SAVE", form({ name: "Two", position: { x: 5, y: 6 } })),
        ]);
        expect(a.ok).toBe(true);
        expect(b.ok).toBe(true);
        expect(log).toEqual(["start One", "end One", "start One,Two", "end One,Two"]);
        expect(b.data.stones.map((s: any) => s.name)).toEqual(["One", "Two"]);
    });
});

describe("map growth", () => {
    test("shiftMapStones moves the map's stones by the shift", async () => {
        const seen: any[] = [];
        setStoneWriter(async (map, stones) => { seen.push({ map, stones }); });
        cache.set("mapProperties", [{ name: "town.json", width: 1000, height: 800, tileWidth: 1, tileHeight: 1, summoningStones: [stone("A", { position: { x: 5, y: 6 } })] }]);
        await shiftMapStones("town.json", 32, 64, "b");
        expect(seen).toEqual([{ map: "town", stones: [stone("A", { position: { x: 37, y: 70 } })] }]);
    });
});
