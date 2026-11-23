import { describe, expect, test } from "bun:test";
import { COPY_SEP, bareName, copyKey, isCopyKey, templateOf, clientMapName, newCopyId } from "../systems/dungeons/copykey";
import { LOCKOUT_ENTRIES, LOCKOUT_WINDOW_MS, canSpend, spend, lockoutWaitMs, currentLockout } from "../systems/dungeons/lockout";
import {
    decideEntry, refusalMessage, closeDue, strandedPlayers, portalEntered, loginPlacement, scaledMaxHealth,
    EMPTY_CLOSE_MS, STRANDED_MS,
} from "../systems/dungeons/rules";
import { DEFAULT_MULTIPLIERS } from "../systems/dungeons/types";
import type { CopyRecord, DungeonDef, DungeonPortalObject } from "../systems/dungeons/types";

describe("copykey", () => {
    test("builds and parses keys", () => {
        expect(COPY_SEP).toBe("~");
        expect(copyKey("crypt.json", "A1")).toBe("crypt~a1");
        expect(templateOf("crypt~a1.json")).toBe("crypt");
        expect(templateOf("crypt.json")).toBe("crypt");
        expect(clientMapName("crypt~a1.json")).toBe("crypt.json");
        expect(clientMapName("crypt~a1")).toBe("crypt");
        expect(clientMapName("main")).toBe("main");
        expect(isCopyKey("main")).toBe(false);
        expect(isCopyKey("crypt~a1")).toBe(true);
        expect(newCopyId(35)).toBe("z");
        expect(newCopyId(36)).toBe("10");
    });

    test("bareName drops one .json suffix, and takes a missing name as empty", () => {
        expect(bareName("crypt~a1.json")).toBe("crypt~a1");
        expect(bareName("crypt")).toBe("crypt");
        expect(bareName("a.json.json")).toBe("a.json");
        expect(bareName(undefined as any)).toBe("");
    });
});

describe("lockout", () => {
    test("window and spending", () => {
        expect(LOCKOUT_ENTRIES).toBe(10);
        expect(LOCKOUT_WINDOW_MS).toBe(3_600_000);
        const t0 = 1_000_000;
        let l = { windowStart: 0, used: 0 };
        for (let i = 0; i < 10; i++) l = spend(l, t0 + i);
        expect(l).toEqual({ windowStart: t0, used: 10 });
        expect(canSpend(l, t0 + 3_599_999)).toBe(false);
        expect(lockoutWaitMs(l, t0 + 600_000)).toBe(3_000_000);
        expect(canSpend(l, t0 + 3_600_000)).toBe(true);
        expect(currentLockout(l, t0 + 3_600_000)).toEqual({ windowStart: 0, used: 0 });
        expect(spend(l, t0 + 3_600_000)).toEqual({ windowStart: t0 + 3_600_000, used: 1 });
        expect(lockoutWaitMs({ windowStart: 0, used: 0 }, t0)).toBe(0);
    });
});

const def: DungeonDef = {
    id: 1, name: "Crypt", map: "crypt", type: "dungeon", sizes: [5], multipliers: DEFAULT_MULTIPLIERS,
    entranceX: 0, entranceY: 0, enabled: true, portalColor: null,
};
const raid: DungeonDef = { ...def, id: 2, name: "Keep", type: "raid", sizes: [10, 20] };
const copy = (over: Partial<CopyRecord> = {}): CopyRecord => ({
    key: "crypt~a1", dungeonId: 1, size: 5, entered: [], nodeId: null, openedAt: 1, bossTotal: 1, cleared: false, emptySince: null, ...over,
});
const fresh = { windowStart: 0, used: 0 };
const spent = { windowStart: 1000, used: 10 };
const now = 2000;

