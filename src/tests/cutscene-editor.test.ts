import { beforeEach, describe, expect, mock, test } from "bun:test";
import { databaseModule, standInFor } from "./setup";

const queries: Array<{ sql: string; params: any[] }> = [];
/** What the next statement that reads the cutscenes table answers. */
let tableRows: any[] = [];
let failWrites = false;

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, params: any[] = []) => {
    queries.push({ sql, params });
    if (failWrites && /^(INSERT|UPDATE|DELETE)/.test(sql)) throw new Error("the database is down");
    if (sql.startsWith("SELECT name, data")) return tableRows;
    return [];
  },
}));

const cache = new Map<string, any>();
await standInFor("../services/assetCache", () => ({
  default: {
    get: async (key: string) => cache.get(key),
    set: async (key: string, value: any) => cache.set(key, value),
    add: async (key: string, value: any) => cache.set(key, value),
  },
}));

const editor = await import("../systems/cutscenes");

/** What the asset server lists, null when it does not answer. */
let soundFiles: string[] | null = [];
const assets = {
  sounds: async () => soundFiles,
  spriteSheets: async () => ({ helmet: [{ name: "iron_helmet", image: "/icon?name=iron_helmet" }] }),
  icons: async () => [{ name: "signpost", image: "/icon?name=signpost" }],
};

const admin = { username: "root", isAdmin: true, permissions: [] };
const send = (who: any, type: string, data: any) => editor.handleEditorPacket(who, type, data, assets);

/** What the server knows of: the game data a good scene points at. */
const KNOWN: import("../systems/cutscenes").Known = {
  maps: new Map([["main", "main"], ["cave", "Cave"]]),
  npcs: new Set([7]),
  weathers: new Set(["clear", "rain"]),
  particles: new Set(["sparkle"]),
  sounds: new Set(["theme"]),
  quests: new Set([4]),
  scenes: new Set(["part two"]),
};

/** A scene that uses every kind of track, actor, item and trigger there is. */
function goodDoc(): any {
  return {
    name: "Intro",
    description: "The opening of the story.",
    map: "main",
    duration: 20,
    settings: {
      letterbox: true, letterboxSize: 0.12, hideHud: true, hideOthers: false, hideSelf: false, hideCreatures: true,
      skippable: true, lock: true, worldVolume: 0.4, fadeIn: 1, fadeOut: 2,
    },
    actors: [
      { id: "a1", name: "Guard", showName: true, look: { kind: "npc", npcId: 7 }, x: 100, y: 120, direction: "down", visible: true },
      { id: "a2", name: "Hero", showName: false, look: { kind: "viewer" }, x: 0, y: 0, direction: "up", visible: true },
      {
        id: "a3", name: "Wraith", showName: false, x: 50, y: 60, direction: "left", visible: false,
        look: { kind: "layers", sprite_type: "animated", body: "npc_body_1", head: "npc_head_1", helmet: null, shoulderguards: null, neck: null, hands: null, chest: "chest_1", feet: null, legs: null, weapon: null },
      },
    ],
    tracks: [
      { id: "t1", kind: "camera", label: "Camera", items: [
        { id: "i1", t: 0, d: 0, x: 100, y: 100, zoom: 1.5, ease: "smooth", follow: null },
        { id: "i2", t: 5, d: 0, x: 0, y: -20, zoom: 2, ease: "linear", follow: "a1" },
        { id: "i3", t: 9, d: 0, x: 0, y: 0, zoom: 1, ease: "hold", follow: "viewer" },
      ] },
      { id: "t2", kind: "shake", label: "Shake", items: [{ id: "i4", t: 2, d: 1, strength: 8, speed: 30 }] },
      { id: "t3", kind: "screen", label: "Screen", items: [{ id: "i5", t: 0, d: 3, effect: "fade", color: "#000000", amount: 1, in: 0.5, out: 1 }] },
      { id: "t4", kind: "text", label: "Text", items: [
        { id: "i6", t: 1, d: 4, style: "title", text: "Mystika", sub: "A new age", speaker: "", x: 0.5, y: 0.5, in: 0.5, out: 0.5, typewriter: 0, color: "#ffffff", size: 2 },
      ] },
      { id: "t5", kind: "actor", actor: "a1", label: "Guard", items: [
        { id: "i7", t: 0, d: 4, do: "move", path: [{ x: 100, y: 120 }, { x: 200, y: 120 }], ease: "smooth", animation: "walk" },
        { id: "i8", t: 4, d: 0, do: "place", x: 10, y: 20, direction: "right" },
        { id: "i9", t: 5, d: 0, do: "face", direction: "up" },
        { id: "i10", t: 6, d: 2, do: "animate", animation: "cast_idle" },
        { id: "i11", t: 7, d: 2, do: "say", text: "Halt!" },
        { id: "i12", t: 8, d: 0, do: "hide" },
        { id: "i13", t: 9, d: 0, do: "show" },
      ] },
      { id: "t6", kind: "audio", label: "Audio", items: [{ id: "i14", t: 0, d: 20, sound: "theme", bus: "music", volume: 0.8, rate: 1, loop: true, in: 1, out: 1 }] },
      { id: "t7", kind: "world", label: "World", items: [
        { id: "i15", t: 0, d: 5, do: "weather", weather: "rain" },
        { id: "i16", t: 5, d: 5, do: "time", from: 6, to: 18 },
        { id: "i17", t: 10, d: 5, do: "particles", particle: "sparkle", x: 40, y: 50 },
      ] },
      { id: "t8", kind: "mark", label: "Marks", items: [{ id: "i18", t: 10, d: 0, name: "boss" }] },
    ],
    triggers: [
      { id: "g1", on: "area", once: true, minLevel: 3, x: 10, y: 10, w: 50, h: 40, questId: null, npcId: null },
      { id: "g2", on: "quest_complete", once: false, minLevel: 0, x: 0, y: 0, w: 0, h: 0, questId: 4, npcId: null },
      { id: "g3", on: "npc", once: false, minLevel: 0, x: 0, y: 0, w: 0, h: 0, questId: null, npcId: 7 },
    ],
    end: { teleport: { map: "cave", x: 5, y: 6 }, next: "Part Two" },
  };
}

