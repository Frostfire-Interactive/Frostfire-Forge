import { describe, expect, mock, test } from "bun:test";
import { characterDatabaseModule } from "./setup";
import type { DungeonPortalObject } from "../systems/dungeons/types";

// The portal editor (systems/portaleditor.ts): its checks and list edits, and the links the dungeon editor makes.

// Dungeon 1 leads into the template map "crypt"; players arrive in a copy at (200, 300).
const dungeonRows = [{ id: 1, name: "Crypt", map: "crypt", type: "dungeon", sizes: "5", multipliers: null, entrance_x: 200, entrance_y: 300, enabled: 1, portal_color: null }];
mock.module("../controllers/sqldatabase", () => characterDatabaseModule({ default: async (sql: string) => (/FROM dungeons/.test(sql) ? dungeonRows.map((r) => ({ ...r })) : []) }));
const cache = new Map<string, any>();
mock.module("../services/assetCache", () => ({
    default: { onChange: () => () => {}, get: async (k: string) => cache.get(k), set: async (k: string, v: any) => cache.set(k, v), add: async (k: string, v: any) => cache.set(k, v) },
}));
const { NAME_MAX, dungeonPortalRefs, handlePortalEditorPacket, linkablePortals, portalDelete, portalSave, relinkPlan, setPortalWriter, shiftMapPortals } = await import("../systems/portaleditor");
const { ARRIVAL_GAP, arrivalSpot, dungeonReturnPlan, returnName, returnPlacement, returnPlan, shiftPlan } = await import("../systems/portalpairs");

const maps = [{ name: "town", widthPx: 1000, heightPx: 800 }, { name: "fields", widthPx: 2000, heightPx: 2000 }];
const ctx = { map: "town", maps, at: { x: 500, y: 400 } };
const base = (name: string, over: Partial<DungeonPortalObject> = {}): DungeonPortalObject => ({
    name, kind: "dungeon", dungeonId: null, mirror: true, target: null, position: { x: 10, y: 20 }, size: { width: 32, height: 32 }, layer: null, ...over,
});
const form = (over: any = {}) => ({ original: null, name: "Gate", mirror: true, destination: "none", position: { x: 100, y: 120 }, size: { width: 32, height: 48 }, ...over });

describe("permission", () => {
    test("the portal editor asks the dungeon editor's permission: admins in, guests and the public out", async () => {
        const { DENIED } = await import("../systems/dungeoneditor");
        const denied = async (who: any) => ((await handlePortalEditorPacket(who, "PORTAL_EDITOR_LIST", {})) as any);
        expect((await denied({ username: "a", isAdmin: true, location: { map: "town.json" } })).kind).toBe("data");
        expect((await denied({ username: "g", isGuest: true, isAdmin: true })).errors).toEqual([DENIED]);
        expect((await denied(null)).errors).toEqual([DENIED]);
    });
});

