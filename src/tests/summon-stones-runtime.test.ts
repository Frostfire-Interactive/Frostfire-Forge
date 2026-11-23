import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import playerCache from "../services/playermanager";
import { summonClaims } from "../cluster/summonclaims";
import { invitations } from "../cluster/invitations";
import { castingSummon, io, resetSummonSessions, startSummonCast, summonSessionsHeld, tickSessions, touchStone } from "../socket/summonstones";

// The summoning stone runtime driven with fake players, the in-process claims and a fake socket layer.

const realNow = Date.now;
const realIo = { ...io };
let now = 1_000_000;
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };

type Sent = { to: string; message: string };
let said: Sent[] = [];
let casts: Array<{ username: string; args: any }> = [];
let offers: any[] = [];
let checkAnswer: () => unknown = () => ({ ok: true });
let offerAnswer: () => Promise<unknown> = async () => ({ ok: true });
let added: string[] = [];

const stones = [
    { name: "A", position: { x: 100, y: 100 }, glowColor: "#66ccff", layer: null },
    { name: "B", position: { x: 500, y: 500 }, glowColor: "#66ccff", layer: null },
];

beforeEach(() => {
    now = 1_000_000;
    Date.now = () => now;
    said = []; casts = []; offers = []; added = [];
    checkAnswer = () => ({ ok: true });
    offerAnswer = async () => ({ ok: true });
    io.deliverToPlayer = (async (to: string, packets: any[]) => { said.push({ to: to.toLowerCase(), message: packets?.[0]?.d?.message ?? JSON.stringify(packets?.[0]) }); return true; }) as any;
    io.runOnPlayer = (async (username: string, _action: string, args: any) => { casts.push({ username, args }); return true; }) as any;
    io.askPlayer = (async (_to: string, _action: string, args: any) => {
        if (args.step === "check") return { status: "answered", value: checkAnswer() };
        offers.push(args);
        return { status: "answered", value: await offerAnswer() };
    }) as any;
    io.socket = (async () => ({
        packetManager: {
            notify: (d: any) => [{ t: "notify", d }],
            castSpell: (d: any) => [{ t: "cast", d }],
        },
        sendPacket: (wt: any, packets: any[]) => { wt.sent.push(...packets); },
        stonesOn: (map: string) => (map === "town.json" ? stones : null),
        offerInvitation: async () => true,
    })) as any;
});

afterEach(() => {
    Date.now = realNow;
    Object.assign(io, realIo);
    resetSummonSessions();
    (summonClaims as any).held.clear();
    for (const id of added) playerCache.remove(id);
});

/** A party of three: summoner and helper at the stone, the target far away. */
function party(tag: string, at: { x: number; y: number }) {
    const names = [`sum${tag}`, `hel${tag}`, `cat${tag}`];
    const make = (username: string, x: number, y: number) => {
        const p: any = { id: `id-${username}`, username, isDead: false, party: names, location: { map: "town.json", position: { x, y } }, wt: { sent: [] as any[] } };
        playerCache.add(p.id, p);
        added.push(p.id);
        return p;
    };
    return { summoner: make(names[0]!, at.x, at.y), helper: make(names[1]!, at.x + 10, at.y), target: make(names[2]!, 2000, 2000), names };
}

const said1 = (to: string) => said.filter((s) => s.to === to).map((s) => s.message);
const claimed = async (stone: string, target: string) => (await summonClaims.claim(`town/${stone}`, target, "probe")) !== "ok";
const free = async (stone: string, target: string) => {
    const ok = (await summonClaims.claim(`town/${stone}`, target, "probe")) === "ok";
    await summonClaims.release(`town/${stone}`, target, "probe");
    return ok;
};

async function toWaiting(p: ReturnType<typeof party>, stone: string) {
    await touchStone(p.summoner, { name: stone, target: p.target.username });
}
async function toCasting(p: ReturnType<typeof party>, stone: string) {
    await toWaiting(p, stone);
    await touchStone(p.helper, { name: stone });
}
async function toPrompting(p: ReturnType<typeof party>, stone: string) {
    await toCasting(p, stone);
    now += 5_000;
    await tickSessions();
    await flush();
}