/** The fields the checks complain of after `edit` is made to a good scene. */
function fieldsOf(edit: (doc: any) => void, existing: Array<{ name: string }> = [], known: import("../systems/cutscenes").Known | null = KNOWN): Record<string, string> {
  const doc = goodDoc();
  edit(doc);
  const read = editor.readCutscene(doc, null, existing, known ?? undefined);
  return read.ok ? {} : read.fields;
}

/** The good scene without the scene that follows it: nothing else is saved in these tests, and a save needs the scene it continues into. */
function saveable(): any {
  const doc = goodDoc();
  doc.end.next = null;
  return doc;
}

beforeEach(() => {
  queries.length = 0;
  tableRows = [];
  failWrites = false;
  cache.clear();
  cache.set("cutscenes", []);
  cache.set("mapProperties", [{ name: "main.json" }, { name: "Cave.json" }]);
  cache.set("npcs", [
    { id: 7, name: "Captain", map: "main.json", sprite_type: "animated", sprite_body: "npc_body_7", sprite_head: "npc_head_7", sprite_chest: "chest_7" },
    { id: 8, name: "Statue", map: "main", sprite_type: "static", sprite_body: "statue_icon" },
    { id: -1, name: "Crystal", map: "main", hidden: true, sprite_type: "none" },
  ]);
  cache.set("weather", [{ name: "clear", temperature: 20 }, { name: "rain", temperature: 10, precipitation: 80 }]);
  cache.set("particles", [{ name: "sparkle", size: 3 }]);
  soundFiles = ["theme", "boom"];
  cache.set("quests", [{ id: 4, name: "The Siege" }, { id: 9, name: "Another" }]);
});

describe("who may use the cutscene editor", () => {
  test("admins and holders of its permission, as copied to the player at login", () => {
    expect(editor.canUseEditor(admin)).toBe(true);
    expect(editor.canUseEditor({ username: "director", permissions: ["chat.say", "tools.cutscene_editor"] })).toBe(true);
    expect(editor.canUseEditor({ username: "builder", permissions: ["tools.*"] })).toBe(true);
    expect(editor.canUseEditor({ username: "player", permissions: ["chat.say"] })).toBe(false);
    expect(editor.canUseEditor({ username: "player" })).toBe(false);
    expect(editor.canUseEditor({ username: "guest", isGuest: true, isAdmin: true })).toBe(false);
    expect(editor.canUseEditor(null)).toBe(false);
  });

  test("anyone else is refused on every packet, and nothing is written", async () => {
    for (const type of ["CUTSCENE_EDITOR_LIST", "CUTSCENE_EDITOR_SAVE", "CUTSCENE_EDITOR_DELETE", "CUTSCENE_EDITOR_RESOLVE"]) {
      const answer = await send({ username: "player" }, type, { doc: goodDoc(), originalName: null });
      expect(answer).toMatchObject({ kind: "result", ok: false, denied: true, errors: [editor.DENIED] });
    }
    expect(queries).toHaveLength(0);
  });

  test("the permission is added to the list of permissions that can be granted", async () => {
    await editor.ensureCutsceneEditorPermission();
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain("INTO permission_types (name) VALUES ('tools.cutscene_editor')");
  });
});