describe("decideEntry", () => {
    test("rejoin own copy is free even when disabled", () => {
        const c = copy({ entered: ["ann"] });
        const d = decideEntry({ username: "ann", party: [], leader: null, def: { ...def, enabled: false }, copies: [c], lockout: spent, now });
        expect(d).toEqual({ kind: "rejoin", copy: c });
    });
    test("rejoin picks the newest copy containing the player", () => {
        const a = copy({ key: "crypt~a", entered: ["ann"], openedAt: 1 });
        const b = copy({ key: "crypt~b", entered: ["ann"], openedAt: 9 });
        const d = decideEntry({ username: "ann", party: [], leader: null, def, copies: [a, b], lockout: fresh, now });
        expect(d).toEqual({ kind: "rejoin", copy: b });
    });
    test("party member copy is joined", () => {
        const c = copy({ entered: ["bob"] });
        const d = decideEntry({ username: "ann", party: ["ann", "bob"], leader: "bob", def, copies: [c], lockout: fresh, now });
        expect(d).toEqual({ kind: "join", copy: c });
    });
    test("in a party, the party's copy wins over the player's own copy", () => {
        const own = copy({ key: "crypt~a", entered: ["ann"], openedAt: 9 });
        const theirs = copy({ key: "crypt~b", entered: ["bob"], openedAt: 1 });
        const d = decideEntry({ username: "ann", party: ["ann", "bob"], leader: "bob", def, copies: [own, theirs], lockout: fresh, now });
        expect(d).toEqual({ kind: "join", copy: theirs });
    });
    test("back into a party copy the player has entered is free", () => {
        const own = copy({ key: "crypt~a", entered: ["ann"], openedAt: 9 });
        const shared = copy({ key: "crypt~b", entered: ["bob", "ann"], openedAt: 1 });
        const d = decideEntry({ username: "ann", party: ["ann", "bob"], leader: "bob", def, copies: [own, shared], lockout: spent, now });
        expect(d).toEqual({ kind: "rejoin", copy: shared });
    });
    test("party names match whatever their case (parties store them lowercase)", () => {
        const own = copy({ key: "crypt~a", entered: ["Ann"], openedAt: 9 });
        const theirs = copy({ key: "crypt~b", entered: ["Bob"], openedAt: 1 });
        const d = decideEntry({ username: "Ann", party: ["ann", "bob"], leader: "bob", def, copies: [own, theirs], lockout: fresh, now });
        expect(d).toEqual({ kind: "join", copy: theirs });
    });
    test("a raid leader is the leader whatever the case", () => {
        const d = decideEntry({ username: "Ann", party: ["ann", "bob"], leader: "ann", def: raid, copies: [], lockout: fresh, now });
        expect(d.kind).toBe("choose_size");
    });
    test("newest of two copies with party members is chosen", () => {
        const a = copy({ key: "crypt~a", entered: ["bob"], openedAt: 1 });
        const b = copy({ key: "crypt~b", entered: ["cy"], openedAt: 5 });
        const d = decideEntry({ username: "ann", party: ["ann", "bob", "cy"], leader: "bob", def, copies: [a, b], lockout: fresh, now });
        expect(d).toEqual({ kind: "join", copy: b });
    });
    test("full copy refuses copy_full", () => {
        const c = copy({ entered: ["bob", "c", "d", "e", "f"] });
        const d = decideEntry({ username: "ann", party: ["ann", "bob"], leader: "bob", def, copies: [c], lockout: fresh, now });
        expect(d).toEqual({ kind: "refuse", reason: "copy_full" });
    });
    test("10/10 player refuses no_entries with waitMs; party member with entries left still joins", () => {
        const c = copy({ entered: ["bob"] });
        const base = { party: ["ann", "bob"], leader: "bob", def, copies: [c], now };
        const refused = decideEntry({ username: "ann", ...base, lockout: spent });
        expect(refused).toEqual({ kind: "refuse", reason: "no_entries", waitMs: 3_600_000 + 1000 - now });
        const joined = decideEntry({ username: "ann", ...base, lockout: fresh });
        expect(joined).toEqual({ kind: "join", copy: c });
    });
    test("disabled refuses new join and open", () => {
        const off = { ...def, enabled: false };
        const c = copy({ entered: ["bob"] });
        expect(decideEntry({ username: "ann", party: ["ann", "bob"], leader: "bob", def: off, copies: [c], lockout: fresh, now }))
            .toEqual({ kind: "refuse", reason: "disabled" });
        expect(decideEntry({ username: "ann", party: [], leader: null, def: off, copies: [], lockout: fresh, now }))
            .toEqual({ kind: "refuse", reason: "disabled" });
    });
    test("dungeon party of 6 refuses party_too_big limit 5", () => {
        const party = ["ann", "b", "c", "d", "e", "f"];
        expect(decideEntry({ username: "ann", party, leader: "ann", def, copies: [], lockout: fresh, now }))
            .toEqual({ kind: "refuse", reason: "party_too_big", limit: 5 });
    });
    test("raid non-leader with no copy refuses leader_must_open", () => {
        expect(decideEntry({ username: "bob", party: ["ann", "bob"], leader: "ann", def: raid, copies: [], lockout: fresh, now }))
            .toEqual({ kind: "refuse", reason: "leader_must_open" });
    });
    test("raid leader with two sizes gets choose_size; with size 10 and party 11 refuses limit 10", () => {
        const party = Array.from({ length: 11 }, (_, i) => (i === 0 ? "ann" : `p${i}`));
        expect(decideEntry({ username: "ann", party, leader: "ann", def: raid, copies: [], lockout: fresh, now }))
            .toEqual({ kind: "choose_size", sizes: [10, 20] });
        expect(decideEntry({ username: "ann", party, leader: "ann", def: raid, copies: [], lockout: fresh, now, size: 10 }))
            .toEqual({ kind: "refuse", reason: "party_too_big", limit: 10 });
        expect(decideEntry({ username: "ann", party, leader: "ann", def: raid, copies: [], lockout: fresh, now, size: 20 }))
            .toEqual({ kind: "open", size: 20 });
    });
    test("solo player opens a 5-player dungeon", () => {
        expect(decideEntry({ username: "ann", party: [], leader: null, def, copies: [], lockout: fresh, now }))
            .toEqual({ kind: "open", size: 5 });
    });
    test("open refuses no_entries when lockout is spent", () => {
        expect(decideEntry({ username: "ann", party: [], leader: null, def, copies: [], lockout: spent, now }).kind).toBe("refuse");
    });
});

