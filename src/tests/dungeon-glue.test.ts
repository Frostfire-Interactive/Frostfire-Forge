import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COPY_EDITOR_NOTICE, COPY_EDITOR_REFUSED, dueStranded, editorRefusedInCopy, releasePlan, strandedSince } from "../systems/dungeons/rules";
import { memoryCopyBook } from "../systems/dungeons/copybook";
import {
    PORTAL_COMBAT_NOTICE, PORTAL_FAILED_NOTICE, SIZE_CHOICE_MS, copyKilled, dungeonTick, leaveCopy, loginSpot, pickSize, portalCrossing, portalStep,
    type LeaveDeps, type PortalDeps, type TickDeps, type TickInside,
} from "../systems/dungeons/glue";
import type { EntryRequest, EntryResult } from "../systems/dungeons/entry";
import type { CopyRecord, DungeonPortalObject } from "../systems/dungeons/types";
import { WARP_COOLDOWN_MS } from "../systems/warpcooldown";

const record = (over: Partial<CopyRecord> = {}): CopyRecord => ({
    key: "crypt~a", dungeonId: 1, size: 5, entered: ["ann"], nodeId: null, openedAt: 0, bossTotal: 1, cleared: false, emptySince: null, ...over,
});

describe("stranding helpers", () => {
    test("held from the first tick it is seen, due after STRANDED_MS, cleared when back in a party", () => {
        let since = strandedSince(new Map(), ["cy"], 1000); expect([...since]).toEqual([["cy", 1000]]);
        since = strandedSince(since, ["cy"], 30_000); expect(since.get("cy")).toBe(1000);
        expect(dueStranded(since, 60_999)).toEqual([]); expect(dueStranded(since, 61_000)).toEqual(["cy"]);
        expect([...strandedSince(since, [], 62_000)]).toEqual([]);
    });
});

describe("releasePlan", () => {
    test("overworld uses the graveyard, a copy the entrance, a copy without one the portal", () => {
        expect(releasePlan("town", null)).toEqual({ kind: "graveyard" });
        expect(releasePlan("town.json", { x: 1, y: 2 })).toEqual({ kind: "graveyard" });
        expect(releasePlan("crypt~a", { x: 5, y: 6 })).toEqual({ kind: "entrance", x: 5, y: 6 });
        expect(releasePlan("crypt~a.json", null)).toEqual({ kind: "portal" });
    });
});

const portal: DungeonPortalObject = { name: "p", kind: "dungeon", dungeonId: 1, mirror: true, target: null, position: { x: 100, y: 100 }, size: { width: 20, height: 40 }, layer: null };
const teleportPortal: DungeonPortalObject = { ...portal, name: "t", kind: "teleport", dungeonId: null, target: { map: "fields", x: 300, y: 400 } };
// walked into from the front: up across its bottom edge (y 140)
const outside = { x: 110, y: 140 }, inside = { x: 110, y: 134 };

function portalSetup(results: EntryResult[]) {
    const calls: string[] = [];
    const requests: EntryRequest[] = [];
    const readyAt = new Map<string, number>();
    let clock = 1000;
    const deps: PortalDeps = {
        enter: async (req) => { requests.push(req); return results.shift()!; },
        partyOf: async () => ({ party: ["ann", "bob"], leader: "ann" }),
        setPortal: async (u, spot) => { calls.push(`portal ${u} ${spot.map} ${spot.x} ${spot.y}`); },
        entrance: async (copy) => ({ x: copy.dungeonId * 10, y: 7 }),
        moveInto: async (_p, key, at) => { calls.push(`into ${key} ${at.x} ${at.y}`); return true; },
        teleport: async (_p, spot) => { calls.push(`teleport ${spot.map} ${spot.x} ${spot.y}`); return true; },
        sendOut: async (p) => { calls.push(`out ${p.username}`); },
        stop: async () => { calls.push("stop"); },
        offerSizes: (_p, offer) => { calls.push(`offer ${offer.dungeonId} ${offer.name} ${offer.sizes.join(",")} ${offer.authorization}`); },
        dungeonName: async () => "Crypt",
        notify: (_p, message) => { calls.push(`notify ${message}`); },
        authorization: () => "tok",
        now: () => clock,
        warpCooldownLeft: (u) => Math.max(0, (readyAt.get(u) ?? 0) - clock),
        startWarpCooldown: (u) => { readyAt.set(u, clock + WARP_COOLDOWN_MS); calls.push(`cooldown ${u}`); },
        endWarpCooldown: (u) => { readyAt.delete(u); calls.push(`no cooldown ${u}`); },
        warn: (message) => { calls.push(`warn ${message}`); },
    };
    return { deps, calls, requests, tick: (ms: number) => { clock += ms; } };
}