describe("a scene the editor sends", () => {
  test("a good one is accepted and comes back as it was sent", () => {
    const read = editor.readCutscene(goodDoc(), null, [], KNOWN);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // Cave is written as the map list writes it.
    const expected = goodDoc();
    expected.end.teleport.map = "Cave";
    expect(read.doc).toEqual(expected);
  });

  test("is built again from the fields that are known: the rest is dropped, and nothing the server fills in is kept", () => {
    const doc = goodDoc();
    doc.bogus = 1;
    doc.settings.extra = true;
    doc.actors[0].secret = "x";
    doc.actors[0].sprite_type = "animated";
    doc.actors[0].spriteLayers = { body: "x" };
    doc.tracks[6].items[0].weatherData = { name: "junk" };
    doc.tracks[6].items[2].particleData = { name: "junk" };
    doc.tracks[0].items[0].extra = 1;
    doc.triggers[0].extra = 1;
    const read = editor.readCutscene(doc, null, [], KNOWN);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const text = JSON.stringify(read.doc);
    for (const dropped of ["bogus", "extra", "secret", "spriteLayers", "weatherData", "particleData", "junk"]) {
      expect(text).not.toContain(dropped);
    }
    // A layers actor keeps its own sprite_type (it is part of its look); only the actor's is the server's.
    expect(read.doc.actors[0]).not.toHaveProperty("sprite_type");
    expect(read.doc.actors[2]!.look).toHaveProperty("sprite_type", "animated");
  });

  test("is normalised: defaults, colours, the map's name, points that have no length, fields a kind does not use", () => {
    const read = editor.readCutscene({
      name: "  Small  ", map: "Main.json", duration: 3,
      actors: [],
      tracks: [
        { id: "t1", kind: "camera", label: "c", muted: false, items: [{ id: "i1", t: 1, d: 9, x: 1, y: 2, zoom: 1, ease: "linear", follow: null }] },
        { id: "t2", kind: "screen", label: "s", muted: true, items: [{ id: "i2", t: 0, d: 1, effect: "tint", color: "#FFAA00", amount: 0.5 }] },
        { id: "t3", kind: "mark", label: "m", items: [{ id: "i3", t: 2, d: 5, name: "x" }] },
      ],
      triggers: [{ id: "g1", on: "login", x: 5, y: 5, w: 5, h: 5, questId: 3, npcId: 3 }],
    }, null, [], KNOWN);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const { doc } = read;
    expect(doc.name).toBe("Small");
    expect(doc.map).toBe("main");
    expect(doc.description).toBe("");
    expect(doc.settings).toEqual({ ...editor.DEFAULT_SETTINGS });
    expect(doc.end).toEqual({ teleport: null, next: null });
    // A key and a mark are points: they last no time.
    expect(doc.tracks[0]!.items[0]).toMatchObject({ d: 0 });
    expect(doc.tracks[2]!.items[0]).toMatchObject({ d: 0 });
    expect(doc.tracks[0]).not.toHaveProperty("muted");
    expect(doc.tracks[1]).toMatchObject({ muted: true });
    expect(doc.tracks[1]!.items[0]).toMatchObject({ color: "#ffaa00", in: 0, out: 0 });
    expect(doc.triggers[0]).toEqual({ id: "g1", on: "login", once: false, minLevel: 0, x: 0, y: 0, w: 0, h: 0, questId: null, npcId: null });
  });

  test("keeps its saved name, whatever was sent", () => {
    const doc = goodDoc();
    doc.name = "Renamed";
    const read = editor.readCutscene(doc, "Intro", [{ name: "Intro" }], KNOWN);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.doc.name).toBe("Intro");
  });

  test("needs a name of its own, made of letters, digits, spaces, _ and -", () => {
    expect(fieldsOf((d) => { d.name = ""; })).toHaveProperty("name");
    expect(fieldsOf((d) => { d.name = "../evil"; })).toHaveProperty("name");
    expect(fieldsOf((d) => { d.name = "x".repeat(65); })).toHaveProperty("name");
    expect(fieldsOf((d) => { d.name = "intro"; }, [{ name: "Intro" }]).name).toBe("There is already a scene called intro.");
    expect(fieldsOf((d) => { d.name = "Act 1_b-2"; })).toEqual({});
  });

  test("says which field is wrong by its path, so the editor can point at it", () => {
    // The item of the fourth track (text) that sits after the scene's end.
    expect(fieldsOf((d) => { d.tracks[3].items[0].t = 21; })).toEqual({ "tracks.3.items.0.t": "Enter a number from 0 to 20." });
    expect(fieldsOf((d) => { d.tracks[0].items[2].zoom = 4; })).toHaveProperty(["tracks.0.items.2.zoom"]);
    expect(fieldsOf((d) => { d.actors[1].direction = "sideways"; })).toHaveProperty(["actors.1.direction"]);
    expect(fieldsOf((d) => { d.settings.worldVolume = 2; })).toHaveProperty(["settings.worldVolume"]);
    expect(fieldsOf((d) => { d.tracks[4].items[0].path[1].x = "far"; })).toHaveProperty(["tracks.4.items.0.path.1.x"]);
    const one = goodDoc();
    one.description = 5;
    expect(editor.readCutscene(one, null, [], KNOWN)).toMatchObject({ ok: false, errors: ["1 field needs fixing."], fields: { description: "Enter some text." } });
    const two = goodDoc();
    two.description = 5;
    two.map = "nowhere";
    expect(editor.readCutscene(two, null, [], KNOWN)).toMatchObject({ ok: false, errors: ["2 fields need fixing."] });
    // A duration that is wrong does not make every time on the timeline wrong with it.
    expect(fieldsOf((d) => { d.duration = 0; })).toEqual({ duration: "Enter a number from 0.5 to 600." });
  });

  test("refuses an unknown kind, never guessing at it", () => {
    expect(fieldsOf((d) => { d.tracks[0].kind = "hologram"; })).toHaveProperty(["tracks.0.kind"]);
    expect(fieldsOf((d) => { d.tracks[4].items[0].do = "teleport"; })).toHaveProperty(["tracks.4.items.0.do"]);
    expect(fieldsOf((d) => { d.tracks[6].items[0].do = "meteor"; })).toHaveProperty(["tracks.6.items.0.do"]);
    expect(fieldsOf((d) => { d.actors[0].look.kind = "ghost"; })).toHaveProperty(["actors.0.look.kind"]);
    expect(fieldsOf((d) => { d.triggers[0].on = "sunrise"; })).toHaveProperty(["triggers.0.on"]);
    expect(fieldsOf((d) => { d.tracks[3].items[0].style = "marquee"; })).toHaveProperty(["tracks.3.items.0.style"]);
    expect(fieldsOf((d) => { d.tracks[2].items[0].effect = "blur"; })).toHaveProperty(["tracks.2.items.0.effect"]);
    expect(fieldsOf((d) => { d.tracks[0].items[0].ease = "bounce"; })).toHaveProperty(["tracks.0.items.0.ease"]);
  });

  test("refuses a number that is not finite or is outside its bounds, and text that is too long", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "5", null]) {
      expect(fieldsOf((d) => { d.tracks[1].items[0].strength = bad; })).toHaveProperty(["tracks.1.items.0.strength"]);
    }
    expect(fieldsOf((d) => { d.tracks[1].items[0].strength = 65; })).toHaveProperty(["tracks.1.items.0.strength"]);
    expect(fieldsOf((d) => { d.tracks[1].items[0].speed = 0; })).toHaveProperty(["tracks.1.items.0.speed"]);
    expect(fieldsOf((d) => { d.tracks[5].items[0].rate = 5; })).toHaveProperty(["tracks.5.items.0.rate"]);
    expect(fieldsOf((d) => { d.tracks[6].items[1].to = 25; })).toHaveProperty(["tracks.6.items.1.to"]);
    expect(fieldsOf((d) => { d.tracks[3].items[0].typewriter = 121; })).toHaveProperty(["tracks.3.items.0.typewriter"]);
    expect(fieldsOf((d) => { d.tracks[3].items[0].size = 0.1; })).toHaveProperty(["tracks.3.items.0.size"]);
    expect(fieldsOf((d) => { d.duration = 601; })).toHaveProperty("duration");
    expect(fieldsOf((d) => { d.duration = 0.4; })).toHaveProperty("duration");
    expect(fieldsOf((d) => { d.settings.letterboxSize = 0.3; })).toHaveProperty(["settings.letterboxSize"]);
    expect(fieldsOf((d) => { d.tracks[3].items[0].text = "x".repeat(501); })).toHaveProperty(["tracks.3.items.0.text"]);
    expect(fieldsOf((d) => { d.tracks[3].items[0].sub = "x".repeat(201); })).toHaveProperty(["tracks.3.items.0.sub"]);
    expect(fieldsOf((d) => { d.tracks[4].items[4].text = "x".repeat(201); })).toHaveProperty(["tracks.4.items.4.text"]);
    expect(fieldsOf((d) => { d.description = "x".repeat(501); })).toHaveProperty("description");
    expect(fieldsOf((d) => { d.tracks[3].items[0].color = "white"; })).toHaveProperty(["tracks.3.items.0.color"]);
    expect(fieldsOf((d) => { d.tracks[4].items[0].path = []; })).toHaveProperty(["tracks.4.items.0.path"]);
    expect(fieldsOf((d) => { d.tracks[4].items[0].path = Array.from({ length: 65 }, () => ({ x: 0, y: 0 })); })).toHaveProperty(["tracks.4.items.0.path"]);
    expect(fieldsOf((d) => { d.triggers[0].w = 0; })).toHaveProperty(["triggers.0.w"]);
    expect(fieldsOf((d) => { d.triggers[1].questId = 1.5; })).toHaveProperty(["triggers.1.questId"]);
  });

  test("checks the ids are unique and that what points at an actor points at a real one", () => {
    expect(fieldsOf((d) => { d.actors[1].id = "a1"; })).toHaveProperty(["actors.1.id"]);
    expect(fieldsOf((d) => { d.actors[1].id = "viewer"; })).toHaveProperty(["actors.1.id"]);
    expect(fieldsOf((d) => { d.tracks[1].id = "t1"; })).toHaveProperty(["tracks.1.id"]);
    expect(fieldsOf((d) => { d.tracks[1].items[0].id = "i1"; })).toHaveProperty(["tracks.1.items.0.id"]);
    expect(fieldsOf((d) => { d.triggers[1].id = "g1"; })).toHaveProperty(["triggers.1.id"]);
    // An actor's track needs its actor; a camera follows an actor that exists, or the viewer, or nothing.
    expect(fieldsOf((d) => { d.tracks[4].actor = "a9"; })).toHaveProperty(["tracks.4.actor"]);
    expect(fieldsOf((d) => { delete d.tracks[4].actor; })).toHaveProperty(["tracks.4.actor"]);
    expect(fieldsOf((d) => { d.tracks[0].items[1].follow = "a9"; })).toHaveProperty(["tracks.0.items.1.follow"]);
    expect(fieldsOf((d) => { d.tracks[0].items[1].follow = "viewer"; })).toEqual({});
    expect(fieldsOf((d) => { d.tracks[0].items[1].follow = null; })).toEqual({});
  });

  test("keeps to the counts: 32 actors, 64 tracks, 16 triggers, 500 items a track, 4000 a scene", () => {
    const actor = (n: number) => ({ id: `b${n}`, name: "", showName: false, look: { kind: "viewer" }, x: 0, y: 0, direction: "down", visible: true });
    expect(fieldsOf((d) => { d.actors = Array.from({ length: 33 }, (_, n) => actor(n)); })).toHaveProperty("actors");
    expect(fieldsOf((d) => { d.actors = Array.from({ length: 32 }, (_, n) => actor(n)); d.tracks[4].actor = "b1"; d.tracks[0].items[1].follow = null; })).toEqual({});
    expect(fieldsOf((d) => { d.tracks = Array.from({ length: 65 }, (_, n) => ({ id: `x${n}`, kind: "mark", label: "", items: [] })); })).toHaveProperty("tracks");
    expect(fieldsOf((d) => { d.triggers = Array.from({ length: 17 }, (_, n) => ({ id: `g${n}`, on: "login" })); })).toHaveProperty("triggers");
    const marks = (track: number, count: number) => ({ id: `m${track}`, kind: "mark", label: "", items: Array.from({ length: count }, (_, n) => ({ id: `m${track}_${n}`, t: 0, name: "x" })) });
    expect(fieldsOf((d) => { d.tracks = [marks(1, 501)]; })).toHaveProperty(["tracks.0.items"]);
    expect(fieldsOf((d) => { d.tracks = [marks(1, 500)]; })).toEqual({});
    expect(fieldsOf((d) => { d.tracks = Array.from({ length: 9 }, (_, n) => marks(n, 500)); })).toHaveProperty("tracks");
  });

  test("checks that the map, NPC, weather, particle, sound, quest and scene it names are there", () => {
    expect(fieldsOf((d) => { d.map = "nowhere"; })).toHaveProperty("map");
    expect(fieldsOf((d) => { d.end.teleport.map = "nowhere"; })).toHaveProperty(["end.teleport.map"]);
    expect(fieldsOf((d) => { d.actors[0].look.npcId = 99; })).toHaveProperty(["actors.0.look.npcId"]);
    expect(fieldsOf((d) => { d.tracks[6].items[0].weather = "hail"; })).toHaveProperty(["tracks.6.items.0.weather"]);
    expect(fieldsOf((d) => { d.tracks[6].items[2].particle = "smoke"; })).toHaveProperty(["tracks.6.items.2.particle"]);
    expect(fieldsOf((d) => { d.tracks[5].items[0].sound = "silence"; })).toHaveProperty(["tracks.5.items.0.sound"]);
    expect(fieldsOf((d) => { d.triggers[1].questId = 99; })).toHaveProperty(["triggers.1.questId"]);
    expect(fieldsOf((d) => { d.triggers[2].npcId = 99; })).toHaveProperty(["triggers.2.npcId"]);
    expect(fieldsOf((d) => { d.end.next = "Part Three"; })).toHaveProperty(["end.next"]);
    // A stored scene read again is checked for its shape only: what it points at may have been taken away since.
    expect(fieldsOf((d) => { d.map = "nowhere"; d.end.next = "Part Three"; }, [], null)).toEqual({});
  });

  test("cannot continue into itself, but may into another", () => {
    expect(fieldsOf((d) => { d.end.next = "Intro"; })).toHaveProperty(["end.next"]);
    expect(fieldsOf((d) => { d.end.next = "INTRO"; })).toHaveProperty(["end.next"]);
    expect(fieldsOf((d) => { d.end.next = "part two"; })).toEqual({});
    expect(fieldsOf((d) => { d.end.next = null; d.end.teleport = null; })).toEqual({});
  });

  test("is refused when it would not fit in a frame the receiver takes", () => {
    const read = editor.readCutscene({
      name: "Huge", map: "main", duration: 600,
      tracks: Array.from({ length: 64 }, (_, n) => ({
        id: `t${n}`, kind: "text", label: "",
        items: Array.from({ length: 62 }, (_, i) => ({ id: `i${n}_${i}`, t: 1, d: 1, style: "caption", text: "y".repeat(500), sub: "z".repeat(200) })),
      })),
    }, null, [], KNOWN);
    expect(read).toMatchObject({ ok: false, errors: ["The scene is too large to store."] });
    if (!read.ok) expect(Object.keys(read.fields)).toEqual(["doc"]);
    expect(editor.LIMITS.docBytes).toBeLessThan(1024 * 1024);
  });

  test("not an object at all is refused, not thrown at", () => {
    for (const raw of [null, undefined, "scene", 4, []]) {
      expect(() => editor.readCutscene(raw, null, [], KNOWN)).not.toThrow();
      expect(editor.readCutscene(raw, null, [], KNOWN).ok).toBe(false);
    }
  });
});