describe("refusalMessage", () => {
    test("copy", () => {
        expect(refusalMessage({ kind: "refuse", reason: "no_entries", waitMs: 61_000 })).toBe("You have used all 10 dungeon entries this hour. Next entry in 2 min.");
        expect(refusalMessage({ kind: "refuse", reason: "disabled" })).toBe("This dungeon is closed.");
        expect(refusalMessage({ kind: "refuse", reason: "copy_full" })).toBe("This dungeon is full.");
        expect(refusalMessage({ kind: "refuse", reason: "party_too_big", limit: 5 })).toBe("Your group is too large for this dungeon (limit 5).");
        expect(refusalMessage({ kind: "refuse", reason: "leader_must_open" })).toBe("Your party leader must open this raid.");
    });
});

describe("closeDue", () => {
    test("cleared closes when empty", () => {
        expect(closeDue(copy({ cleared: true }), 0, now)).toBe(true);
        expect(closeDue(copy({ cleared: true }), 1, now)).toBe(false);
    });
    test("not cleared closes 300000 ms after empty", () => {
        expect(EMPTY_CLOSE_MS).toBe(300_000);
        expect(closeDue(copy({ emptySince: now - 299_999 }), 0, now)).toBe(false);
        expect(closeDue(copy({ emptySince: now - 300_000 }), 0, now)).toBe(true);
        expect(closeDue(copy({ emptySince: now - 300_000 }), 1, now)).toBe(false);
        expect(closeDue(copy({ emptySince: null }), 0, now)).toBe(false);
    });
});