describe("portalStep", () => {
    test("dead, ghost and in-combat players are refused like warps; one in combat is told why", async () => {
        const { deps, calls } = portalSetup([]);
        for (const p of [{ username: "ann", isDead: true }, { username: "ann", isGhost: true }, { username: "ann", pvp: true }]) {
            expect(await portalStep(deps, p, "town", [portal], outside, inside)).toBe(false);
        }
        expect(calls).toEqual([`notify ${PORTAL_COMBAT_NOTICE}`]);
        // Standing on in the portal tells nothing more.
        expect(await portalStep(deps, { username: "ann", pvp: true }, "town", [portal], inside, { x: 106, y: 110 })).toBe(false);
        expect(calls.length).toBe(1);
    });

    test("a size pick in combat is refused and told why", async () => {
        const { deps, calls, requests } = portalSetup([{ kind: "choose_size", sizes: [10, 20] }, { kind: "enter", copy: record({ size: 10 }), paid: true }]);
        const p: any = { username: "ann", location: { map: "town", position: inside } };
        await portalStep(deps, p, "town", [portal], outside, inside);
        p.pvp = true;
        calls.length = 0;
        expect(await pickSize(deps, p, { authorization: "tok", size: 10 })).toBe(false);
        expect(calls).toEqual([`notify ${PORTAL_COMBAT_NOTICE}`]);
        expect(requests.length).toBe(1);
    });

    test("a portal that fails is logged and told, and the step goes on", async () => {
        const { deps, calls } = portalSetup([]);
        deps.enter = async () => { throw new Error("db down"); };
        const p: any = { username: "ann" };
        expect(await portalStep(deps, p, "town", [portal], outside, inside)).toBe(false);
        expect(calls).toEqual(["stop", "warn Dungeon portal of ann failed: Error: db down", `notify ${PORTAL_FAILED_NOTICE}`]);
        expect(p._portalBusy).toBe(false);
    });

    test("a size pick that fails is logged and told", async () => {
        const { deps, calls } = portalSetup([{ kind: "choose_size", sizes: [10, 20] }]);
        const p: any = { username: "ann", location: { map: "town", position: inside } };
        await portalStep(deps, p, "town", [portal], outside, inside);
        deps.enter = async () => { throw new Error("db down"); };
        calls.length = 0;
        expect(await pickSize(deps, p, { authorization: "tok", size: 10 })).toBe(false);
        expect(calls).toEqual(["warn Dungeon portal of ann failed: Error: db down", `notify ${PORTAL_FAILED_NOTICE}`]);
    });

    test("only stepping from outside to inside fires", async () => {
        const { deps, calls } = portalSetup([]);
        expect(await portalStep(deps, { username: "ann" }, "town", [portal], inside, { x: 106, y: 110 })).toBe(false);
        expect(await portalStep(deps, { username: "ann" }, "town", [], outside, inside)).toBe(false);
        expect(calls).toEqual([]);
    });

    test("on the overworld it enters: the spot in front of the portal saved, then moved to the copy entrance", async () => {
        const copy = record();
        const { deps, calls, requests } = portalSetup([{ kind: "enter", copy, paid: true }]);
        expect(await portalStep(deps, { username: "ann" }, "town.json", [portal], outside, inside)).toBe(true);
        expect(requests).toEqual([{ username: "ann", party: ["ann", "bob"], leader: "ann", dungeonId: 1, size: undefined }]);
        expect(calls).toEqual(["stop", "portal ann town 110 156", "cooldown ann", "into crypt~a 10 7"]);
    });

    test("a dungeon's exit portal, made on its template, leads out in a copy and nowhere on the template", async () => {
        const exit: DungeonPortalObject = { ...portal, name: "p (return)", dungeonId: null, returnOf: { map: "town", name: "p" } };
        const { deps, calls, requests } = portalSetup([]);
        expect(await portalStep(deps, { username: "ann" }, "crypt", [exit], outside, inside)).toBe(false);
        expect(calls).toEqual([]);
        expect(await portalStep(deps, { username: "ann" }, "crypt~a", [exit], outside, inside)).toBe(true);
        expect(requests).toEqual([]);
        expect(calls).toEqual(["stop", "cooldown ann", "out ann"]);
    });

    test("inside a copy any portal leads out", async () => {
        const { deps, calls, requests } = portalSetup([]);
        expect(await portalStep(deps, { username: "ann" }, "crypt~a", [portal], outside, inside)).toBe(true);
        expect(requests).toEqual([]);
        expect(calls).toEqual(["stop", "cooldown ann", "out ann"]);
    });

    test("a refusal is told and the player is not moved", async () => {
        const { deps, calls } = portalSetup([{ kind: "refuse", reason: "disabled", message: "This dungeon is closed." }]);
        expect(await portalStep(deps, { username: "ann" }, "town", [portal], outside, inside)).toBe(false);
        expect(calls).toEqual(["stop", "notify This dungeon is closed."]);
    });

    test("a size choice is offered, kept 60 s, and a matching pick enters with that size", async () => {
        const copy = record({ size: 10 });
        const { deps, calls, requests, tick } = portalSetup([{ kind: "choose_size", sizes: [10, 20] }, { kind: "enter", copy, paid: true }]);
        const p: any = { username: "ann", location: { map: "town", position: inside } };
        expect(await portalStep(deps, p, "town", [portal], outside, inside)).toBe(false);
        expect(calls).toEqual(["stop", "offer 1 Crypt 10,20 tok"]);
        expect(p._dungeonChoice.until).toBe(1000 + SIZE_CHOICE_MS);

        expect(await pickSize(deps, p, { authorization: "wrong", size: 10 })).toBe(false);
        expect(await pickSize(deps, p, { authorization: "tok", size: 5 })).toBe(false);
        expect(requests.length).toBe(1);

        tick(SIZE_CHOICE_MS - 1);
        expect(await pickSize(deps, p, { authorization: "tok", size: 10 })).toBe(true);
        expect(requests[1]).toEqual({ username: "ann", party: ["ann", "bob"], leader: "ann", dungeonId: 1, size: 10 });
        expect(calls.slice(2)).toEqual(["portal ann town 110 156", "cooldown ann", "into crypt~a 10 7"]);
        expect(p._dungeonChoice).toBeUndefined();
        expect(await pickSize(deps, p, { authorization: "tok", size: 10 })).toBe(false);
    });

    test("a pick after 60 s is ignored", async () => {
        const { deps, requests, tick } = portalSetup([{ kind: "choose_size", sizes: [10, 20] }]);
        const p: any = { username: "ann" };
        await portalStep(deps, p, "town", [portal], outside, inside);
        tick(SIZE_CHOICE_MS);
        expect(await pickSize(deps, p, { authorization: "tok", size: 10 })).toBe(false);
        expect(requests.length).toBe(1);
    });

    test("a pick from another map or away from the portal is refused and the choice dropped", async () => {
        for (const location of [{ map: "cave.json", position: inside }, { map: "crypt~b", position: inside }, { map: "town", position: { x: 400, y: 110 } }]) {
            const { deps, requests } = portalSetup([{ kind: "choose_size", sizes: [10, 20] }, { kind: "enter", copy: record({ size: 10 }), paid: true }]);
            const p: any = { username: "ann", location: { map: "town", position: inside } };
            await portalStep(deps, p, "town", [portal], outside, inside);
            p.location = location;
            expect(await pickSize(deps, p, { authorization: "tok", size: 10 })).toBe(false);
            expect(p._dungeonChoice).toBeUndefined();
            expect(requests.length).toBe(1);
        }
    });

    test("going in starts the warp cooldown; a portal stepped into during it is refused with the time left, and works after it", async () => {
        const { deps, calls, tick } = portalSetup([{ kind: "enter", copy: record(), paid: true }]);
        expect(await portalStep(deps, { username: "ann" }, "town", [portal], outside, inside)).toBe(true);
        calls.length = 0;
        tick(WARP_COOLDOWN_MS - 500);
        expect(await portalStep(deps, { username: "ann" }, "crypt~a", [portal], outside, inside)).toBe(false);
        expect(calls).toEqual(["notify You can warp again in 1 second."]);
        calls.length = 0;
        tick(500);
        expect(await portalStep(deps, { username: "ann" }, "crypt~a", [portal], outside, inside)).toBe(true);
        expect(calls).toEqual(["stop", "cooldown ann", "out ann"]);
    });

    test("coming out starts it too: the portal outside cannot be taken straight back in", async () => {
        const { deps, calls, requests } = portalSetup([{ kind: "enter", copy: record(), paid: true }]);
        expect(await portalStep(deps, { username: "ann" }, "crypt~a", [portal], outside, inside)).toBe(true);
        calls.length = 0;
        expect(await portalStep(deps, { username: "ann" }, "town", [portal], outside, inside)).toBe(false);
        expect(calls).toEqual(["notify You can warp again in 1 second."]);
        expect(requests).toEqual([]);
    });

    test("a refusal or a size offer starts no cooldown; a move that fails ends the one it started", async () => {
        const refused = portalSetup([{ kind: "refuse", reason: "disabled", message: "This dungeon is closed." }, { kind: "choose_size", sizes: [10, 20] }]);
        await portalStep(refused.deps, { username: "ann" }, "town", [portal], outside, inside);
        await portalStep(refused.deps, { username: "ann" }, "town", [portal], outside, inside);
        expect(refused.calls.filter((c) => c.includes("cooldown"))).toEqual([]);
        expect(refused.deps.warpCooldownLeft("ann")).toBe(0);

        const failed = portalSetup([{ kind: "enter", copy: record(), paid: true }]);
        failed.deps.moveInto = async () => false;
        expect(await portalStep(failed.deps, { username: "ann" }, "town", [portal], outside, inside)).toBe(false);
        expect(failed.calls).toEqual(["stop", "portal ann town 110 156", "cooldown ann", "no cooldown ann"]);
        expect(failed.deps.warpCooldownLeft("ann")).toBe(0);

        const thrown = portalSetup([]);
        thrown.deps.sendOut = async () => { throw new Error("gone"); };
        expect(await portalStep(thrown.deps, { username: "ann" }, "crypt~a", [portal], outside, inside)).toBe(false);
        expect(thrown.deps.warpCooldownLeft("ann")).toBe(0);
    });

    test("a size pick during the cooldown is refused with the time left", async () => {
        const { deps, calls, requests } = portalSetup([{ kind: "choose_size", sizes: [10, 20] }, { kind: "enter", copy: record({ size: 10 }), paid: true }]);
        const p: any = { username: "ann", location: { map: "town", position: inside } };
        await portalStep(deps, p, "town", [portal], outside, inside);
        deps.startWarpCooldown("ann");
        calls.length = 0;
        expect(await pickSize(deps, p, { authorization: "tok", size: 10 })).toBe(false);
        expect(calls).toEqual(["notify You can warp again in 1 second."]);
        expect(requests.length).toBe(1);
    });

    test("a pick a step beside the portal still enters", async () => {
        const { deps, requests } = portalSetup([{ kind: "choose_size", sizes: [10, 20] }, { kind: "enter", copy: record({ size: 10 }), paid: true }]);
        const p: any = { username: "ann", location: { map: "town.json", position: inside } };
        await portalStep(deps, p, "town.json", [portal], outside, inside);
        p.location.position = { x: 90, y: 110 };
        expect(await pickSize(deps, p, { authorization: "tok", size: 10 })).toBe(true);
        expect(requests.length).toBe(2);
    });
});

