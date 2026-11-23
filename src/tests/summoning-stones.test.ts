import { describe, expect, test } from "bun:test";
import { DEFAULT_GLOW, cleanStones, glowColorOf, loadedMapObjects, readStoneObject, stonesFrom } from "../systems/mapobjects";

// Summoning stones as map objects (systems/mapobjects.ts): read from a Tiled point, kept in the map file as a
// `summoningStones` list, and checked before a save.

describe("stone objects", () => {
    test("reads a Tiled summoning_stone point with its glow colour and layer", () => {
        const stone = readStoneObject({ name: "Stone", type: "summoning_stone", x: 100.7, y: 200.2, properties: [{ name: "glow_color", value: "#FF0000" }] }, "Summoning Stones");
        expect(stone).toEqual({ name: "Stone", position: { x: 100, y: 200 }, glowColor: "#ff0000", layer: "Summoning Stones" });
    });

    test("a stone with no or a bad glow colour glows #66ccff", () => {
        expect(DEFAULT_GLOW).toBe("#66ccff");
        expect(stonesFrom([{ name: "A", position: { x: 1, y: 2 } }])[0]!.glowColor).toBe("#66ccff");
        expect(stonesFrom([{ name: "A", position: { x: 1, y: 2 }, glowColor: "blue" }])[0]!.glowColor).toBe("#66ccff");
        expect(readStoneObject({ name: "B", type: "summoning_stone", x: 1, y: 2 }, null)!.glowColor).toBe("#66ccff");
        expect(glowColorOf("#AbCdEf")).toBe("#abcdef");
        expect(glowColorOf("#abc")).toBeNull();
        expect(glowColorOf(42)).toBeNull();
    });

    test("stonesFrom accepts a list or one keyed by name", () => {
        const keyed = stonesFrom({ A: { position: { x: 1, y: 2 } } });
        expect(keyed[0]!.name).toBe("A");
        expect(keyed[0]!.position).toEqual({ x: 1, y: 2 });
        expect(stonesFrom([{ name: "B", position: { x: 3, y: 4 }, glowColor: "#00FF00", layer: "L" }])).toEqual([
            { name: "B", position: { x: 3, y: 4 }, glowColor: "#00ff00", layer: "L" },
        ]);
        expect(stonesFrom(null)).toEqual([]);
        expect(stonesFrom([{ name: "C" }])).toEqual([]);
    });

    test("cleanStones refuses duplicate names, a missing position and a bad glow colour", () => {
        const one = { name: "S", position: { x: 5, y: 6 }, glowColor: "#66ccff" };
        expect("error" in cleanStones([one, { ...one }])).toBe(true);
        expect("error" in cleanStones([{ name: "S", glowColor: "#66ccff" }])).toBe(true);
        expect("error" in cleanStones([{ ...one, glowColor: "blue" }])).toBe(true);
        expect("error" in cleanStones("not a list")).toBe(true);
        expect(cleanStones([{ ...one, name: " S ", glowColor: "#66CCFF", layer: "Summoning Stones" }])).toEqual({
            stones: [{ name: "S", position: { x: 5, y: 6 }, glowColor: "#66ccff", layer: "Summoning Stones" }],
        });
    });

    test("loadedMapObjects keeps the Tiled layer of a saved stone", () => {
        const tiled = readStoneObject({ name: "Stone", type: "summoning_stone", x: 10, y: 20 }, "Summoning Stones")!;
        const saved = { name: "Stone", position: { x: 30, y: 40 }, glowColor: "#ff0000", layer: null };
        const loaded = loadedMapObjects("SummoningStone", [tiled], [saved])!;
        expect(loaded[0]!.layer).toBe("Summoning Stones");
        expect(loaded[0]!.position).toEqual({ x: 30, y: 40 });
    });
});
