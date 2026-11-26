import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { creatureRadiusFor, VIEW_MARGIN_PX, MAX_CREATURE_RADIUS_PX } from "../systems/creatures/viewradius";

const source = (...parts: string[]) => readFileSync(join(import.meta.dir, "..", ...parts), "utf8");

test("a 1920x1080 view streams creatures out to its corners and a margin past them", () => {
    expect(creatureRadiusFor({ w: 1920, h: 1080 }, 1000)).toBe(Math.ceil(Math.hypot(960, 540)) + VIEW_MARGIN_PX);
});

test("a view bigger than 1920x1080 gets no more than a 1920x1080 view", () => {
    expect(MAX_CREATURE_RADIUS_PX).toBe(Math.ceil(Math.hypot(960, 540)) + VIEW_MARGIN_PX);
    expect(creatureRadiusFor({ w: 2560, h: 1440 }, 1000)).toBe(MAX_CREATURE_RADIUS_PX);
    expect(creatureRadiusFor({ w: 3840, h: 2160 }, 1000)).toBe(MAX_CREATURE_RADIUS_PX);
});

test("a small view keeps the usual radius", () => {
    expect(creatureRadiusFor({ w: 800, h: 600 }, 1000)).toBe(1000);
});

test("a huge view is capped", () => {
    expect(creatureRadiusFor({ w: 100000, h: 100000 }, 1000)).toBe(MAX_CREATURE_RADIUS_PX);
});

test("a view that is not two positive numbers gives no radius", () => {
    for (const bad of [null, undefined, "x", {}, { w: -1, h: 10 }, { w: Number.NaN, h: 10 }, { w: 10, h: "20" }]) {
        expect(creatureRadiusFor(bad, 1000)).toBeNull();
    }
});

test("VIEW_SIZE is a packet type and the session keeps its radius on the connection", () => {
    expect(source("socket", "types.ts")).toContain(`VIEW_SIZE: "VIEW_SIZE"`);
    const session = source("socket", "handlers", "session.ts");
    expect(session).toMatch(/case "VIEW_SIZE": \{[\s\S]*?wt\.data\.creatureRadius = creatureRadiusFor\(data, /);
});

test("creature sync uses the connection's radius before the AOI radius", () => {
    expect(source("systems", "creatures", "index.ts")).toMatch(/radius: p\.wt\.data\?\.creatureRadius \|\| p\.aoi\?\.aoiRadius/);
});