describe("portalStep through a teleport portal", () => {
    test("moves the player to its place with the warp cooldown, and opens no copy", async () => {
        const { deps, calls, requests } = portalSetup([]);
        expect(await portalStep(deps, { username: "ann" }, "town", [teleportPortal], outside, inside)).toBe(true);
        expect(calls).toEqual(["stop", "cooldown ann", "teleport fields 300 400"]);
        expect(requests.length).toBe(0);
    });
    test("waits out the warp cooldown, and is refused in combat like a warp", async () => {
        const { deps, calls } = portalSetup([]);
        await portalStep(deps, { username: "ann" }, "town", [teleportPortal], outside, inside);
        calls.length = 0;
        expect(await portalStep(deps, { username: "ann" }, "fields", [teleportPortal], outside, inside)).toBe(false);
        expect(calls[0]).toStartWith("notify");
        expect(await portalStep(deps, { username: "bob", pvp: true }, "town", [teleportPortal], outside, inside)).toBe(false);
        expect(calls.at(-1)).toBe(`notify ${PORTAL_COMBAT_NOTICE}`);
    });
    test("a failed move ends the cooldown", async () => {
        const { deps, calls } = portalSetup([]);
        deps.teleport = async () => false;
        expect(await portalStep(deps, { username: "ann" }, "town", [teleportPortal], outside, inside)).toBe(false);
        expect(calls).toContain("no cooldown ann");
    });
    test("inside a copy, a teleport to the copy's own template stays in the copy; it does not send the player out", async () => {
        const { deps, calls } = portalSetup([]);
        const inCopy = { ...teleportPortal, target: { map: "crypt", x: 5, y: 6 } };
        expect(await portalStep(deps, { username: "ann" }, "crypt~a", [inCopy], outside, inside)).toBe(true);
        expect(calls).toEqual(["stop", "cooldown ann", "teleport crypt~a 5 6"]);
    });
    test("a teleport with no place, and a dungeon portal linked to no dungeon, do nothing", async () => {
        const { deps, calls } = portalSetup([]);
        expect(await portalStep(deps, { username: "ann" }, "town", [{ ...teleportPortal, target: null }], outside, inside)).toBe(false);
        expect(await portalStep(deps, { username: "ann" }, "town", [{ ...portal, dungeonId: null }], outside, inside)).toBe(false);
        expect(calls).toEqual([]);
    });
    test("a dungeon portal linked to no dungeon still leads out of a copy", async () => {
        const { deps, calls } = portalSetup([]);
        expect(await portalStep(deps, { username: "ann" }, "crypt~a", [{ ...portal, dungeonId: null }], outside, inside)).toBe(true);
        expect(calls).toContain("out ann");
    });
});

