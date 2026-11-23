import { beforeEach, describe, expect, mock, test } from "bun:test";
import { characterDatabaseModule } from "./setup";

// Dungeons and raids: the definitions store (systems/dungeons/definitions.ts) and the editor (systems/dungeoneditor.ts).

type Row = Record<string, any>;
let tables: { dungeons: Row[]; permissions: Row[] };
let nextId: number;

function run(sql: string, params: any[] = []): any {
  const text = sql.replace(/\s+/g, " ").trim();
  if (text === "SELECT permissions FROM permissions WHERE username = ?") return tables.permissions.filter((r) => r.username === params[0]);
  if (text === "SELECT * FROM dungeons") return tables.dungeons.map((r) => ({ ...r }));
  if (text.startsWith("INSERT INTO dungeons")) {
    const columns = text.match(/\((.+?)\) VALUES/)![1]!.split(", ");
    const row: Row = { id: nextId++ };
    columns.forEach((c, i) => { row[c] = params[i]; });
    tables.dungeons.push(row);
    return { lastInsertRowid: row.id, affectedRows: 1 };
  }
  if (text.startsWith("UPDATE dungeons SET")) {
    const columns = text.match(/SET (.+) WHERE/)![1]!.split(", ").map((p) => p.replace(" = ?", ""));
    const id = params[params.length - 1];
    for (const row of tables.dungeons.filter((r) => r.id === id)) columns.forEach((c, i) => { row[c] = params[i]; });
    return { affectedRows: 1 };
  }
  if (text === "DELETE FROM dungeons WHERE id = ?") {
    tables.dungeons = tables.dungeons.filter((r) => r.id !== params[0]);
    return { affectedRows: 1 };
  }
  if (text.startsWith("SELECT")) return [];
  throw new Error(`The fake database does not understand: ${text}`);
}

mock.module("../controllers/sqldatabase", () => characterDatabaseModule({
  default: async (sql: string, params: any[] = []) => run(sql, params),
}));

const cache = new Map<string, any>();
mock.module("../services/assetCache", () => ({
  default: {
    onChange: () => () => {},
    get: async (key: string) => cache.get(key),
    set: async (key: string, value: any) => cache.set(key, value),
    add: async (key: string, value: any) => cache.set(key, value),
  },
}));

const { clearCaches } = await import("../services/datacache");
const { DEFAULT_MULTIPLIERS } = await import("../systems/dungeons/types");
const { dungeonDefs } = await import("../systems/dungeons/definitions");
const editor = await import("../systems/dungeoneditor");

const maps = [{ name: "crypt", widthPx: 2048, heightPx: 2048 }, { name: "vault", widthPx: 8192, heightPx: 4096 }];
const ok: any = { id: null, name: "Crypt", map: "crypt", type: "dungeon", sizes: [5], multipliers: DEFAULT_MULTIPLIERS, entranceX: 64, entranceY: 64, enabled: true };
const ctx = { maps, dungeons: [] as any[] };
const fields = (errors: Array<{ field: string }>) => errors.map((e) => e.field);

const ADMIN = { id: "c-1", username: "boss", isGuest: false, isAdmin: true, permissions: [] };
const BUILDER = { id: "c-2", username: "builder", isGuest: false, permissions: ["tools.dungeon_editor"] };
const PLAYER = { id: "c-3", username: "pleb", isGuest: false, permissions: [] };

beforeEach(async () => {
  tables = { dungeons: [], permissions: [{ username: "builder", permissions: "tools.dungeon_editor" }] };
  nextId = 1;
  cache.set("mapProperties", [
    { name: "crypt.json", width: 64, height: 64, tileWidth: 32, tileHeight: 32 },
    { name: "crypt~a1.json", width: 64, height: 64, tileWidth: 32, tileHeight: 32 },
    { name: "vault.json", width: 256, height: 128, tileWidth: 32, tileHeight: 32 },
  ]);
  await clearCaches();
});

