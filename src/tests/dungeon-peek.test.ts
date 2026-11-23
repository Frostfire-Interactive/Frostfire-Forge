import { describe, expect, test } from "bun:test";
import { PEEK_CAP, PEEK_RATE_MS, PEEK_HALF_H, PEEK_HALF_W, PEEK_MAX_PLAYERS, mirrorLine, peekFrame, peekLooksDue, peekSubscribe, peekTarget, teleportDestination, viewerCopy, type PeekDeps } from "../systems/dungeons/peek";
import type { CopyRecord, DungeonPortalObject } from "../systems/dungeons/types";

const copy = (over: Partial<CopyRecord>): CopyRecord => ({
    key: "crypt~a", dungeonId: 1, size: 5, entered: [], nodeId: null, openedAt: 0, bossTotal: 0, cleared: false, emptySince: null, ...over,
});
const dungeonPortal: DungeonPortalObject = { name: "d", kind: "dungeon", dungeonId: 1, mirror: true, target: null, position: { x: 0, y: 0 }, size: { width: 32, height: 64 }, layer: null };
const teleportPortal: DungeonPortalObject = { ...dungeonPortal, name: "t", kind: "teleport", dungeonId: null, target: { map: "fields", x: 300, y: 400 } };

function deps(copies: CopyRecord[], party: string[] = [], saved: { map: string; x: number; y: number } | null = null) {
    const touched: string[] = [];
    const d: PeekDeps = {
        copies: async (id) => { touched.push(`copies ${id}`); return copies.filter((c) => c.dungeonId === id); },
        partyOf: async () => party,
        entrance: async (c) => ({ x: c.dungeonId * 10, y: 20 }),
        savedSpot: async () => saved,
        defaultSpawn: () => ({ map: "main", x: 1, y: 2 }),
    };
    return { d, touched };
}

describe("viewerCopy", () => {
    test("the party's copy wins over the player's own, newest first; strangers' copies are never chosen", () => {
        const own = copy({ key: "crypt~own", entered: ["Ann"], openedAt: 5 });
        const party = copy({ key: "crypt~party", entered: ["bob"], openedAt: 1 });
        const stranger = copy({ key: "crypt~x", entered: ["zed"], openedAt: 9 });
        expect(viewerCopy([own, party, stranger], "ann", ["ann", "bob"])?.key).toBe("crypt~party");
        expect(viewerCopy([own, party, stranger], "ann", [])?.key).toBe("crypt~own");
        expect(viewerCopy([stranger], "ann", ["ann"])).toBeNull();
        const older = copy({ key: "crypt~old", entered: ["ann"], openedAt: 1 });
        expect(viewerCopy([older, own], "ann", [])?.key).toBe("crypt~own");
    });
});

describe("a teleport and its return portal", () => {
    test("each shows the other side: the source its destination, the return the spot in front of the source", async () => {
        const { d } = deps([]);
        const source: DungeonPortalObject = { ...teleportPortal, name: "Gate", position: { x: 100, y: 120 }, size: { width: 32, height: 48 } };
        const ret: DungeonPortalObject = {
            ...teleportPortal, name: "Gate (return)", target: { map: "town", x: 116, y: 184 }, position: { x: 284, y: 336 }, size: { width: 32, height: 48 },
            returnOf: { map: "town", name: "Gate" },
        };
        expect(await peekTarget(d, { username: "ann", map: "town" }, source)).toEqual({ map: "fields", x: 300, y: 400, nodeId: undefined });
        expect(await peekTarget(d, { username: "ann", map: "fields" }, ret)).toEqual({ map: "town", x: 116, y: 184, nodeId: undefined });
        expect(await peekTarget(d, { username: "ann", map: "fields" }, { ...ret, mirror: false })).toBeNull();
    });
});

describe("a dungeon portal and its exit on the dungeon's map", () => {
    test("in a copy the exit shows the viewer's saved spot outside; on the template it shows nothing", async () => {
        const exit: DungeonPortalObject = { ...dungeonPortal, name: "d (return)", dungeonId: null, returnOf: { map: "town", name: "d" } };
        const { d, touched } = deps([], [], { map: "town", x: 16, y: 32 });
        expect(await peekTarget(d, { username: "ann", map: "crypt~a" }, exit)).toMatchObject({ map: "town", x: 16, y: 32 });
        expect(await peekTarget(d, { username: "ann", map: "crypt" }, exit)).toBeNull();
        expect(touched).toEqual([]);
    });
});

describe("teleportDestination", () => {
    test("a teleport to a copy's own template stays in the copy; any other place is the live map", () => {
        expect(teleportDestination("crypt~a.json", { map: "crypt", x: 1, y: 2 })).toEqual({ map: "crypt~a", x: 1, y: 2 });
        expect(teleportDestination("crypt~a", { map: "town.json", x: 1, y: 2 })).toEqual({ map: "town", x: 1, y: 2 });
        expect(teleportDestination("town.json", { map: "fields", x: 1, y: 2 })).toEqual({ map: "fields", x: 1, y: 2 });
    });
});