describe("the editor's list", () => {
  test("holds the scenes and what a scene can point at", async () => {
    const intro = editor.readCutscene(goodDoc(), null, [], KNOWN);
    if (!intro.ok) throw new Error("the good scene was refused");
    cache.set("cutscenes", [{ ...intro.doc, name: "Zeta", updatedBy: "root", updatedAt: 5 }, { ...intro.doc, name: "Alpha", updatedBy: "root", updatedAt: 6 }]);
    const answer = await send(admin, "CUTSCENE_EDITOR_LIST", {});
    expect(answer.kind).toBe("data");
    if (answer.kind !== "data") return;
    const { data } = answer;
    expect(data.cutscenes.map((s) => s.name)).toEqual(["Alpha", "Zeta"]);
    expect(data.cutscenes[0]).toMatchObject({ updatedBy: "root", updatedAt: 6 });
    expect(data.npcs).toEqual([{ id: 7, name: "Captain", map: "main" }, { id: 8, name: "Statue", map: "main" }]);
    expect(data.weathers).toEqual(["clear", "rain"]);
    expect(data.particles).toEqual(["sparkle"]);
    expect(data.sounds).toEqual(["boom", "theme"]);
    expect(data.quests).toEqual([{ id: 4, name: "The Siege" }, { id: 9, name: "Another" }]);
    expect(data.maps).toEqual(["Cave", "main"]);
    expect(data.limits).toEqual(editor.LIMITS);
  });

  test("a map's particle emitter is no NPC to pick, and a scene that names one is still sound", async () => {
    const known = await editor.buildKnown();
    expect(known.npcs.has(-1)).toBe(true);
    const answer = await send(admin, "CUTSCENE_EDITOR_LIST", {});
    expect(answer.kind === "data" && answer.data.npcs.map((n) => n.id)).toEqual([7, 8]);
  });

  test("clear is always a weather, and an empty server still answers", async () => {
    for (const key of ["npcs", "weather", "particles", "quests", "mapProperties", "cutscenes"]) cache.delete(key);
    soundFiles = [];
    const answer = await send(admin, "CUTSCENE_EDITOR_LIST", {});
    expect(answer.kind === "data" && answer.data.weathers).toEqual(["clear"]);
    expect(answer.kind === "data" && answer.data.cutscenes).toEqual([]);
  });
});