describe("portalCrossing", () => {
    test("the first step of a replayed walk that went into a portal, as one step of a walk is checked", () => {
        expect(portalCrossing([portal], [outside, inside, { x: 106, y: 110 }])).toEqual({ before: outside, after: inside });
        // Through the portal and out the far side in one replay.
        expect(portalCrossing([portal], [{ x: 80, y: 110 }, outside, inside, { x: 125, y: 110 }])).toEqual({ before: outside, after: inside });
    });

    test("a replay that starts on a portal does not take it; nor one that never reaches it", () => {
        expect(portalCrossing([portal], [inside, { x: 106, y: 110 }, { x: 108, y: 110 }])).toBeNull();
        expect(portalCrossing([portal], [{ x: 80, y: 110 }, outside])).toBeNull();
        expect(portalCrossing([portal], [inside])).toBeNull();
        expect(portalCrossing([], [outside, inside])).toBeNull();
        expect(portalCrossing(null, [outside, inside])).toBeNull();
    });

    test("a replay that walks into a portal from above or from a side does not take it", () => {
        expect(portalCrossing([portal], [{ x: 110, y: 90 }, { x: 110, y: 96 }, { x: 110, y: 102 }, { x: 110, y: 108 }])).toBeNull();
        expect(portalCrossing([portal], [{ x: 90, y: 110 }, { x: 96, y: 110 }, { x: 102, y: 110 }])).toBeNull();
        expect(portalCrossing([portal], [{ x: 130, y: 120 }, { x: 124, y: 120 }, { x: 118, y: 120 }])).toBeNull();
        // ... and one that went round to its front and walked in does
        expect(portalCrossing([portal], [{ x: 90, y: 110 }, { x: 96, y: 146 }, { x: 110, y: 146 }, { x: 110, y: 140 }, { x: 110, y: 134 }]))
            .toEqual({ before: { x: 110, y: 140 }, after: { x: 110, y: 134 } });
    });
});