describe("validateDungeon", () => {
  test("accepts a sane dungeon and a raid", () => {
    expect(editor.validateDungeon(ok, ctx)).toEqual([]);
    expect(editor.validateDungeon({ ...ok, type: "raid", map: "vault", sizes: [10, 20] }, ctx)).toEqual([]);
  });

  test("the map must exist and be used by one dungeon only", () => {
    expect(fields(editor.validateDungeon({ ...ok, map: "nowhere" }, ctx))).toContain("map");
    expect(fields(editor.validateDungeon(ok, { maps, dungeons: [{ ...ok, id: 3, name: "Other" }] }))).toContain("map");
    // editing the dungeon that owns the map is fine
    expect(editor.validateDungeon({ ...ok, id: 3 }, { maps, dungeons: [{ ...ok, id: 3 }] })).toEqual([]);
  });

  test("sizes follow the type", () => {
    expect(fields(editor.validateDungeon({ ...ok, sizes: [10] }, ctx))).toContain("sizes");
    expect(fields(editor.validateDungeon({ ...ok, type: "raid", sizes: [] }, ctx))).toContain("sizes");
    expect(fields(editor.validateDungeon({ ...ok, type: "raid", sizes: [5] }, ctx))).toContain("sizes");
    expect(fields(editor.validateDungeon({ ...ok, type: "party" }, ctx))).toContain("type");
  });

  test("the entrance lies inside the map", () => {
    expect(fields(editor.validateDungeon({ ...ok, entranceX: 2048 }, ctx))).toContain("entranceX");
    expect(fields(editor.validateDungeon({ ...ok, entranceY: -1 }, ctx))).toContain("entranceY");
    expect(fields(editor.validateDungeon({ ...ok, entranceX: 1.5 }, ctx))).toContain("entranceX");
    expect(editor.validateDungeon({ ...ok, entranceX: 2047, entranceY: 2047 }, ctx)).toEqual([]);
  });

  test("multipliers are checked for each allowed size", () => {
    expect(fields(editor.validateDungeon({ ...ok, multipliers: { ...DEFAULT_MULTIPLIERS, "5": { health: 0, damage: 1 } } }, ctx))).toContain("multipliers.5.health");
    expect(fields(editor.validateDungeon({ ...ok, multipliers: { ...DEFAULT_MULTIPLIERS, "5": { health: 1, damage: 101 } } }, ctx))).toContain("multipliers.5.damage");
    // a size the dungeon does not have is not checked
    expect(editor.validateDungeon({ ...ok, multipliers: { ...DEFAULT_MULTIPLIERS, "20": { health: 0, damage: 0 } } }, ctx)).toEqual([]);
    expect(fields(editor.validateDungeon({ ...ok, type: "raid", map: "vault", sizes: [20], multipliers: { ...DEFAULT_MULTIPLIERS, "20": { health: NaN, damage: 1 } } }, ctx))).toContain("multipliers.20.health");
  });

  test("the name is 1 to 48 characters and unique", () => {
    expect(fields(editor.validateDungeon({ ...ok, name: " " }, ctx))).toContain("name");
    expect(fields(editor.validateDungeon({ ...ok, name: "x".repeat(49) }, ctx))).toContain("name");
    expect(fields(editor.validateDungeon(ok, { maps, dungeons: [{ ...ok, id: 3, map: "vault" }] }))).toContain("name");
  });

  test("the portal colour is a #rrggbb code or none", () => {
    expect(editor.validateDungeon({ ...ok, portalColor: "#12ab9F" }, ctx)).toEqual([]);
    expect(editor.validateDungeon({ ...ok, portalColor: null }, ctx)).toEqual([]);
    expect(editor.validateDungeon(ok, ctx)).toEqual([]);
    expect(fields(editor.validateDungeon({ ...ok, portalColor: "blue" }, ctx))).toContain("portalColor");
    expect(fields(editor.validateDungeon({ ...ok, portalColor: "#12345" }, ctx))).toContain("portalColor");
    expect(fields(editor.validateDungeon({ ...ok, portalColor: 255 }, ctx))).toContain("portalColor");
  });

  test("enabled is a boolean", () => {
    expect(fields(editor.validateDungeon({ ...ok, enabled: "yes" }, ctx))).toContain("enabled");
  });
});