describe("portalSave", () => {
    test("creates a dungeon portal linked to nothing, with Mirror other side", () => {
        const out = portalSave([], form(), ctx);
        expect("portals" in out && out.portals).toEqual([base("Gate", { position: { x: 100, y: 120 }, size: { width: 32, height: 48 } })]);
    });
    test("creates a teleport with its map and place", () => {
        const out: any = portalSave([], form({ destination: "teleport", target: { map: "fields", x: 30, y: 40 }, mirror: false }), ctx);
        expect(out.portals[0]).toMatchObject({ kind: "teleport", dungeonId: null, mirror: false, target: { map: "fields", x: 30, y: 40 } });
    });
    test("place at my position centres the portal on the player", () => {
        const out: any = portalSave([], form({ atMe: true }), ctx);
        expect(out.portals[0].position).toEqual({ x: 484, y: 376 });
    });
    test("an edit keeps the dungeon link and the layer; renaming keeps its place in the list", () => {
        const list = [base("A"), base("B", { dungeonId: 3, layer: "Dungeon Portals" })];
        const out: any = portalSave(list, form({ original: "B", name: "C", mirror: false, position: { x: 1, y: 2 } }), ctx);
        expect(out.portals.map((p: any) => p.name)).toEqual(["A", "C"]);
        expect(out.portals[1]).toMatchObject({ dungeonId: 3, mirror: false, layer: "Dungeon Portals", position: { x: 1, y: 2 } });
    });
    test("turning a linked portal into a teleport drops its dungeon link, and says so", () => {
        const out: any = portalSave([base("B", { dungeonId: 3 })], form({ original: "B", name: "B", destination: "teleport", target: { map: "town", x: 1, y: 1 } }), ctx);
        expect(out.portals[0]).toMatchObject({ kind: "teleport", dungeonId: null });
        expect(out.notes.join(" ")).toContain("no longer leads into its dungeon");
    });
    test("refuses bad fields by name", () => {
        const fields = (data: any, list: DungeonPortalObject[] = []) => ((portalSave(list, data, ctx) as any).fields ?? {});
        expect(fields(form({ name: " " })).name).toBeDefined();
        expect(fields(form({ name: "x".repeat(NAME_MAX + 1) })).name).toBeDefined();
        expect(fields(form({ name: "A" }), [base("A")]).name).toBeDefined();
        expect(fields(form({ destination: "teleport", target: { map: "nowhere", x: 1, y: 1 } }))["target.map"]).toBeDefined();
        expect(fields(form({ destination: "teleport", target: { map: "fields", x: 2000, y: 1 } }))["target.x"]).toBeDefined();
        expect(fields(form({ destination: "door" })).destination).toBeDefined();
        expect(fields(form({ position: { x: 990, y: 0 } }))["position.x"]).toBeDefined();
        expect(fields(form({ size: { width: 2, height: 32 } }))["size.width"]).toBeDefined();
        expect(fields(form({ mirror: "yes" })).mirror).toBeDefined();
        expect((portalSave([], form({ original: "Gone" }), ctx) as any).errors[0]).toContain("no longer");
    });
});

describe("portalDelete", () => {
    test("removes the portal by name; a missing one is refused", () => {
        expect(portalDelete([base("A"), base("B")], "A")).toEqual({ portals: [base("B")] });
        expect("error" in portalDelete([base("A")], "Z")).toBe(true);
    });
});

describe("linking from the dungeon editor", () => {
    const all = [
        { map: "town", portals: [base("A", { dungeonId: 1 }), base("B"), base("T", { kind: "teleport", target: { map: "town", x: 1, y: 1 } })] },
        { map: "fields", portals: [base("C", { dungeonId: 2 })] },
    ];
    test("a dungeon can pick a free dungeon portal or its own, not a teleport or another dungeon's", () => {
        expect(linkablePortals(all, 1).map((p) => `${p.map}/${p.name}`)).toEqual(["town/A", "town/B"]);
        expect(linkablePortals(all, null).map((p) => `${p.map}/${p.name}`)).toEqual(["town/B"]);
    });
    test("linking one portal unlinks the dungeon's others; only the maps that change are saved", () => {
        const plan = relinkPlan(all, 1, { map: "town", name: "B" });
        expect(plan.map((c) => c.map)).toEqual(["town"]);
        expect(plan[0]!.portals.map((p) => [p.name, p.dungeonId])).toEqual([["A", null], ["B", 1], ["T", null]]);
        expect(relinkPlan(all, 1, { map: "town", name: "A" })).toEqual([]);
    });
    test("no pick unlinks every portal of the dungeon", () => {
        const plan = relinkPlan(all, 2, null);
        expect(plan).toEqual([{ map: "fields", portals: [base("C")] }]);
    });
});