describe("the sounds a scene can name", () => {
  const withSound = (sound: string) => {
    const doc = saveable();
    doc.tracks[5].items[0].sound = sound;
    return doc;
  };

  test("a file on the asset server is offered and saves", async () => {
    soundFiles = ["close door.wav", "theme"];
    const list = await send(admin, "CUTSCENE_EDITOR_LIST", {});
    expect(list.kind === "data" && list.data.sounds).toEqual(["close door.wav", "theme"]);
    const answer = await send(admin, "CUTSCENE_EDITOR_SAVE", { originalName: null, doc: withSound("close door.wav") });
    expect(answer.kind === "result" && answer.ok).toBe(true);
  });

  test("a name the asset server does not have is refused", async () => {
    const answer = await send(admin, "CUTSCENE_EDITOR_SAVE", { originalName: null, doc: withSound("silence") });
    expect(answer.kind === "result" && answer.ok).toBe(false);
    expect(answer.kind === "result" && answer.fields).toHaveProperty(["tracks.5.items.0.sound"]);
  });

  test("with the asset server down nothing is offered, and a scene already naming a sound still saves", async () => {
    soundFiles = null;
    const list = await send(admin, "CUTSCENE_EDITOR_LIST", {});
    expect(list.kind === "data" && list.data.sounds).toEqual([]);
    const answer = await send(admin, "CUTSCENE_EDITOR_SAVE", { originalName: null, doc: withSound("theme") });
    expect(answer.kind === "result" && answer.ok).toBe(true);
  });
});

