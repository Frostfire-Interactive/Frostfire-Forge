import { describe, expect, test } from "bun:test";
import { packetManager } from "../socket/packet_manager";

const decode = (packets: any[]) => JSON.parse(new TextDecoder().decode(packets[0]));

describe("map names in weather and player list packets", () => {
    test("a copy key is sent as its template name", () => {
        expect(decode(packetManager.lightning({ x: 1, y: 2, map: "vault~k3x9" })).data).toEqual({ x: 1, y: 2, map: "vault" });
        expect(decode(packetManager.tornadoes({ map: "vault~k3x9", tornadoes: [] })).data).toEqual({ map: "vault", tornadoes: [] });
        expect(decode(packetManager.onlinePlayersList([{ username: "ann", map: "vault~k3x9", isAdmin: false }, { username: "bob", map: "town", isAdmin: true }])).data)
            .toEqual([{ username: "ann", map: "vault", isAdmin: false }, { username: "bob", map: "town", isAdmin: true }]);
    });
});

describe("a dungeon save reaches every player's portals", () => {
    test("DUNGEON_PORTALS_CHANGED carries no data", () => {
        expect(decode(packetManager.dungeonPortalsChanged())).toEqual({ type: "DUNGEON_PORTALS_CHANGED", data: {} });
    });

    test("a changed dungeon is told to every player here and to the other nodes", async () => {
        const editors = await Bun.file(new URL("../socket/handlers/editors.ts", import.meta.url)).text();
        const here = editors.match(/function dungeonPortalsChangedHere\(\)[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? "";
        expect(here).toContain("packetManager.dungeonPortalsChanged()");
        expect(here).toContain("playerCache.list()");
        expect(here).not.toContain("mayHaveOpen");
        expect(editors).toMatch(/onPeerNews\("dungeon-portals",[^\n]*dungeonPortalsChangedHere\(\)/);
        const save = editors.slice(editors.indexOf('case "DUNGEON_EDITOR_DELETE": {'));
        const from = save.slice(save.indexOf("if (result.changed)"));
        const changed = from.slice(0, from.indexOf("break;"));
        expect(changed).toContain("dungeonPortalsChangedHere()");
        expect(changed).toContain('tellPeers("dungeon-portals"');
    });
});