describe("permissions", () => {
  test("admins and holders of tools.dungeon_editor pass", async () => {
    expect(await editor.canUseEditor(null)).toBe(false);
    expect(await editor.canUseEditor({ ...ADMIN, isGuest: true })).toBe(false);
    expect(await editor.canUseEditor(PLAYER)).toBe(false);
    expect(await editor.canUseEditor(ADMIN)).toBe(true);
    expect(await editor.canUseEditor(BUILDER)).toBe(true);
    expect(editor.mayHaveEditorOpen(BUILDER)).toBe(true);
    expect(editor.mayHaveEditorOpen(PLAYER)).toBe(false);
  });

  test("a player without the permission is refused", async () => {
    const result = await editor.handleEditorPacket(PLAYER, "DUNGEON_EDITOR_LIST", {});
    expect(result.kind).toBe("result");
    expect((result as any).denied).toBe(true);
  });
});

describe("buildEditorData", () => {
  test("maps are bare names with pixel sizes and leave out copies", async () => {
    const data = await editor.buildEditorData();
    expect(data.maps).toEqual([{ name: "crypt", widthPx: 2048, heightPx: 2048 }, { name: "vault", widthPx: 8192, heightPx: 4096 }]);
    expect(data.maps.some((m) => m.name.includes("~"))).toBe(false);
    expect(data.defaults).toEqual(DEFAULT_MULTIPLIERS);
    expect(data.nameMax).toBe(48);
  });
});

describe("saving", () => {
  test("create, list, update and delete through the packets", async () => {
    const created: any = await editor.handleEditorPacket(ADMIN, "DUNGEON_EDITOR_SAVE", ok);
    expect(created.errors).toEqual([]);
    expect(created.changed).toBe(true);
    expect(created.data.dungeons).toHaveLength(1);
    const id = created.data.dungeons[0].id;
    expect(created.id).toBe(id);
    expect(created.data.dungeons[0]).toMatchObject({ name: "Crypt", map: "crypt", type: "dungeon", sizes: [5], entranceX: 64, enabled: true });
    expect(await dungeonDefs.byMap("crypt")).toMatchObject({ id, name: "Crypt" });
    expect(tables.dungeons[0]!.sizes).toBe("5");

    const listed: any = await editor.handleEditorPacket(ADMIN, "DUNGEON_EDITOR_LIST", {});
    expect(listed.kind).toBe("data");
    expect(listed.data.dungeons).toHaveLength(1);

    const updated: any = await editor.handleEditorPacket(BUILDER, "DUNGEON_EDITOR_SAVE", { ...ok, id, name: "Deep Crypt", enabled: false });
    expect(updated.errors).toEqual([]);
    expect(updated.id).toBe(id);
    expect((await dungeonDefs.get(id))).toMatchObject({ name: "Deep Crypt", enabled: false });

    const clash: any = await editor.handleEditorPacket(ADMIN, "DUNGEON_EDITOR_SAVE", { ...ok, name: "Other" });
    expect(clash.ok).toBe(false);
    expect(clash.fields.map).toBeTruthy();

    const gone: any = await editor.handleEditorPacket(ADMIN, "DUNGEON_EDITOR_SAVE", { ...ok, id: 99, map: "vault", name: "Ghost" });
    expect(gone.ok).toBe(false);
    expect(gone.id).toBeUndefined();

    const deleted: any = await editor.handleEditorPacket(ADMIN, "DUNGEON_EDITOR_DELETE", { id });
    expect(deleted.errors).toEqual([]);
    expect(deleted.data.dungeons).toEqual([]);
    expect(await dungeonDefs.remove(id)).toBe(false);
  });

  test("a raid keeps its sizes and multipliers through a round trip", async () => {
    const saved: any = await editor.handleEditorPacket(ADMIN, "DUNGEON_EDITOR_SAVE", { ...ok, name: "Vault", type: "raid", map: "vault", sizes: [20, 10] });
    expect(saved.errors).toEqual([]);
    expect(tables.dungeons[0]!.sizes).toBe("10,20");
    const def = await dungeonDefs.byMap("vault");
    expect(def!.sizes).toEqual([10, 20]);
    expect(def!.multipliers["20"]).toEqual({ health: 4, damage: 2 });
  });

  test("the portal colour is kept in lower case, and none stays none", async () => {
    const custom: any = await editor.handleEditorPacket(ADMIN, "DUNGEON_EDITOR_SAVE", { ...ok, portalColor: "#FF8A3D" });
    expect(custom.errors).toEqual([]);
    expect(tables.dungeons[0]!.portal_color).toBe("#ff8a3d");
    expect((await dungeonDefs.byMap("crypt"))!.portalColor).toBe("#ff8a3d");
    const plain: any = await editor.handleEditorPacket(ADMIN, "DUNGEON_EDITOR_SAVE", { ...ok, name: "Vault", type: "raid", map: "vault", sizes: [10] });
    expect(plain.errors).toEqual([]);
    expect(tables.dungeons[1]!.portal_color).toBeNull();
    expect((await dungeonDefs.byMap("vault"))!.portalColor).toBeNull();
  });
});