describe("return portals", () => {
    const pmaps = [{ name: "town", widthPx: 1000, heightPx: 800 }, { name: "fields", widthPx: 2000, heightPx: 2000 }, { name: "caves", widthPx: 1000, heightPx: 1000 }];
    const pctx = { map: "town", maps: pmaps, at: { x: 500, y: 400 } };
    const gate = (over: Partial<DungeonPortalObject> = {}) => base("Gate", {
        kind: "teleport", target: { map: "fields", x: 300, y: 400 }, position: { x: 100, y: 120 }, size: { width: 32, height: 48 }, ...over,
    });
    // Gate's arrival spot: centred, ARRIVAL_GAP (16) below its bottom edge. Its return stands so its own arrival spot is Gate's place.
    const gateReturn = (over: Partial<DungeonPortalObject> = {}) => base("Gate (return)", {
        kind: "teleport", target: { map: "town", x: 116, y: 184 }, position: { x: 284, y: 336 }, size: { width: 32, height: 48 },
        returnOf: { map: "town", name: "Gate" }, ...over,
    });
    const tele = (over: any = {}) => form({ destination: "teleport", target: { map: "fields", x: 300, y: 400 }, ...over });
    const plan = (all: any[], original: string | null, data: any) => {
        const list = all.find((m: any) => m.map === "town")?.portals ?? [];
        const saved: any = portalSave(list, data, pctx);
        if ("errors" in saved) return saved;
        return returnPlan(all, { map: "town", original, portals: saved.portals, source: saved.portal }, pmaps);
    };
    const lists = (out: any) => Object.fromEntries(out.plan.map((m: any) => [m.map, m.portals]));

    test("the arrival spot is centred just in front of (below) the portal, outside its trigger", () => {
        const spot = arrivalSpot("town.json", gate());
        expect(spot).toEqual({ map: "town", x: 116, y: 120 + 48 + ARRIVAL_GAP });
        expect(spot.y).toBeGreaterThanOrEqual(120 + 48);
    });
    test("the return is placed so a player arriving through the source stands just in front of it, not in it", () => {
        const at = returnPlacement({ x: 300, y: 400 }, { width: 32, height: 48 }, pmaps[1]);
        expect(at).toEqual({ position: { x: 284, y: 336 } });
        const ret = gateReturn();
        expect(arrivalSpot("fields", ret)).toEqual({ map: "fields", x: 300, y: 400 });
        expect(400 >= ret.position.y + ret.size.height).toBe(true);
    });
    test("near a side of the map the return is moved along the edge; with no room above the place it is refused", () => {
        expect(returnPlacement({ x: 4, y: 400 }, { width: 32, height: 48 }, pmaps[1])).toEqual({ position: { x: 0, y: 336 } });
        expect(returnPlacement({ x: 1999, y: 400 }, { width: 32, height: 48 }, pmaps[1])).toEqual({ position: { x: 1968, y: 336 } });
        expect("error" in returnPlacement({ x: 300, y: 20 }, { width: 32, height: 48 }, pmaps[1])).toBe(true);
    });
    test("saving a teleport adds its one return on the destination map, linked to it, with its Mirror and size", () => {
        const out: any = plan([{ map: "town", portals: [] }, { map: "fields", portals: [] }], null, tele({ mirror: false }));
        expect(out.plan.map((m: any) => m.map)).toEqual(["town", "fields"]);
        expect(lists(out).fields).toEqual([gateReturn({ mirror: false })]);
        expect(lists(out).town[0]).toMatchObject({ name: "Gate", kind: "teleport", mirror: false });
        expect(lists(out).town[0].returnOf).toBeUndefined();
    });
    test("an old teleport without a return gets one when it is next saved", () => {
        const out: any = plan([{ map: "town", portals: [gate()] }, { map: "fields", portals: [base("Other")] }], "Gate", tele({ original: "Gate" }));
        expect(lists(out).fields).toEqual([base("Other"), gateReturn()]);
    });
    test("moving, renaming, resizing or turning Mirror off updates the return in place of the old one", () => {
        const all = [{ map: "town", portals: [gate()] }, { map: "fields", portals: [gateReturn()] }];
        const out: any = plan(all, "Gate", tele({ original: "Gate", name: "Door", mirror: false, position: { x: 200, y: 100 }, size: { width: 64, height: 32 }, target: { map: "fields", x: 500, y: 600 } }));
        expect(lists(out).fields).toEqual([base("Door (return)", {
            kind: "teleport", mirror: false, target: { map: "town", x: 232, y: 148 }, position: { x: 468, y: 552 }, size: { width: 64, height: 32 },
            returnOf: { map: "town", name: "Door" },
        })]);
    });
    test("a new destination map moves the return there and removes it from the old map", () => {
        const all = [{ map: "town", portals: [gate()] }, { map: "fields", portals: [base("Other"), gateReturn()] }, { map: "caves", portals: [] }];
        const out: any = plan(all, "Gate", tele({ original: "Gate", target: { map: "caves", x: 300, y: 400 } }));
        expect(out.plan.map((m: any) => m.map)).toEqual(["town", "fields", "caves"]);
        expect(lists(out).fields).toEqual([base("Other")]);
        expect(lists(out).caves).toEqual([gateReturn()]);
    });
    test("clearing the destination, or deleting the source, deletes the return", () => {
        const all = [{ map: "town", portals: [gate()] }, { map: "fields", portals: [gateReturn()] }];
        const cleared: any = plan(all, "Gate", form({ original: "Gate" }));
        expect(lists(cleared).fields).toEqual([]);
        expect(lists(cleared).town[0]).toMatchObject({ name: "Gate", kind: "dungeon" });
        const left: any = portalDelete(all[0]!.portals, "Gate");
        const deleted: any = returnPlan(all, { map: "town", original: "Gate", portals: left.portals, source: null }, pmaps);
        expect(lists(deleted)).toEqual({ town: [], fields: [] });
    });
    test("a portal that never had a return writes only its own map", () => {
        const out: any = plan([{ map: "town", portals: [] }, { map: "fields", portals: [] }], null, form());
        expect(out.plan.map((m: any) => m.map)).toEqual(["town"]);
    });
    test("a source and its return on the same map", () => {
        const out: any = plan([{ map: "town", portals: [] }], null, tele({ target: { map: "town", x: 600, y: 500 } }));
        expect(out.plan.map((m: any) => m.map)).toEqual(["town"]);
        const [source, ret] = lists(out).town;
        expect(source.name).toBe("Gate");
        expect(ret).toEqual(gateReturn({ target: { map: "town", x: 116, y: 184 }, position: { x: 584, y: 436 } }));
    });
    test("a same-map return that would cover its source is refused", () => {
        const out: any = plan([{ map: "town", portals: [] }], null, tele({ target: { map: "town", x: 116, y: 200 } }));
        expect(out.fields?.["target.y"] ?? out.fields?.["target.x"]).toBeDefined();
    });
    test("no room for a return above the place, or for players in front of the source, is refused by field", () => {
        expect((plan([{ map: "town", portals: [] }], null, tele({ target: { map: "fields", x: 300, y: 30 } })) as any).fields["target.y"]).toBeDefined();
        expect((plan([{ map: "town", portals: [] }], null, tele({ position: { x: 100, y: 800 - 48 } })) as any).fields["position.y"]).toBeDefined();
    });
    test("the return's name comes from its source and is unique on its map", () => {
        const taken = [base("Gate (return)"), base("gate (return 2)")];
        const out: any = plan([{ map: "town", portals: [] }, { map: "fields", portals: taken }], null, tele());
        expect(lists(out).fields.map((p: any) => p.name)).toEqual(["Gate (return)", "gate (return 2)", "Gate (return 3)"]);
        expect(returnName("Gate", [])).toBe("Gate (return)");
    });
    test("stray returns of the same source are dropped: exactly one is kept", () => {
        const all = [{ map: "town", portals: [gate()] }, { map: "fields", portals: [gateReturn(), gateReturn({ name: "Gate (return 2)" })] }, { map: "caves", portals: [gateReturn()] }];
        const out: any = plan(all, "Gate", tele({ original: "Gate" }));
        expect(lists(out).fields).toEqual([gateReturn()]);
        expect(lists(out).caves).toEqual([]);
    });
    test("a return cannot be edited, moved or deleted on its own; the message names its source", () => {
        const list = [gateReturn()];
        const saved: any = portalSave(list, tele({ original: "Gate (return)", name: "Gate (return)" }), { ...pctx, map: "fields" });
        expect(saved.errors[0]).toContain("Gate");
        expect(saved.errors[0]).toContain("town");
        const moved: any = portalSave(list, form({ original: "Gate (return)", name: "Gate (return)", atMe: true }), { ...pctx, map: "fields" });
        expect(moved.errors[0]).toContain("return portal");
        const deleted: any = portalDelete(list, "Gate (return)");
        expect(deleted.error).toContain("Gate");
        expect(deleted.error).toContain("town");
    });
    test("a return is never offered as a dungeon entrance", () => {
        const all = [{ map: "fields", portals: [gateReturn(), base("Free")] }];
        expect(linkablePortals(all, null).map((p) => p.name)).toEqual(["Free"]);
        expect(linkablePortals(all, 1).map((p) => p.name)).toEqual(["Free"]);
    });
    test("one save writes the source and its return in one change, both maps through the writer", async () => {
        cache.set("mapProperties", [
            { name: "town.json", width: 100, height: 100, tileWidth: 10, tileHeight: 8, dungeonPortals: [] },
            { name: "fields.json", width: 100, height: 100, tileWidth: 20, tileHeight: 20, dungeonPortals: [] },
        ]);
        const written: string[] = [];
        setPortalWriter(async (map, portals) => {
            written.push(`${map}:${portals.map((p) => p.name).join(",")}`);
            const props = (cache.get("mapProperties") as any[]).find((m) => m.name === `${map}.json`);
            props.dungeonPortals = portals;
        });
        const admin = { username: "a", isAdmin: true, location: { map: "town.json", position: { x: 500, y: 400 } } };
        const reply: any = await handlePortalEditorPacket(admin, "PORTAL_EDITOR_SAVE", tele());
        expect(reply.ok).toBe(true);
        expect(written).toEqual(["town:Gate", "fields:Gate (return)"]);
        expect(reply.notes.join(" ")).toContain("Gate (return)");
        const refused: any = await handlePortalEditorPacket({ ...admin, location: { map: "fields", position: { x: 1, y: 1 } } }, "PORTAL_EDITOR_DELETE", { name: "Gate (return)" });
        expect(refused.ok).toBe(false);
        expect(refused.data.portals[0].returnOf).toEqual({ map: "town", name: "Gate" });
        const removed: any = await handlePortalEditorPacket(admin, "PORTAL_EDITOR_DELETE", { name: "Gate" });
        expect(removed.ok).toBe(true);
        expect(written.slice(2)).toEqual(["town:", "fields:"]);
    });
});