describe("leaveCopy", () => {
    function leaveSetup(spot: { map: string; x: number; y: number } | null, arrives = true) {
        const calls: string[] = [];
        const deps: LeaveDeps = {
            portal: async () => spot,
            defaultSpawn: () => ({ map: "town", x: 1, y: 2 }),
            arriveAt: async (_p, map, at) => { calls.push(`arrive ${map} ${at.x} ${at.y} ${at.direction}`); return arrives; },
            place: async (p, map, x, y) => { calls.push(`place ${map} ${x} ${y} ${p.location?.position?.direction}`); },
            warn: (message) => { calls.push(`warn ${message}`); },
        };
        return { deps, calls };
    }
    const inCopy = () => ({ id: "s1", username: "ann", location: { map: "crypt~a", position: { x: 5, y: 5, direction: "left" } } });

    test("the spot outside is saved as where the player stands, then they are moved there", async () => {
        const { deps, calls } = leaveSetup({ map: "field", x: 30, y: 40 });
        await leaveCopy(deps, inCopy());
        expect(calls).toEqual(["arrive field 30 40 down", "place field 30 40 down"]);
    });

    test("without a portal spot it is the default spawn", async () => {
        const { deps, calls } = leaveSetup(null);
        await leaveCopy(deps, inCopy());
        expect(calls).toEqual(["arrive town 1 2 down", "place town 1 2 down"]);
    });

    test("a save the database refuses is logged and the player still leaves", async () => {
        const { deps, calls } = leaveSetup({ map: "field", x: 30, y: 40 }, false);
        await leaveCopy(deps, inCopy());
        expect(calls).toEqual(["arrive field 30 40 down", "warn The spot of ann outside the dungeon (field) was not saved", "place field 30 40 down"]);
    });

    test("a spot on the map the player is on is only a move", async () => {
        const { deps, calls } = leaveSetup({ map: "crypt~a.json", x: 30, y: 40 });
        await leaveCopy(deps, inCopy());
        expect(calls).toEqual(["place crypt~a.json 30 40 down"]);
    });
});