describe("entrance portal", () => {
  const portal = (name: string, dungeonId: number | null, kind = "dungeon") => ({
    name, kind, dungeonId, mirror: true, target: kind === "teleport" ? { map: "vault", x: 1, y: 1 } : null,
    position: { x: 0, y: 0 }, size: { width: 32, height: 32 }, layer: null,
  });
  test("the editor lists dungeon portals; a save links the picked one and unlinks the dungeon's others; a delete unlinks", async () => {
    const { setPortalWriter } = await import("../systems/portaleditor");
    const writes: Array<{ map: string; portals: any[] }> = [];
    setPortalWriter(async (map, portals) => {
      writes.push({ map, portals });
      const props = cache.get("mapProperties").find((m: any) => m.name === `${map}.json`);
      props.dungeonPortals = portals;
    });
    cache.get("mapProperties")[2].dungeonPortals = [portal("Gate", null), portal("Old", null), portal("Jump", null, "teleport")];
    try {
      const listed: any = await editor.handleEditorPacket(ADMIN, "DUNGEON_EDITOR_LIST", {});
      expect(listed.data.portals).toEqual([{ map: "vault", name: "Gate", dungeonId: null }, { map: "vault", name: "Old", dungeonId: null }]);

      const created: any = await editor.handleEditorPacket(ADMIN, "DUNGEON_EDITOR_SAVE", { ...ok, portal: { map: "vault", name: "Old" } });
      expect(created.errors).toEqual([]);
      const linked: any = await editor.handleEditorPacket(ADMIN, "DUNGEON_EDITOR_SAVE", { ...ok, id: created.id, portal: { map: "vault", name: "Gate" } });
      expect(linked.errors).toEqual([]);
      expect(linked.data.portals).toEqual([{ map: "vault", name: "Gate", dungeonId: created.id }, { map: "vault", name: "Old", dungeonId: null }]);

      const teleport: any = await editor.handleEditorPacket(ADMIN, "DUNGEON_EDITOR_SAVE", { ...ok, id: created.id, portal: { map: "vault", name: "Jump" } });
      expect(teleport.fields.portal).toBeTruthy();

      const before = writes.length;
      await editor.handleEditorPacket(ADMIN, "DUNGEON_EDITOR_SAVE", { ...ok, id: created.id, name: "Same" });
      expect(writes.length).toBe(before);

      await editor.handleEditorPacket(ADMIN, "DUNGEON_EDITOR_DELETE", { id: created.id });
      expect(writes.at(-1)!.portals.map((p) => p.dungeonId)).toEqual([null, null, null]);
    } finally {
      setPortalWriter(null);
    }
  });
});