describe("peekTarget", () => {
    test("a dungeon portal shows the viewer's own or party's copy at its entrance, and opens or changes nothing", async () => {
        const c = copy({ entered: ["ann"], nodeId: "n1" });
        const before = JSON.stringify(c);
        const { d } = deps([c]);
        expect(await peekTarget(d, { username: "ann", map: "town" }, dungeonPortal)).toEqual({ map: "crypt~a", x: 10, y: 20, nodeId: "n1" });
        expect(JSON.stringify(c)).toBe(before);
    });
    test("no copy of the viewer's open, mirror off, or no dungeon linked: nothing to stream", async () => {
        const { d, touched } = deps([copy({ entered: ["zed"] })]);
        expect(await peekTarget(d, { username: "ann", map: "town" }, dungeonPortal)).toBeNull();
        touched.length = 0;
        expect(await peekTarget(d, { username: "ann", map: "town" }, { ...dungeonPortal, mirror: false })).toBeNull();
        expect(await peekTarget(d, { username: "ann", map: "town" }, { ...dungeonPortal, dungeonId: null })).toBeNull();
        expect(touched).toEqual([]);
    });
    test("an exit portal on a copy shows the viewer's saved spot outside, else the default spawn", async () => {
        expect(await peekTarget(deps([], [], { map: "town.json", x: 7, y: 8 }).d, { username: "ann", map: "crypt~a" }, dungeonPortal))
            .toEqual({ map: "town", x: 7, y: 8, nodeId: undefined });
        expect(await peekTarget(deps([]).d, { username: "ann", map: "crypt~a" }, dungeonPortal)).toEqual({ map: "main", x: 1, y: 2, nodeId: undefined });
    });
    test("a teleport shows its place; one with no place shows nothing", async () => {
        expect(await peekTarget(deps([]).d, { username: "ann", map: "town" }, teleportPortal)).toEqual({ map: "fields", x: 300, y: 400, nodeId: undefined });
        expect(await peekTarget(deps([]).d, { username: "ann", map: "town" }, { ...teleportPortal, target: null })).toBeNull();
    });
});

describe("peekFrame", () => {
    const at = { map: "fields", x: 300, y: 400 };
    test("players within the opening and its margin, relative to the far place, in a steady order, at most PEEK_MAX_PLAYERS", () => {
        const players = [
            { id: "b", x: 300 + PEEK_HALF_W, y: 400, direction: "left", moving: true },
            { id: "a", x: 290.6, y: 380.2, direction: "up", moving: false },
            { id: "far", x: 300 + PEEK_HALF_W + 1, y: 400, direction: "up", moving: false },
            { id: "low", x: 300, y: 400 + PEEK_HALF_H + 1, direction: "up", moving: false },
        ];
        expect(peekFrame(players, at)).toEqual([
            { i: "a", x: -9, y: -20, d: "up", m: 0 },
            { i: "b", x: PEEK_HALF_W, y: 0, d: "left", m: 1 },
        ]);
        const crowd = Array.from({ length: PEEK_MAX_PLAYERS + 5 }, (_, i) => ({ id: `p${i}`, x: 300, y: 400, direction: "down", moving: false }));
        expect(peekFrame(crowd, at).length).toBe(PEEK_MAX_PLAYERS);
    });
});

describe("peekSubscribe", () => {
    test("a viewer streams at most PEEK_CAP portals; the same portal twice counts once; off removes it", () => {
        let subs: string[] = [];
        for (let i = 0; i < PEEK_CAP; i++) subs = peekSubscribe(subs, `p${i}`, true);
        expect(subs.length).toBe(PEEK_CAP);
        expect(peekSubscribe(subs, "extra", true)).toEqual(subs);
        expect(peekSubscribe(subs, "p0", true)).toEqual(subs);
        expect(peekSubscribe(subs, "p0", false)).toEqual(subs.slice(1));
    });
});

describe("peekLooksDue", () => {
  test("a player who left the far side and came back is sent their look again", () => {
    const held = new Map<string, string>();
    expect(peekLooksDue(held, [{ i: "a", look: "1:" }, { i: "b", look: "1:" }])).toEqual(["a", "b"]);
    expect(peekLooksDue(held, [{ i: "a", look: "1:" }])).toEqual([]);
    expect(peekLooksDue(held, [{ i: "a", look: "1:" }, { i: "b", look: "1:" }])).toEqual(["b"]);
  });
  test("a look is sent again only when it changes", () => {
    const held = new Map<string, string>();
    peekLooksDue(held, [{ i: "a", look: "1:" }]);
    expect(peekLooksDue(held, [{ i: "a", look: "1:" }])).toEqual([]);
    expect(peekLooksDue(held, [{ i: "a", look: "2:horse" }])).toEqual(["a"]);
  });
});

describe("mirrorLine", () => {
    const ret: DungeonPortalObject = { ...teleportPortal, name: "Gate (return)", position: { x: 284, y: 336 }, size: { width: 32, height: 48 } };
    test("a far portal's arrival spot or centre gives that portal's foot, the line the opening mirrors about", () => {
        expect(mirrorLine({ x: 300, y: 400 }, [dungeonPortal, ret])).toEqual({ x: 300, y: 384 });
        expect(mirrorLine({ x: 300, y: 360 }, [ret])).toEqual({ x: 300, y: 384 });
    });
    test("any other spot is the line itself", () => {
        expect(mirrorLine({ x: 300, y: 401 }, [ret])).toEqual({ x: 300, y: 401 });
        expect(mirrorLine({ x: 300, y: 400 }, null)).toEqual({ x: 300, y: 400 });
    });
});

test("the peek feed is sent 30 times a second", () => {
    expect(1000 / PEEK_RATE_MS).toBeCloseTo(30, 5);
});