describe("dungeon returns", () => {
    // DungeonPortal_1 on the overworld leads into dungeon 1, whose template map is "crypt" (entrance 200, 300).
    const crypt = [{ id: 1, map: "crypt", entranceX: 200, entranceY: 300 }];
    const dmaps = [{ name: "overworld", widthPx: 3200, heightPx: 3200 }, { name: "town", widthPx: 1000, heightPx: 800 }, { name: "crypt", widthPx: 640, heightPx: 640 }, { name: "vault", widthPx: 640, heightPx: 640 }];
    const dp1 = (over: Partial<DungeonPortalObject> = {}) => base("DungeonPortal_1", { dungeonId: 1, position: { x: 400, y: 300 }, size: { width: 32, height: 32 }, ...over });
    const exitOf = (source: string, over: Partial<DungeonPortalObject> = {}, on = "overworld"): DungeonPortalObject => ({
        name: `${source} (return)`, kind: "dungeon", dungeonId: null, mirror: true, target: null,
        position: { x: 184, y: 252 }, size: { width: 32, height: 32 }, layer: null, returnOf: { map: on, name: source }, ...over,
    });
    const listOf = (plan: any[], map: string) => plan.find((m) => m.map === map)?.portals;
    const apply = (all: any[], plan: any[]) => all.map((m) => ({ map: m.map, portals: listOf(plan, m.map) ?? m.portals }));

    test("a portal linked to a dungeon keeps an exit on its template map, standing just behind the entrance", () => {
        const all = [{ map: "overworld", portals: [dp1()] }, { map: "crypt", portals: [] }];
        const out: any = dungeonReturnPlan(all, crypt, [1], dmaps, "destination");
        expect(out.plan).toEqual([{ map: "crypt", portals: [exitOf("DungeonPortal_1")] }]);
        const exit = out.plan[0].portals[0];
        // players arrive at the entrance: in front of the exit, outside its trigger
        expect(arrivalSpot("crypt", exit)).toEqual({ map: "crypt", x: 200, y: 300 });
        expect(300 >= exit.position.y + exit.size.height).toBe(true);
        expect(out.notes.join(" ")).toContain("DungeonPortal_1 (return)");
        // planned again from what was written: nothing changes
        expect((dungeonReturnPlan(apply(all, out.plan), crypt, [1], dmaps, "destination") as any).plan).toEqual([]);
    });
    test("one exit per dungeon: the portal that has it keeps it, else the first by map name; a hand-made exit stays", () => {
        const handMade = base("Exit", { position: { x: 0, y: 0 } });
        const all = [{ map: "town", portals: [dp1({ name: "B" })] }, { map: "overworld", portals: [dp1({ name: "A" })] }, { map: "crypt", portals: [handMade] }];
        const fresh: any = dungeonReturnPlan(all, crypt, [1], dmaps, "destination");
        expect(listOf(fresh.plan, "crypt")).toEqual([handMade, exitOf("A")]);
        const owned = all.map((m) => m.map === "crypt" ? { map: "crypt", portals: [handMade, exitOf("B", {}, "town")] } : m);
        expect((dungeonReturnPlan(owned, crypt, [1], dmaps, "destination") as any).plan).toEqual([]);
        // the owner unlinked: the other portal takes the exit
        const unlinked = owned.map((m) => m.map === "town" ? { map: "town", portals: [dp1({ name: "B", dungeonId: null })] } : m);
        expect(listOf((dungeonReturnPlan(unlinked, crypt, [1], dmaps, "destination") as any).plan, "crypt")).toEqual([handMade, exitOf("A")]);
    });
    test("the exit follows its portal and its dungeon: rename, size, Mirror, unlink, a new map or entrance, a deleted dungeon", () => {
        const placed = [{ map: "overworld", portals: [dp1()] }, { map: "crypt", portals: [exitOf("DungeonPortal_1", { layer: "Objects" })] }, { map: "vault", portals: [] }];
        const withSource = (p: DungeonPortalObject) => placed.map((m) => m.map === "overworld" ? { map: "overworld", portals: [p] } : m);
        const crypted = (all: any[], defs = crypt) => listOf((dungeonReturnPlan(all, defs, [1], dmaps, "destination") as any).plan, "crypt");
        expect(crypted(withSource(dp1({ name: "Gate" })))).toEqual([exitOf("Gate", { layer: "Objects" })]);
        expect(crypted(withSource(dp1({ size: { width: 64, height: 32 } })))).toEqual([exitOf("DungeonPortal_1", { layer: "Objects", position: { x: 168, y: 252 }, size: { width: 64, height: 32 } })]);
        expect(crypted(withSource(dp1({ mirror: false })))).toEqual([exitOf("DungeonPortal_1", { layer: "Objects", mirror: false })]);
        expect(crypted(withSource(dp1({ dungeonId: null })))).toEqual([]);
        expect(crypted(withSource({ ...dp1(), kind: "teleport", dungeonId: null, target: { map: "town", x: 100, y: 200 } }))).toEqual([]);
        expect(crypted(withSource(dp1()), [])).toEqual([]);
        expect(crypted(placed, [{ ...crypt[0]!, entranceX: 300 }])).toEqual([exitOf("DungeonPortal_1", { layer: "Objects", position: { x: 284, y: 252 } })]);
        const moved: any = dungeonReturnPlan(placed, [{ ...crypt[0]!, map: "vault" }], [1], dmaps, "destination");
        expect(listOf(moved.plan, "crypt")).toEqual([]);
        expect(listOf(moved.plan, "vault")).toEqual([exitOf("DungeonPortal_1")]);
    });
    test("no room above the entrance is refused on the field given", () => {
        const all = [{ map: "overworld", portals: [dp1()] }, { map: "crypt", portals: [] }];
        const out: any = dungeonReturnPlan(all, [{ ...crypt[0]!, entranceY: 40 }], [1], dmaps, "entranceY");
        expect(Object.keys(out.fields)).toEqual(["entranceY"]);
        expect(out.fields.entranceY).toContain(`${ARRIVAL_GAP + 32} pixels`);
        // a dungeon that no portal leads into needs no room
        expect((dungeonReturnPlan([{ map: "crypt", portals: [] }], [{ ...crypt[0]!, entranceY: 40 }], [1], dmaps, "entranceY") as any).plan).toEqual([]);
    });
    test("a dungeon's exit is never offered as an entrance portal", () => {
        const all = [{ map: "crypt", portals: [exitOf("DungeonPortal_1"), base("Free")] }];
        expect(linkablePortals(all, null).map((p) => p.name)).toEqual(["Free"]);
        expect(linkablePortals(all, 1).map((p) => p.name)).toEqual(["Free"]);
        expect(dungeonPortalRefs(all).map((p) => p.name)).toEqual(["Free"]);
    });
    test("re-saving the overworld's DungeonPortal_1 (dungeon 1) in the portal editor places its exit on dungeon 1's map; deleting it removes the exit", async () => {
        cache.set("mapProperties", [
            { name: "overworld.json", width: 100, height: 100, tileWidth: 32, tileHeight: 32, dungeonPortals: [
                { name: "DungeonPortal_1", kind: "dungeon", dungeonId: 1, mirror: true, target: null, position: { x: 400, y: 300 }, size: { width: 32, height: 32 }, layer: null },
            ] },
            { name: "crypt.json", width: 20, height: 20, tileWidth: 32, tileHeight: 32, dungeonPortals: [] },
        ]);
        const written: string[] = [];
        let wroteExit: any = null;
        setPortalWriter(async (map, portals) => {
            written.push(`${map}:${portals.map((p) => p.name).join(",")}`);
            if (map === "crypt") wroteExit = portals[0] ?? null;
            (cache.get("mapProperties") as any[]).find((m) => m.name === `${map}.json`).dungeonPortals = portals;
        });
        try {
            const admin = { username: "a", isAdmin: true, location: { map: "overworld.json", position: { x: 416, y: 316 } } };
            const reply: any = await handlePortalEditorPacket(admin, "PORTAL_EDITOR_SAVE",
                form({ original: "DungeonPortal_1", name: "DungeonPortal_1", position: { x: 400, y: 300 }, size: { width: 32, height: 32 } }));
            expect(reply.errors).toEqual([]);
            expect(written).toEqual(["overworld:DungeonPortal_1", "crypt:DungeonPortal_1 (return)"]);
            expect(wroteExit).toEqual(exitOf("DungeonPortal_1"));
            expect(reply.notes.join(" ")).toContain("DungeonPortal_1 (return)");
            const removed: any = await handlePortalEditorPacket(admin, "PORTAL_EDITOR_DELETE", { name: "DungeonPortal_1" });
            expect(removed.ok).toBe(true);
            expect(written.slice(2)).toEqual(["overworld:", "crypt:"]);
        } finally {
            setPortalWriter(null);
        }
    });
});