function tickSetup(records: CopyRecord[], inside: Record<string, TickInside[]>, opts: { self?: string | null; live?: string[] | null; known?: string[] } = {}) {
    const book = memoryCopyBook();
    const closed: string[] = [];
    const out: string[] = [];
    let clock = 10_000;
    const deps: TickDeps = {
        book,
        self: opts.self ?? null,
        liveNodes: async () => (opts.live === undefined ? [] : opts.live),
        known: (key) => (opts.known ?? records.map((r) => r.key)).includes(key),
        inside: (key) => inside[key] ?? [],
        close: async (key) => { closed.push(key); await book.remove(key); },
        sendOut: async (p: any) => { out.push(p.username); },
        now: () => clock,
    };
    return { deps, book, closed, out, put: () => Promise.all(records.map((r) => book.put(r))), tick: (ms: number) => { clock += ms; } };
}

const who = (username: string, partyId: number | null): TickInside => ({ player: { username }, username, partyId });

describe("dungeonTick", () => {
    test("empty time is kept, a cleared empty copy closes, a not cleared one closes after 5 min", async () => {
        const { deps, book, closed, put, tick } = tickSetup([record({ key: "crypt~a", cleared: true }), record({ key: "crypt~b" }), record({ key: "crypt~c" })], { "crypt~c": [who("ann", null)] });
        await put();
        await book.put(record({ key: "crypt~c", emptySince: 5 }));
        await dungeonTick(deps, new Map());
        expect(closed).toEqual(["crypt~a"]);
        expect((await book.get("crypt~b"))!.emptySince).toBe(10_000);
        expect((await book.get("crypt~c"))!.emptySince).toBeNull();
        tick(299_999);
        await dungeonTick(deps, new Map());
        expect(closed).toEqual(["crypt~a"]);
        tick(1);
        await dungeonTick(deps, new Map());
        expect(closed).toEqual(["crypt~a", "crypt~b"]);
    });

    test("only this node's copies are ticked; records of nodes that are not live are removed", async () => {
        const { deps, book, closed } = tickSetup(
            [record({ key: "crypt~a", nodeId: "n2", cleared: true }), record({ key: "crypt~b", nodeId: "n3" }), record({ key: "crypt~c", nodeId: "n1", cleared: true })],
            {}, { self: "n1", live: ["n1", "n2"] },
        );
        await Promise.all([record({ key: "crypt~a", nodeId: "n2", cleared: true }), record({ key: "crypt~b", nodeId: "n3" }), record({ key: "crypt~c", nodeId: "n1", cleared: true })].map((r) => book.put(r)));
        await dungeonTick(deps, new Map());
        expect(closed).toEqual(["crypt~c"]);
        expect(await book.get("crypt~a")).not.toBeNull();
        expect(await book.get("crypt~b")).toBeNull();
    });

    test("when the live list cannot be read no record of another node is removed", async () => {
        const { deps, book } = tickSetup([record({ key: "crypt~b", nodeId: "n3" })], {}, { self: "n1", live: null });
        await book.put(record({ key: "crypt~b", nodeId: "n3" }));
        await dungeonTick(deps, new Map());
        expect(await book.get("crypt~b")).not.toBeNull();
    });

    test("a record of this node whose map is not here is removed", async () => {
        const { deps, book, closed } = tickSetup([record({ key: "crypt~a" })], {}, { known: [] });
        await book.put(record({ key: "crypt~a" }));
        await dungeonTick(deps, new Map());
        expect(await book.get("crypt~a")).toBeNull();
        expect(closed).toEqual([]);
    });

    test("a stranded player is sent out after 60 s held; a player alone is not", async () => {
        const { deps, book, out, tick } = tickSetup([record({ key: "crypt~a" }), record({ key: "crypt~b" })], {
            "crypt~a": [who("ann", 1), who("bob", 1), who("cy", null)],
            "crypt~b": [who("dee", null)],
        });
        await book.put(record({ key: "crypt~a" }));
        await book.put(record({ key: "crypt~b" }));
        let since = await dungeonTick(deps, new Map());
        expect([...since]).toEqual([["cy", 10_000]]);
        tick(59_999);
        since = await dungeonTick(deps, since);
        expect(out).toEqual([]);
        tick(1);
        since = await dungeonTick(deps, since);
        expect(out).toEqual(["cy"]);
        expect(since.has("cy")).toBe(false);
    });
});