describe("strandedPlayers", () => {
    test("rules", () => {
        expect(STRANDED_MS).toBe(60_000);
        expect(strandedPlayers([{ username: "ann", partyId: 1 }, { username: "bob", partyId: 1 }, { username: "cy", partyId: null }])).toEqual(["cy"]);
        expect(strandedPlayers([{ username: "ann", partyId: null }])).toEqual([]);
        expect(strandedPlayers([{ username: "ann", partyId: 1 }, { username: "bob", partyId: 2 }])).toEqual(["ann", "bob"]);
        expect(strandedPlayers([])).toEqual([]);
    });
});

describe("portalEntered", () => {
    const p: DungeonPortalObject = { name: "p", kind: "dungeon", dungeonId: 1, mirror: true, target: null, position: { x: 100, y: 100 }, size: { width: 32, height: 32 }, layer: null };
    test("fires only on outside to inside", () => {
        expect(portalEntered([p], { x: 110, y: 132 }, { x: 110, y: 126 })).toBe(p);
        expect(portalEntered([p], { x: 110, y: 110 }, { x: 112, y: 112 })).toBeNull();
        expect(portalEntered([p], { x: 10, y: 10 }, { x: 20, y: 20 })).toBeNull();
        expect(portalEntered([], { x: 110, y: 132 }, { x: 110, y: 126 })).toBeNull();
    });

    test("fires only when walked into from the front: from below its bottom edge, diagonals up included", () => {
        expect(portalEntered([p], { x: 110, y: 140 }, { x: 110, y: 131 })).toBe(p);
        expect(portalEntered([p], { x: 120, y: 134 }, { x: 114, y: 128 })).toBe(p);
        expect(portalEntered([p], { x: 110, y: 134 }, { x: 116, y: 128 })).toBe(p);
        // from above, and from either side, it never fires
        expect(portalEntered([p], { x: 110, y: 94 }, { x: 110, y: 100 })).toBeNull();
        expect(portalEntered([p], { x: 90, y: 90 }, { x: 110, y: 110 })).toBeNull();
        expect(portalEntered([p], { x: 94, y: 110 }, { x: 100, y: 110 })).toBeNull();
        expect(portalEntered([p], { x: 132, y: 110 }, { x: 126, y: 110 })).toBeNull();
        expect(portalEntered([p], { x: 94, y: 131 }, { x: 100, y: 126 })).toBeNull();
    });
});

describe("loginPlacement", () => {
    const portal = { map: "main", x: 5, y: 6 };
    test("cases", () => {
        expect(loginPlacement({ savedMap: "crypt~a1", copyOpen: true, onEnteredList: true, portal })).toEqual({ kind: "as_saved" });
        expect(loginPlacement({ savedMap: "crypt~a1", copyOpen: false, onEnteredList: true, portal })).toEqual({ kind: "portal", spot: portal });
        expect(loginPlacement({ savedMap: "crypt~a1", copyOpen: true, onEnteredList: false, portal })).toEqual({ kind: "portal", spot: portal });
        expect(loginPlacement({ savedMap: "crypt~a1", copyOpen: false, onEnteredList: false, portal: null })).toEqual({ kind: "default" });
        expect(loginPlacement({ savedMap: "main", copyOpen: false, onEnteredList: false, portal: null })).toEqual({ kind: "as_saved" });
    });
});

describe("scaling", () => {
    test("scaledMaxHealth and defaults", () => {
        expect(scaledMaxHealth(101, 1.5)).toBe(152);
        expect(scaledMaxHealth(0, 1)).toBe(1);
        expect(DEFAULT_MULTIPLIERS["10"]).toEqual({ health: 2, damage: 1.5 });
        expect(DEFAULT_MULTIPLIERS["20"]).toEqual({ health: 4, damage: 2 });
        expect(DEFAULT_MULTIPLIERS["5"]).toEqual({ health: 1, damage: 1 });
    });
});