describe("claims are released on every end", () => {
    test("a touch with a party member targeted takes the stone and the target", async () => {
        const p = party("1", { x: 100, y: 100 });
        await toWaiting(p, "A");
        expect(await claimed("A", "other")).toBe(true);
        expect(await claimed("B", p.target.username)).toBe(true);
    });
    test("the target is matched without regard to case", async () => {
        const p = party("1b", { x: 100, y: 100 });
        await touchStone(p.summoner, { name: "A", target: p.target.username.toUpperCase() });
        expect(summonSessionsHeld()).toBe(1);
        expect(await claimed("A", p.target.username)).toBe(true);
    });
    test("lapse: nobody helped in time, and the summoner's bar just goes (nothing interrupted it)", async () => {
        const p = party("2", { x: 100, y: 100 });
        await toWaiting(p, "A");
        now += 31_000;
        await tickSessions();
        expect(summonSessionsHeld()).toBe(0);
        expect(await free("A", p.target.username)).toBe(true);
        expect(said1(p.summoner.username)).toContain("Nobody else touched the summoning stone in time.");
        expect(casts.at(-1)).toEqual({ username: p.summoner.username, args: { spell: "Summoning", time: 0 } });
        expect(casts.some((c) => c.args.spell === "interrupted")).toBe(false);
    });
    test("cancel: the helper walks away from the stone", async () => {
        const p = party("3", { x: 100, y: 100 });
        await toCasting(p, "A");
        p.helper.location.position.x = 1500;
        await tickSessions();
        await flush();
        expect(summonSessionsHeld()).toBe(0);
        expect(await free("A", p.target.username)).toBe(true);
        expect(casts.some((c) => c.args.spell === "interrupted")).toBe(true);
    });
    test("the prompt is made after the cast, and ends when the target has answered (claims released)", async () => {
        const p = party("4", { x: 100, y: 100 });
        await toPrompting(p, "A");
        expect(offers).toHaveLength(1);
        expect(offers[0].summon).toEqual({ map: "town.json", x: 100, y: 100, stone: "A" });
        expect(summonSessionsHeld()).toBe(1);
        // what the INVITATION_RESPONSE branch does on accept or decline
        await summonClaims.release("town/A", p.target.username, p.summoner.username);
        await tickSessions();
        expect(summonSessionsHeld()).toBe(0);
        expect(await free("A", p.target.username)).toBe(true);
    });
    test("prompt timeout: the session ends, claims are freed and its invitation is taken", async () => {
        const p = party("5", { x: 100, y: 100 });
        await toPrompting(p, "A");
        const authorization = offers[0].authorization;
        await invitations.add({ action: "SUMMON_STONE", originator: p.summoner.id, originatorName: p.summoner.username, authorization, target: p.target.username });
        now += 61_000;
        await tickSessions();
        expect(summonSessionsHeld()).toBe(0);
        expect(await free("A", p.target.username)).toBe(true);
        expect(await invitations.take(authorization)).toBeNull();
    });
});

describe("the tick works on the sessions as they are", () => {
    test("a helper's touch made while the tick waits is not undone by a stale waiting session", async () => {
        const a = party("A", { x: 100, y: 100 });
        const b = party("B", { x: 500, y: 500 });
        await toCasting(a, "A");
        await toWaiting(b, "B");
        now += 5_000;
        await tickSessions();
        await flush();
        expect(summonSessionsHeld()).toBe(2); // A prompting, B waiting (until 30 s after its touch)

        // The next tick stops at A's claim read; B's helper touches meanwhile, just before its waiting time ends.
        let release!: (busy: boolean) => void;
        const real = summonClaims.targetBusy.bind(summonClaims);
        let first = true;
        const spy = spyOn(summonClaims, "targetBusy").mockImplementation((t: string) => {
            if (!first) return real(t);
            first = false;
            return new Promise<boolean>((resolve) => { release = resolve; });
        });
        const ticking = tickSessions();
        now += 24_000;
        await touchStone(b.helper, { name: "B" });
        now += 2_000; // past the old waiting time, inside the cast
        release(false);
        await ticking;
        await flush();
        spy.mockRestore();
        expect(summonSessionsHeld()).toBe(1);
        expect(await claimed("B", b.target.username)).toBe(true);
    });
    test("a slow offer to another node does not hold up the tick", async () => {
        const p = party("6", { x: 100, y: 100 });
        await toCasting(p, "A");
        offerAnswer = () => new Promise(() => {});
        now += 5_000;
        const result = await Promise.race([tickSessions().then(() => "done"), new Promise((r) => setTimeout(() => r("stuck"), 500))]);
        expect(result).toBe("done");
    });
});

