import { describe, expect, test } from "bun:test";
import { enterDungeon, type EntryDeps } from "../systems/dungeons/entry";
import { memoryCopyBook, storeCopyBook } from "../systems/dungeons/copybook";
import { MemoryStore } from "../cluster/memorystore";
import { canSpend, lockoutWaitMs, spend, unspend, type Lockout } from "../systems/dungeons/lockout";
import { DEFAULT_MULTIPLIERS } from "../systems/dungeons/types";
import type { CopyRecord, DungeonDef, DungeonSize } from "../systems/dungeons/types";
import type { CopyBook } from "../systems/dungeons/copybook";

const def = (over: Partial<DungeonDef> = {}): DungeonDef => ({
    id: 1, name: "Crypt", map: "crypt", type: "dungeon", sizes: [5], multipliers: DEFAULT_MULTIPLIERS,
    entranceX: 1, entranceY: 2, enabled: true, portalColor: null, ...over,
});

function setup(d: DungeonDef | null = def(), book: CopyBook = memoryCopyBook(), used = new Map<string, Lockout>()) {
    let opened = 0;
    let clock = 1000;
    const deps: EntryDeps = {
        book,
        def: async () => d,
        lockouts: {
            lockout: async (u) => used.get(u) ?? { windowStart: 0, used: 0 },
            trySpend: async (u, now) => {
                await Promise.resolve();
                const l = used.get(u) ?? { windowStart: 0, used: 0 };
                if (!canSpend(l, now)) return { ok: false, waitMs: lockoutWaitMs(l, now), windowStart: l.windowStart };
                const next = spend(l, now);
                used.set(u, next);
                return { ok: true, waitMs: 0, windowStart: next.windowStart };
            },
            refund: async (u, windowStart) => {
                used.set(u, unspend(used.get(u) ?? { windowStart: 0, used: 0 }, windowStart));
            },
        },
        openCopy: async (dd, size) => {
            opened++;
            await Promise.resolve();
            return { key: `${dd.map}~c${opened}`, dungeonId: dd.id, size, entered: [], nodeId: null, openedAt: clock, bossTotal: 0, cleared: false, emptySince: null };
        },
        now: () => clock,
    };
    return { deps, book, used, opened: () => opened };
}
const req = (username: string, party: string[] = [], leader: string | null = null, size?: DungeonSize) =>
    ({ username, party, leader, dungeonId: 1, size });

describe("enterDungeon", () => {
    test("two party members entering at once share one new copy", async () => {
        const s = setup();
        const [a, b] = await Promise.all([enterDungeon(s.deps, req("ann", ["ann", "bob"], "ann")), enterDungeon(s.deps, req("bob", ["ann", "bob"], "ann"))]);
        expect(s.opened()).toBe(1);
        expect(a.kind).toBe("enter");
        expect((a as any).copy.key).toBe((b as any).copy.key);
        expect((await s.deps.book.get((a as any).copy.key))!.entered.sort()).toEqual(["ann", "bob"]);
    });

    test("re-entry does not pay", async () => {
        const s = setup();
        const first = await enterDungeon(s.deps, req("ann"));
        expect((first as any).paid).toBe(true);
        const second = await enterDungeon(s.deps, req("ann"));
        expect(second.kind).toBe("enter");
        expect((second as any).paid).toBe(false);
        expect(s.used.get("ann")!.used).toBe(1);
    });

    test("refusal carries the message", async () => {
        const s = setup();
        s.used.set("ann", { windowStart: 1000, used: 10 });
        const r = await enterDungeon(s.deps, req("ann"));
        expect(r.kind).toBe("refuse");
        expect((r as any).reason).toBe("no_entries");
        expect((r as any).message.startsWith("You have used all 10")).toBe(true);
    });

    test("raid leader gets choose_size, then enters with size 20", async () => {
        const s = setup(def({ type: "raid", sizes: [10, 20] }));
        const r = await enterDungeon(s.deps, req("ann", ["ann"], "ann"));
        expect(r).toEqual({ kind: "choose_size", sizes: [10, 20] });
        const e = await enterDungeon(s.deps, req("ann", ["ann"], "ann", 20));
        expect(e.kind).toBe("enter");
        expect((e as any).copy.size).toBe(20);
    });

    test("a deleted dungeon is refused as disabled for a newcomer", async () => {
        const s = setup(null);
        const r = await enterDungeon(s.deps, req("ann"));
        expect(r.kind).toBe("refuse");
        expect((r as any).reason).toBe("disabled");
        expect((r as any).message).toBe("This dungeon is closed.");
    });

    test("a deleted dungeon still lets a player rejoin their own copy without paying", async () => {
        const s = setup(null);
        await s.book.put({ key: "crypt~x", dungeonId: 1, size: 5, entered: ["ann"], nodeId: null, openedAt: 1, bossTotal: 0, cleared: false, emptySince: null });
        await s.book.put({ key: "crypt~y", dungeonId: 1, size: 5, entered: ["bob"], nodeId: null, openedAt: 1, bossTotal: 0, cleared: false, emptySince: null });
        const a = await enterDungeon(s.deps, req("ann"));
        expect(a.kind).toBe("enter");
        expect((a as any).copy.key).toBe("crypt~x");
        expect((a as any).paid).toBe(false);
        const c = await enterDungeon(s.deps, req("cat", ["cat", "bob"], "bob"));
        expect(c.kind).toBe("refuse");
        expect((c as any).reason).toBe("disabled");
        expect(s.used.size).toBe(0);
        const d = await enterDungeon(s.deps, req("dan"));
        expect((d as any).reason).toBe("disabled");
    });
});