describe("dungeonTick and the dead", () => {
    test("dead and ghost players are never stranded, but still keep the copy from being empty", async () => {
        const { deps, book, out, tick, closed } = tickSetup([record({ key: "crypt~a" })], {
            "crypt~a": [{ ...who("ann", null), down: true }, { ...who("bob", null), down: true }, who("cy", null)],
        });
        await book.put(record({ key: "crypt~a" }));
        let since = await dungeonTick(deps, new Map());
        expect([...since]).toEqual([["cy", 10_000]]);
        tick(60_000);
        since = await dungeonTick(deps, since);
        expect(out).toEqual(["cy"]);
        expect(closed).toEqual([]);
        expect((await book.get("crypt~a"))!.emptySince).toBeNull();
    });
});

describe("editorRefusedInCopy", () => {
    test("map editor actions are refused while the player stands in a copy", () => {
        for (const type of ["EDITOR_TILE_EDIT", "EDITOR_LAYER_LOCK", "EDITOR_OPEN", "SAVE_MAP", "MAILBOX_EDITOR_SAVE", "GATHERING_EDITOR_SAVE", "FISHING_EDITOR_SAVE", "CREATURE_EDITOR_SAVE_SPAWN", "CREATURE_EDITOR_SAVE_PATH"]) {
            expect(editorRefusedInCopy(type, "crypt~a")).toBe(true);
            expect(editorRefusedInCopy(type, "crypt~a.json")).toBe(true);
            expect(editorRefusedInCopy(type, "crypt")).toBe(false);
        }
        expect(editorRefusedInCopy("ITEM_EDITOR_SAVE", "crypt~a")).toBe(false);
        expect(editorRefusedInCopy("EDITOR_CLOSE", "crypt~a")).toBe(false);
        expect(editorRefusedInCopy("SAVE_MAP", undefined)).toBe(false);
        expect(COPY_EDITOR_NOTICE).toBe("Leave the dungeon to edit its map");
    });

    test("a map edit naming a copy is refused wherever the player stands", () => {
        expect(editorRefusedInCopy("SAVE_MAP", "crypt", { mapName: "crypt~a" })).toBe(true);
        expect(editorRefusedInCopy("EDITOR_TILE_EDIT", "town.json", { mapName: "crypt~a.json", edits: [] })).toBe(true);
        expect(editorRefusedInCopy("CREATURE_EDITOR_SAVE_SPAWN", "town", { map: "crypt~a" })).toBe(true);
        expect(editorRefusedInCopy("MAILBOX_EDITOR_SAVE", "town", { map: "crypt~a.json" })).toBe(true);
        expect(editorRefusedInCopy("SAVE_MAP", "crypt", { mapName: "crypt" })).toBe(false);
        expect(editorRefusedInCopy("SAVE_MAP", "crypt", { mapName: 7 })).toBe(false);
        expect(editorRefusedInCopy("SAVE_MAP", "crypt", null)).toBe(false);
        expect(editorRefusedInCopy("ITEM_EDITOR_SAVE", "town", { map: "crypt~a" })).toBe(false);
    });

    test("every refused action is one the editor handler takes", () => {
        const editors = readFileSync(join(import.meta.dir, "..", "socket", "handlers", "editors.ts"), "utf8");
        const handles = editors.slice(editors.indexOf("export const handles"), editors.indexOf("\n", editors.indexOf("export const handles")));
        expect(COPY_EDITOR_REFUSED.size).toBeGreaterThan(0);
        for (const type of COPY_EDITOR_REFUSED) expect(handles).toContain(`"${type}"`);
    });
});