describe("a map that grows left or up in the map editor", () => {
    test("teleports into the map from any map move with it, so pairs stay matched", async () => {
        const gate = base("Gate", { kind: "teleport", target: { map: "fields", x: 300, y: 400 }, position: { x: 100, y: 120 } });
        const into = base("Into", { kind: "teleport", target: { map: "town.json", x: 50, y: 60 } });
        const ret = base("Gate (return)", { kind: "teleport", target: { map: "town", x: 116, y: 168 }, position: { x: 284, y: 352 }, returnOf: { map: "town", name: "Gate" } });
        const elsewhere = base("Elsewhere", { kind: "teleport", target: { map: "caves", x: 5, y: 5 } });
        cache.set("mapProperties", [
            { name: "town.json", dungeonPortals: [gate] },
            { name: "fields.json", dungeonPortals: [into, ret, elsewhere] },
            { name: "caves.json", dungeonPortals: [base("Quiet")] },
        ]);
        const written: any[] = [];
        setPortalWriter(async (map, portals) => { written.push({ map, portals }); });
        await shiftMapPortals("town.json", 64, 32, "editor");
        expect(written).toEqual([
            { map: "town", portals: [{ ...gate, position: { x: 164, y: 152 } }] },
            { map: "fields", portals: [{ ...into, target: { map: "town.json", x: 114, y: 92 } }, { ...ret, target: { map: "town", x: 180, y: 200 } }, elsewhere] },
        ]);
    });
    test("a same-map teleport moves both its place and where it leads", () => {
        const loop = base("Loop", { kind: "teleport", target: { map: "town", x: 10, y: 10 } });
        expect(shiftPlan([{ map: "town", portals: [loop] }], "town", 5, 7)).toEqual([{ map: "town", portals: [{ ...loop, position: { x: 15, y: 27 }, target: { map: "town", x: 15, y: 17 } }] }]);
    });
    test("moves the portals the server has now, not the ones the map editor loaded", async () => {
        // "Late" was saved in the portal editor after the map editor opened the map.
        cache.set("mapProperties", [{ name: "town.json", dungeonPortals: [base("A"), base("Late", { position: { x: 300, y: 40 } })] }]);
        const written: any[] = [];
        setPortalWriter(async (map, portals, by) => { written.push({ map, portals, by }); });
        await shiftMapPortals("town.json", 64, 32, "editor");
        expect(written).toEqual([{ map: "town", by: "editor", portals: [
            base("A", { position: { x: 74, y: 52 } }),
            base("Late", { position: { x: 364, y: 72 } }),
        ] }]);
    });
    test("writes nothing for a map without portals or a shift of nothing", async () => {
        cache.set("mapProperties", [{ name: "town.json", dungeonPortals: [] }, { name: "fields.json", dungeonPortals: [base("B")] }]);
        const written: any[] = [];
        setPortalWriter(async (map, portals) => { written.push({ map, portals }); });
        await shiftMapPortals("town", 64, 0, "editor");
        await shiftMapPortals("fields", 0, 0, "editor");
        expect(written).toEqual([]);
    });
});