describe("an entry that cannot be let in", () => {
    test("gives back the entry it spent when the copy cannot be opened", async () => {
        const s = setup();
        s.deps.openCopy = async () => { throw new Error("no room"); };
        await expect(enterDungeon(s.deps, req("ann"))).rejects.toThrow("no room");
        expect(s.used.get("ann")!.used).toBe(0);
    });

    test("gives back the entry it spent when the copy cannot be recorded", async () => {
        const s = setup();
        s.deps.book = { ...s.book, put: async () => { throw new Error("store down"); } };
        await expect(enterDungeon(s.deps, req("ann"))).rejects.toThrow("store down");
        expect(s.used.get("ann")!.used).toBe(0);
    });

    test("a refund is only of the window the entry was spent in", () => {
        expect(unspend({ windowStart: 5, used: 3 }, 5)).toEqual({ windowStart: 5, used: 2 });
        expect(unspend({ windowStart: 9, used: 1 }, 5)).toEqual({ windowStart: 9, used: 1 });
        expect(unspend({ windowStart: 5, used: 0 }, 5)).toEqual({ windowStart: 5, used: 0 });
        expect(unspend({ windowStart: 0, used: 0 }, 0)).toEqual({ windowStart: 0, used: 0 });
    });
});

describe("two nodes entering one dungeon at once", () => {
    test("share one copy: the store's lock keeps them one after the other", async () => {
        const store = new MemoryStore();
        const used = new Map<string, Lockout>();
        const nodeA = setup(def(), storeCopyBook(store, () => Promise.resolve()), used);
        const nodeB = setup(def(), storeCopyBook(store, () => Promise.resolve()), used);
        const [a, b] = await Promise.all([
            enterDungeon(nodeA.deps, req("ann", ["ann", "bob"], "ann")),
            enterDungeon(nodeB.deps, req("bob", ["ann", "bob"], "ann")),
        ]);
        expect(nodeA.opened() + nodeB.opened()).toBe(1);
        expect((a as any).copy.key).toBe((b as any).copy.key);
        expect((await nodeA.book.get((a as any).copy.key))!.entered.sort()).toEqual(["ann", "bob"]);
    });

    test("a second node waits while the first holds the dungeon's lock", async () => {
        const store = new MemoryStore();
        const nodeA = storeCopyBook(store, () => Promise.resolve());
        const nodeB = storeCopyBook(store, () => new Promise((done) => setTimeout(done, 1)));
        const order: string[] = [];
        let release!: () => void;
        const held = new Promise<void>((done) => { release = done; });
        const first = nodeA.locked(1, async () => { order.push("a in"); await held; order.push("a out"); });
        await Promise.resolve();
        const second = nodeB.locked(1, async () => { order.push("b in"); });
        await new Promise((done) => setTimeout(done, 20));
        expect(order).toEqual(["a in"]);
        release();
        await Promise.all([first, second]);
        expect(order).toEqual(["a in", "a out", "b in"]);
    });

    test("the lock is given back when the work fails", async () => {
        const book = storeCopyBook(new MemoryStore(), () => Promise.resolve());
        await expect(book.locked(1, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
        expect(await book.locked(1, async () => "free")).toBe("free");
    });
});

describe("storeCopyBook", () => {
    test("round-trips put, list and remove", async () => {
        const book = storeCopyBook(new MemoryStore());
        const c = (key: string, dungeonId: number): CopyRecord => ({ key, dungeonId, size: 5, entered: ["a"], nodeId: "n", openedAt: 5, bossTotal: 1, cleared: false, emptySince: null });
        await book.put(c("crypt~1", 1));
        await book.put(c("crypt~2", 1));
        await book.put(c("keep~1", 2));
        expect((await book.list(1)).map((x) => x.key).sort()).toEqual(["crypt~1", "crypt~2"]);
        expect((await book.all()).length).toBe(3);
        expect((await book.get("keep~1"))!.dungeonId).toBe(2);
        await book.remove("crypt~1");
        expect(await book.get("crypt~1")).toBeNull();
        expect((await book.list(1)).length).toBe(1);
    });
});