describe("copyKilled", () => {
    function clearSetup(living: number) {
        const book = memoryCopyBook();
        const dropped: string[] = [];
        return { book, dropped, deps: { book, livingBosses: () => living, dropChests: (key: string) => { dropped.push(key); } } };
    }

    test("the last boss drops the copy's chests, once", async () => {
        const { book, dropped, deps } = clearSetup(0);
        await book.put(record({ bossTotal: 2 }));
        await copyKilled(deps, "crypt~a.json", "boss");
        await copyKilled(deps, "crypt~a", "boss");
        expect(dropped).toEqual(["crypt~a"]);
        const living = clearSetup(1);
        await living.book.put(record());
        await copyKilled(living.deps, "crypt~a", "boss");
        expect(living.dropped).toEqual([]);
    });

    test("the last boss clears the copy", async () => {
        const { book, dropped, deps } = clearSetup(0);
        await book.put(record({ bossTotal: 2 }));
        expect(await copyKilled(deps, "crypt~a", "boss")).toBe(true);
        expect((await book.get("crypt~a"))!.cleared).toBe(true);
        expect(await copyKilled(deps, "crypt~a", "boss")).toBe(false);
        expect(dropped.length).toBe(1);
    });

    test("two boss deaths at once clear it once", async () => {
        const { book, dropped, deps } = clearSetup(0);
        await book.put(record({ bossTotal: 2 }));
        const results = await Promise.all([copyKilled(deps, "crypt~a", "boss"), copyKilled(deps, "crypt~a.json", "boss")]);
        expect(results.filter(Boolean).length).toBe(1);
        expect(dropped).toEqual(["crypt~a"]);
    });

    test("not cleared while a boss lives, for a non-boss, outside copies, or without bosses", async () => {
        const living = clearSetup(1);
        await living.book.put(record());
        expect(await copyKilled(living.deps, "crypt~a", "boss")).toBe(false);
        const none = clearSetup(0);
        await none.book.put(record({ bossTotal: 0 }));
        expect(await copyKilled(none.deps, "crypt~a", "boss")).toBe(false);
        await none.book.put(record({ key: "crypt~b" }));
        expect(await copyKilled(none.deps, "crypt~b", "elite")).toBe(false);
        expect(await copyKilled(none.deps, "crypt", "boss")).toBe(false);
        expect(none.dropped).toEqual([]);
        expect((await none.book.get("crypt~b"))!.cleared).toBe(false);
    });
});

describe("loginSpot", () => {
    const spot = { map: "town", x: 110, y: 120 };
    function loginSetup(here: string[], live: string[] = []) {
        const book = memoryCopyBook();
        return { book, deps: { book, portal: async (u: string) => (u === "ann" ? spot : null), here: (k: string) => here.includes(k), liveElsewhere: async (n: string | null) => n !== null && live.includes(n) } };
    }

    test("an open copy the player entered keeps them; a gone copy sends them to their portal or the default", async () => {
        const open = loginSetup(["crypt~a"]);
        await open.book.put(record());
        expect(await loginSpot(open.deps, "ann", "crypt~a.json")).toEqual({ kind: "as_saved" });
        expect(await loginSpot(open.deps, "ann", "town.json")).toEqual({ kind: "as_saved" });

        const gone = loginSetup([]);
        expect(await loginSpot(gone.deps, "ann", "crypt~a.json")).toEqual({ kind: "portal", spot });
        expect(await loginSpot(gone.deps, "bob", "crypt~a.json")).toEqual({ kind: "default" });
    });

    test("a copy on another live node is open; one whose record is here but map is not is gone", async () => {
        const elsewhere = loginSetup([], ["n2"]);
        await elsewhere.book.put(record({ nodeId: "n2" }));
        expect(await loginSpot(elsewhere.deps, "ann", "crypt~a")).toEqual({ kind: "as_saved" });
        await elsewhere.book.put(record({ nodeId: "n3" }));
        expect(await loginSpot(elsewhere.deps, "ann", "crypt~a")).toEqual({ kind: "portal", spot });
    });

    test("not on the entered list is sent to the portal", async () => {
        const open = loginSetup(["crypt~a"]);
        await open.book.put(record({ entered: ["bob"] }));
        expect(await loginSpot(open.deps, "ann", "crypt~a")).toEqual({ kind: "portal", spot });
    });
});