describe("saving and deleting", () => {
  test("a new scene is written and cached, and comes back as it was stored", async () => {
    const answer = await send(admin, "CUTSCENE_EDITOR_SAVE", { originalName: null, doc: saveable() });
    expect(answer).toMatchObject({ kind: "result", ok: true, name: "Intro", changed: true });
    const insert = queries.find((q) => q.sql.startsWith("INSERT INTO cutscenes"))!;
    expect(insert.params[0]).toBe("Intro");
    expect(JSON.parse(insert.params[1]).tracks).toHaveLength(8);
    expect(insert.params[2]).toBe("root");
    expect(insert.params[3]).toBeGreaterThan(0);
    const held = cache.get("cutscenes") as any[];
    expect(held.map((s) => s.name)).toEqual(["Intro"]);
    expect(held[0]).toMatchObject({ updatedBy: "root" });
    expect(answer.kind === "result" && answer.doc).toMatchObject({ name: "Intro", updatedBy: "root" });
  });

  test("a change is an update, the scene keeps its place in the list and its name", async () => {
    await send(admin, "CUTSCENE_EDITOR_SAVE", { originalName: null, doc: { ...saveable(), name: "First" } });
    await send(admin, "CUTSCENE_EDITOR_SAVE", { originalName: null, doc: { ...saveable(), name: "Second" } });
    queries.length = 0;
    const doc = { ...saveable(), name: "Different", description: "Changed." };
    const answer = await send({ username: "builder", permissions: ["tools.cutscene_editor"] }, "CUTSCENE_EDITOR_SAVE", { originalName: "first", doc });
    expect(answer).toMatchObject({ ok: true, name: "First" });
    const update = queries.find((q) => q.sql.startsWith("UPDATE cutscenes"))!;
    expect(update.params[2]).toBeGreaterThan(0);
    expect(update.params[3]).toBe("First");
    expect(update.params[1]).toBe("builder");
    expect(queries.some((q) => q.sql.startsWith("INSERT"))).toBe(false);
    const held = cache.get("cutscenes") as any[];
    expect(held.map((s) => s.name)).toEqual(["First", "Second"]);
    expect(held[0]).toMatchObject({ description: "Changed.", updatedBy: "builder" });
  });

  test("a refused save writes nothing and says which fields are wrong", async () => {
    const doc = saveable();
    doc.map = "nowhere";
    doc.tracks[3].items[0].t = 99;
    const answer = await send(admin, "CUTSCENE_EDITOR_SAVE", { originalName: null, doc });
    expect(answer).toMatchObject({ kind: "result", ok: false, errors: ["2 fields need fixing."] });
    if (answer.kind === "result") expect(Object.keys(answer.fields ?? {}).sort()).toEqual(["map", "tracks.3.items.0.t"]);
    expect(queries).toHaveLength(0);
    expect(cache.get("cutscenes")).toEqual([]);
  });

  test("a name that is taken is refused for a new scene", async () => {
    await send(admin, "CUTSCENE_EDITOR_SAVE", { originalName: null, doc: saveable() });
    queries.length = 0;
    const answer = await send(admin, "CUTSCENE_EDITOR_SAVE", { originalName: null, doc: { ...saveable(), name: "intro" } });
    expect(answer).toMatchObject({ ok: false, fields: { name: "There is already a scene called intro." } });
    expect(queries).toHaveLength(0);
  });

  test("a scene that is gone cannot be changed or deleted", async () => {
    for (const type of ["CUTSCENE_EDITOR_SAVE", "CUTSCENE_EDITOR_DELETE"]) {
      const answer = await send(admin, type, { originalName: "Ghost", doc: saveable() });
      expect(answer).toMatchObject({ ok: false, errors: ["There is no scene called Ghost any more."] });
    }
    expect((await send(admin, "CUTSCENE_EDITOR_DELETE", { originalName: "" }))).toMatchObject({ ok: false, errors: ["Pick a scene."] });
    expect(queries).toHaveLength(0);
  });

  test("a save that the database refuses is said, and the list is read again", async () => {
    tableRows = [];
    failWrites = true;
    const answer = await send(admin, "CUTSCENE_EDITOR_SAVE", { originalName: null, doc: saveable() });
    expect(answer).toMatchObject({ ok: false, errors: ["The scene could not be saved. The server log says why."] });
    expect(queries.some((q) => q.sql.startsWith("SELECT name, data"))).toBe(true);
    expect(cache.get("cutscenes")).toEqual([]);
  });

  test("deleting removes the row, the record of who saw it, and the cached scene", async () => {
    await send(admin, "CUTSCENE_EDITOR_SAVE", { originalName: null, doc: saveable() });
    queries.length = 0;
    const answer = await send(admin, "CUTSCENE_EDITOR_DELETE", { originalName: "INTRO" });
    expect(answer).toMatchObject({ ok: true, name: "Intro", changed: true });
    expect(queries.some((q) => q.sql === "DELETE FROM cutscenes WHERE name = ?" && q.params[0] === "Intro")).toBe(true);
    expect(queries.some((q) => q.sql === "DELETE FROM cutscene_views WHERE cutscene = ?" && q.params[0] === "Intro")).toBe(true);
    expect(cache.get("cutscenes")).toEqual([]);
  });

  test("an unknown request is refused", async () => {
    expect(await send(admin, "CUTSCENE_EDITOR_FLY", {})).toMatchObject({ ok: false, errors: ["Unknown request CUTSCENE_EDITOR_FLY."] });
  });
});

