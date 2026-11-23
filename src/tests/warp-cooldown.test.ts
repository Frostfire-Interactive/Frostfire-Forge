import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WARP_COOLDOWN_MS, WARP_NOTICE_MS, setWarpReadyIn, warpCooldownNotice, warpReadyIn, warpWait } from "../systems/warpcooldown";

describe("the warp cooldown", () => {
    test("is 3 seconds", () => {
        expect(WARP_COOLDOWN_MS).toBe(3000);
    });

    test("counts down from when it was set, by any case of the name, and ends at 0", () => {
        try {
            setWarpReadyIn("Wanda", WARP_COOLDOWN_MS, 1000);
            expect(warpReadyIn("wanda", 1000)).toBe(3000);
            expect(warpReadyIn("WANDA", 2500)).toBe(1500);
            expect(warpReadyIn("wanda", 4000)).toBe(0);
        } finally {
            setWarpReadyIn("wanda", 0);
        }
    });

    test("is at most a full cooldown, and 0 or less ends it", () => {
        setWarpReadyIn("wanda", 9e9, 1000);
        expect(warpReadyIn("wanda", 1000)).toBe(WARP_COOLDOWN_MS);
        setWarpReadyIn("wanda", 0, 1000);
        expect(warpReadyIn("wanda", 1000)).toBe(0);
        setWarpReadyIn("wanda", 2000, 1000);
        setWarpReadyIn("wanda", -5, 1000);
        expect(warpReadyIn("wanda", 1000)).toBe(0);
    });

    test("tells how many whole seconds are left", () => {
        expect(warpCooldownNotice(2500)).toBe("You can warp again in 3 seconds.");
        expect(warpCooldownNotice(800)).toBe("You can warp again in 1 second.");
    });

    test("a warp during it waits, with the notice at most once a second", () => {
        const p: any = { username: "wanda" };
        try {
            expect(warpWait(p, 1000)).toEqual({ wait: false });
            setWarpReadyIn("wanda", WARP_COOLDOWN_MS, 1000);
            expect(warpWait(p, 1000)).toEqual({ wait: true, notice: "You can warp again in 3 seconds." });
            expect(warpWait(p, 1000 + WARP_NOTICE_MS - 1)).toEqual({ wait: true, notice: null });
            expect(warpWait(p, 1000 + WARP_NOTICE_MS)).toEqual({ wait: true, notice: "You can warp again in 2 seconds." });
            expect(warpWait(p, 1000 + WARP_COOLDOWN_MS)).toEqual({ wait: false });
        } finally {
            setWarpReadyIn("wanda", 0);
        }
    });
});

describe("a map warp", () => {
    const movement = readFileSync(join(import.meta.dir, "..", "socket", "handlers", "movement.ts"), "utf8");
    const start = movement.indexOf(`if (reason === "warp_collision" && collision?.warp) {`);
    const block = movement.slice(start, movement.indexOf("dungeonPortalStep(", start));

    test("to another map waits out the cooldown before anything else takes the warp", () => {
        expect(start).toBeGreaterThan(0);
        const wait = block.indexOf("warpWait(currentPlayer)");
        expect(wait).toBeGreaterThan(0);
        expect(wait).toBeLessThan(block.indexOf("for (const interceptor of warpInterceptors)"));
        expect(block).toContain("const otherMap = withoutJson(warp.map) !== withoutJson(currentPlayer.location.map);");
        expect(block).toMatch(/if \(otherMap\) \{\s*const waiting = warpWait\(currentPlayer\);/);
    });

    test("to another map starts the cooldown before the move, so a move to another node takes it along", () => {
        const set = block.indexOf("if (otherMap) setWarpReadyIn(currentPlayer.username, WARP_COOLDOWN_MS);");
        expect(set).toBeGreaterThan(0);
        expect(set).toBeLessThan(block.indexOf("await transitionPlayerToMap(currentPlayer, newMap"));
        expect(set).toBeGreaterThan(block.indexOf("if (arrived) {"));
    });
});