describe("the dungeon's exit portal", () => {
  const portal = (name: string, dungeonId: number | null) => ({
    name, kind: "dungeon", dungeonId, mirror: true, target: null, position: { x: 400, y: 400 }, size: { width: 32, height: 32 }, layer: null,
  });
  const exitsOn = (map: string) => (cache.get("mapProperties").find((m: any) => m.name === `${map}.json`).dungeonPortals ?? [])
    .filter((p: any) => p.returnOf).map((p: any) => `${p.name} ${p.kind} ${p.dungeonId} ${p.position.x},${p.position.y} <- ${p.returnOf.map}/${p.returnOf.name}`);
  test("linking, moving the entrance or the map, and deleting the dungeon re-plan its exit; no room above the entrance is refused", async () => {
    const { setPortalWriter } = await import("../systems/portaleditor");
    const writes: string[] = [];
    setPortalWriter(async (map, portals) => {
      writes.push(map);
      cache.get("mapProperties").find((m: any) => m.name === `${map}.json`).dungeonPortals = portals;
    });
    cache.get("mapProperties").push({ name: "overworld.json", width: 100, height: 100, tileWidth: 32, tileHeight: 32, dungeonPortals: [portal("DungeonPortal_1", null)] });
    try {
      const created: any = await editor.handleEditorPacket(ADMIN, "DUNGEON_EDITOR_SAVE", { ...ok, entranceX: 200, entranceY: 300, portal: { map: "overworld", name: "DungeonPortal_1" } });
      expect(created.errors).toEqual([]);
      expect(exitsOn("crypt")).toEqual(["DungeonPortal_1 (return) dungeon null 184,252 <- overworld/DungeonPortal_1"]);
      expect(created.notes.join(" ")).toContain("DungeonPortal_1 (return)");
      // the exit is not offered as an entrance
      expect(created.data.portals.map((p: any) => p.name)).toEqual(["DungeonPortal_1"]);

      const moved: any = await editor.handleEditorPacket(ADMIN, "DUNGEON_EDITOR_SAVE", { ...ok, id: created.id, entranceX: 500, entranceY: 300 });
      expect(moved.errors).toEqual([]);
      expect(exitsOn("crypt")).toEqual(["DungeonPortal_1 (return) dungeon null 484,252 <- overworld/DungeonPortal_1"]);

      const before = writes.length;
      const cramped: any = await editor.handleEditorPacket(ADMIN, "DUNGEON_EDITOR_SAVE", { ...ok, id: created.id, entranceX: 500, entranceY: 20 });
      expect(Object.keys(cramped.fields)).toEqual(["entranceY"]);
      expect(cramped.fields.entranceY).toContain("48 pixels");
      expect(writes.length).toBe(before);
      expect((await dungeonDefs.get(created.id))!.entranceY).toBe(300);

      const vault: any = await editor.handleEditorPacket(ADMIN, "DUNGEON_EDITOR_SAVE", { ...ok, id: created.id, map: "vault", entranceX: 200, entranceY: 300 });
      expect(vault.errors).toEqual([]);
      expect(exitsOn("crypt")).toEqual([]);
      expect(exitsOn("vault")).toEqual(["DungeonPortal_1 (return) dungeon null 184,252 <- overworld/DungeonPortal_1"]);

      await editor.handleEditorPacket(ADMIN, "DUNGEON_EDITOR_DELETE", { id: created.id });
      expect(exitsOn("vault")).toEqual([]);
      expect(cache.get("mapProperties").find((m: any) => m.name === "overworld.json").dungeonPortals.map((p: any) => p.dungeonId)).toEqual([null]);
    } finally {
      setPortalWriter(null);
    }
  });
});

describe("portal colours", () => {
  test("a dungeon's portal is blue and a raid's green unless it has its own", async () => {
    const { portalColorOf, DEFAULT_PORTAL_COLORS } = await import("../systems/dungeons/types");
    expect(DEFAULT_PORTAL_COLORS).toEqual({ dungeon: "#6eaaff", raid: "#6eff8c" });
    expect(portalColorOf({ type: "dungeon", portalColor: null })).toBe("#6eaaff");
    expect(portalColorOf({ type: "raid", portalColor: null })).toBe("#6eff8c");
    expect(portalColorOf({ type: "raid", portalColor: "#ff8a3d" })).toBe("#ff8a3d");
  });

  test("a stored colour that is not a code reads as none", async () => {
    tables.dungeons.push({ id: 7, name: "Old", map: "crypt", type: "dungeon", sizes: "5", multipliers: "{}", entrance_x: 1, entrance_y: 1, enabled: 1, portal_color: "teal" });
    await clearCaches();
    expect((await dungeonDefs.get(7))!.portalColor).toBeNull();
  });
});

test("the server's answer to a dungeon editor save carries the saved dungeon's id", async () => {
  const source = await Bun.file(new URL("../socket/handlers/editors.ts", import.meta.url)).text();
  const start = source.indexOf('case "DUNGEON_EDITOR_SAVE":');
  const body = source.slice(start, source.indexOf("break;\n      }", start));
  expect(body).toContain("packetManager.dungeonEditorResult({");
  expect(body).toMatch(/\bid: result\.id\b/);
});