describe("resolving a scene", () => {
  const stored = async () => {
    const read = editor.readCutscene(goodDoc(), null, [], KNOWN);
    if (!read.ok) throw new Error("the good scene was refused");
    return read.doc;
  };

  test("an actor drawn as an NPC gets its sprite type and layers, as an NPC is sent to the client", async () => {
    const resolved = await editor.resolveDoc(await stored());
    const guard = resolved.actors[0]!;
    expect(guard.sprite_type).toBe("animated");
    const layers = guard.spriteLayers as any;
    expect(layers.body.name).toBe("npc_body_7");
    expect(layers.head.name).toBe("npc_head_7");
    expect(layers.chest.name).toBe("chest_7");
    expect(layers.weapon).toBeNull();
  });

  test("an actor drawn from layers gets them resolved, and the viewer's own character is left to the client", async () => {
    const resolved = await editor.resolveDoc(await stored());
    expect(resolved.actors[2]!.sprite_type).toBe("animated");
    expect((resolved.actors[2]!.spriteLayers as any).body.name).toBe("npc_body_1");
    expect((resolved.actors[2]!.spriteLayers as any).chest.name).toBe("chest_1");
    expect(resolved.actors[1]).not.toHaveProperty("spriteLayers");
    expect(resolved.actors[1]).not.toHaveProperty("sprite_type");
  });

  test("a static NPC is drawn from its icon", async () => {
    const doc = await stored();
    doc.actors[0]!.look = { kind: "npc", npcId: 8 };
    const resolved = await editor.resolveDoc(doc);
    expect(resolved.actors[0]!.sprite_type).toBe("static");
    expect((resolved.actors[0]!.spriteLayers as any).body.imageUrl).toContain("/icon?name=statue_icon");
  });

  test("a weather clip gets the weather's values and a particle clip the particle", async () => {
    const resolved = await editor.resolveDoc(await stored());
    const world = resolved.tracks[6]!.items as any[];
    expect(world[0].weatherData).toEqual({ name: "rain", temperature: 10, precipitation: 80 });
    expect(world[2].particleData).toEqual({ name: "sparkle", size: 3 });
    expect(world[1]).not.toHaveProperty("weatherData");
  });

  test("clear needs no row, and a reference that is gone is left without its data", async () => {
    cache.set("weather", []);
    cache.set("particles", []);
    cache.set("npcs", []);
    const doc = await stored();
    (doc.tracks[6]!.items as any[])[0].weather = "clear";
    const resolved = await editor.resolveDoc(doc);
    expect((resolved.tracks[6]!.items as any[])[0].weatherData).toBeNull();
    expect((resolved.tracks[6]!.items as any[])[2]).not.toHaveProperty("particleData");
    expect(resolved.actors[0]).not.toHaveProperty("spriteLayers");
  });

  test("the scene it is made from is not changed", async () => {
    const doc = await stored();
    const before = JSON.stringify(doc);
    await editor.resolveDoc(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });

  test("what players are sent has no triggers", async () => {
    const forPlayers = await editor.resolveForPlay(await stored());
    expect(forPlayers).not.toHaveProperty("triggers");
    expect(forPlayers.actors[0]!.spriteLayers).toBeDefined();
    expect(forPlayers.name).toBe("Intro");
  });

  test("the editor's resolve checks the scene as a save would, and answers with the resolved one", async () => {
    const answer = await send(admin, "CUTSCENE_EDITOR_RESOLVE", { doc: { ...goodDoc(), end: { teleport: null, next: null } } });
    expect(answer.kind).toBe("resolved");
    if (answer.kind !== "resolved") return;
    expect(answer.doc.actors[0]!.spriteLayers).toBeDefined();
    expect((answer.doc.tracks[6]!.items as any[])[0].weatherData).toMatchObject({ name: "rain" });
    expect(queries).toHaveLength(0);

    const bad = goodDoc();
    bad.tracks[3].items[0].t = 99;
    expect(await send(admin, "CUTSCENE_EDITOR_RESOLVE", { doc: bad })).toMatchObject({
      kind: "result", ok: false, fields: { "tracks.3.items.0.t": expect.any(String) },
    });
  });

  test("a scene being worked on may share the name of a saved one: it is the saved one being changed", async () => {
    await send(admin, "CUTSCENE_EDITOR_SAVE", { originalName: null, doc: { ...goodDoc(), end: { teleport: null, next: null } } });
    const answer = await send(admin, "CUTSCENE_EDITOR_RESOLVE", { doc: { ...goodDoc(), name: "intro", end: { teleport: null, next: null } } });
    expect(answer.kind).toBe("resolved");
    if (answer.kind === "resolved") expect(answer.doc.name).toBe("Intro");
  });
});

describe("the tables", () => {
  test("are made at startup, and the scenes are read into the cache", async () => {
    const read = editor.readCutscene(goodDoc(), null, [], KNOWN);
    if (!read.ok) throw new Error("the good scene was refused");
    tableRows = [
      { name: "Intro", data: JSON.stringify({ ...read.doc, name: "stored under another name" }), updated_by: "root", updated_at: "1700000000000" },
      { name: "Broken", data: "{not json", updated_by: null, updated_at: 0 },
      { name: "Wrong", data: JSON.stringify({ name: "Wrong", map: "main", duration: -3 }), updated_by: null, updated_at: 0 },
    ];
    expect(await editor.ensureCutsceneSchema()).toBe(true);
    expect(queries[0]!.sql).toContain("CREATE TABLE IF NOT EXISTS cutscenes");
    expect(queries[1]!.sql).toContain("CREATE TABLE IF NOT EXISTS cutscene_views");
    const held = cache.get("cutscenes") as any[];
    // The row's name is the scene's; a row that cannot be read is left out.
    expect(held.map((s) => s.name)).toEqual(["Intro"]);
    expect(held[0]).toMatchObject({ updatedBy: "root", updatedAt: 1700000000000 });
  });

  test("name the scene and the view the way the setup scripts do", () => {
    for (const engine of ["mysql", "sqlite"] as const) {
      expect(editor.CUTSCENES_TABLE[engine]).toMatch(/name .*UNIQUE/);
      expect(editor.CUTSCENES_TABLE[engine]).toContain("updated_by");
      expect(editor.CUTSCENE_VIEWS_TABLE[engine]).toContain("PRIMARY KEY (username, cutscene)");
    }
    expect(editor.CUTSCENES_TABLE.mysql).toContain("MEDIUMTEXT");
    expect(editor.CUTSCENES_TABLE.sqlite).toContain("data TEXT");
  });
});