describe("an answer that makes no sense is a target not reached", () => {
    test("a null answer to the offer ends the session, frees the claims and tells the summoner", async () => {
        const p = party("7", { x: 100, y: 100 });
        offerAnswer = async () => null;
        await toPrompting(p, "A");
        expect(summonSessionsHeld()).toBe(0);
        expect(await free("A", p.target.username)).toBe(true);
        expect(said1(p.summoner.username)).toContain("Cat7 is not online.");
    });
    test("a null answer to the check refuses the touch, starts nothing and takes no claim", async () => {
        const p = party("8", { x: 100, y: 100 });
        checkAnswer = () => null;
        await toWaiting(p, "A");
        await flush();
        expect(said1(p.summoner.username)).toContain("Cat8 is not online.");
        expect(await free("A", p.target.username)).toBe(true);
        expect(summonSessionsHeld()).toBe(0);
        expect(casts).toEqual([]);
    });
});

describe("the summoner always knows the outcome", () => {
    test("the touch shows the summoner a 30 s Summoning cast; the helper's touch shows both the 5 s cast", async () => {
        const p = party("b1", { x: 100, y: 100 });
        await toWaiting(p, "A");
        await flush();
        expect(casts).toEqual([{ username: p.summoner.username, args: { spell: "Summoning", time: 30 } }]);
        await touchStone(p.helper, { name: "A" });
        await flush();
        expect(casts.slice(1)).toEqual([
            { username: p.summoner.username, args: { spell: "Summoning", time: 5 } },
            { username: p.helper.username, args: { spell: "Summoning", time: 5 } },
        ]);
    });

    test("a touch with nobody targeted is told so and starts nothing", async () => {
        const p = party("n1", { x: 100, y: 100 });
        await touchStone(p.summoner, { name: "A" });
        await flush();
        expect(said1(p.summoner.username)).toContain("Target a party member to summon.");
        expect(summonSessionsHeld()).toBe(0);
    });

    test("prompt timeout: the summoner is told the target did not answer", async () => {
        const p = party("t1", { x: 100, y: 100 });
        await toPrompting(p, "A");
        now += 61_000;
        await tickSessions();
        await flush();
        expect(summonSessionsHeld()).toBe(0);
        expect(said1(p.summoner.username)).toContain("Catt1 did not answer.");
    });

    test("a second touch while the first is being asked is ignored quietly", async () => {
        const p = party("d1", { x: 100, y: 100 });
        await Promise.all([toWaiting(p, "A"), toWaiting(p, "A")]);
        await flush();
        expect(said1(p.summoner.username)).not.toContain("This summoning stone is already in use.");
        expect(said1(p.summoner.username).filter((m) => m === "Waiting for another party member to touch the stone.")).toHaveLength(1);
        expect(await claimed("A", p.target.username)).toBe(true);
    });
});

describe("the summon cast", () => {
    test("a walking player cannot start the summon or the cast", async () => {
        const p = party("w1", { x: 100, y: 100 });
        p.summoner.moving = true;
        await toWaiting(p, "A");
        await flush();
        expect(said1(p.summoner.username)).toEqual(["You must stand still to use that."]);
        expect(summonSessionsHeld()).toBe(0);
        p.summoner.moving = false;
        await toWaiting(p, "A");
        p.helper.moving = true;
        await touchStone(p.helper, { name: "A" });
        await flush();
        expect(said1(p.helper.username)).toEqual(["You must stand still to use that."]);
        expect(casts).toEqual([{ username: p.summoner.username, args: { spell: "Summoning", time: 30 } }]);
    });

    test("the touchers are in the summon cast from the start; Esc on it ends the summon", async () => {
        const p = party("w3", { x: 100, y: 100 });
        await toCasting(p, "A");
        expect(castingSummon(p.summoner)).toBe(true);
        expect(castingSummon(p.helper)).toBe(true);
        p.helper.castId += 1; // CANCEL_SPELL moves the cast on
        p.helper.casting = false;
        now += 1_000;
        await tickSessions();
        await flush();
        expect(summonSessionsHeld()).toBe(0);
        expect(said1(p.summoner.username)).toContain("The summon was cancelled.");
    });

    test("a player in another cast cannot start one", async () => {
        const p = party("w2", { x: 100, y: 100 });
        p.summoner.casting = true;
        await toWaiting(p, "A");
        await flush();
        expect(summonSessionsHeld()).toBe(0);
        expect(casts).toEqual([]);
    });

    test("the cast is one a step breaks, cast on the spot; starting it again keeps it", () => {
        const p: any = { id: "x", castId: 4 };
        startSummonCast(p);
        expect(p).toMatchObject({ casting: true, castOnSelf: true, interruptableSpell: true, castId: 5, summonCastId: 5, mounted: false });
        expect(castingSummon(p)).toBe(true);
        startSummonCast(p);
        expect(p.castId).toBe(5);
        p.castId = 6; // broken (interruptPlayerCast moves the cast on)
        expect(castingSummon(p)).toBe(false);
    });
});
