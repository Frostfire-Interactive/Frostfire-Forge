import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { databaseModule, standInFor } from "./setup";

const queries: Array<{ sql: string; params: any[] }> = [];
/** What the statement that reads a character's views answers; null makes it fail. */
let viewRows: any[] | null = [];

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, params: any[] = []) => {
    queries.push({ sql, params });
    if (sql.startsWith("SELECT cutscene FROM cutscene_views")) {
      if (viewRows === null) throw new Error("the database is down");
      return viewRows;
    }
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

const scenes = await import("../systems/cutscenes");
const sessions = await import("../systems/cutsceneplayer");
const held = await import("../systems/cutsceneheld");
const { SCENE_CLOCK_SLACK_MS, SCENE_LIMITS, arrivalLimits, handoffStateOf } = await import("../socket/arrival");
const { Events, listener } = await import("../systems/events");
const { default: playerCache } = await import("../services/playermanager");
const { default: mapIndex } = await import("../services/mapindex");
const { default: packet } = await import("../modules/packet");

// ------------------------------------------------------------------ the fake socket layer

/** Every packet the sessions sent, decoded. */
const sent: Array<{ to: string; type: string; data: any }> = [];
/** Every place a player was moved to. */
const moves: Array<{ who: string; map: string; x: number; y: number }> = [];
/** Every player whose walk was stopped for a scene. */
const stopped: string[] = [];

const fakeBridge: Parameters<typeof sessions.setCutsceneBridge>[0] & object = {
  send: (player, packets) => {
    for (const p of packets) sent.push({ to: player.username, ...JSON.parse(packet.decode(p as any)) });
  },
  hold: async (player) => {
    stopped.push(player.username);
  },
  teleport: async (player, map, x, y) => {
    moves.push({ who: player.username, map, x, y });
    player.location = { map, position: { ...player.location.position, x, y } };
  },
};
sessions.setCutsceneBridge(fakeBridge);

const DEFAULT_TIMING = { ...sessions.timing };
let counter = 0;
const made: any[] = [];

function makePlayer(over: Record<string, unknown> = {}): any {
  const n = ++counter;
  const player = {
    id: `p${n}`, username: `hero${n}`, stats: { level: 5 }, isDead: false, isGhost: false,
    location: { map: "main", position: { x: 10, y: 10, direction: "down" } },
    ...over,
  };
  made.push(player);
  return player;
}

/** In the world as a login puts a player there: in the cache and on its map. */
function enter(player: any): any {
  playerCache.add(player.id, player);
  mapIndex.addPlayer(player.id, player.location.map);
  return player;
}

interface SceneOptions {
  map?: string;
  duration?: number;
  lock?: boolean;
  skippable?: boolean;
  triggers?: any[];
  end?: any;
  marks?: Array<{ name: string; t: number }>;
  cameraAt?: { x: number; y: number };
}

/** A small scene as the store holds it. */
function makeScene(name: string, options: SceneOptions = {}): import("../systems/cutscenes").StoredCutscene {
  const read = scenes.readCutscene({
    name, map: options.map ?? "main", duration: options.duration ?? 10,
    settings: { lock: options.lock ?? true, skippable: options.skippable ?? true },
    tracks: [
      { id: "cam", kind: "camera", label: "Camera", items: [{ id: "k1", t: 0, x: options.cameraAt?.x ?? 100, y: options.cameraAt?.y ?? 100, zoom: 1, ease: "smooth", follow: null }] },
      { id: "marks", kind: "mark", label: "Marks", items: (options.marks ?? []).map((m, i) => ({ id: `m${i}`, t: m.t, name: m.name })) },
    ],
    triggers: options.triggers ?? [],
    end: options.end ?? {},
  }, null, []);
  if (!read.ok) throw new Error(`the test scene ${name} was refused: ${JSON.stringify(read.fields)}`);
  return { ...read.doc, updatedBy: null, updatedAt: 0 };
}

/** These are the scenes there are, and their triggers are indexed as the start does. */
function install(...list: Array<import("../systems/cutscenes").StoredCutscene>): void {
  cache.set("cutscenes", list);
  sessions.indexTriggers(list);
}

const trigger = (over: Record<string, unknown>) => ({ id: "g1", on: "npc", once: false, minLevel: 0, x: 0, y: 0, w: 0, h: 0, questId: null, npcId: null, ...over });
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const tokenOf = (player: any): string => player.cutscene.token;
const playsOf = () => sent.filter((m) => m.type === "CUTSCENE_PLAY");
const writes = () => queries.filter((q) => /cutscene_views/.test(q.sql) && !q.sql.startsWith("SELECT"));

/** What the events a scene emits carried, until the test is over. */
const heard: Record<string, any[]> = { started: [], ended: [], mark: [] };
const hear = (event: string, into: any[]) => {
  const listenerFn = (payload: any) => into.push(payload);
  listener.on(event, listenerFn);
  return () => listener.off(event, listenerFn);
};
let unhear: Array<() => void> = [];

beforeAll(async () => {
  await sessions.init();
});

beforeEach(() => {
  sent.length = 0;
  moves.length = 0;
  stopped.length = 0;
  queries.length = 0;
  viewRows = [];
  cache.clear();
  cache.set("cutscenes", []);
  Object.assign(sessions.timing, DEFAULT_TIMING);
  for (const key of Object.keys(heard)) heard[key] = [];
  unhear = [hear(Events.CUTSCENE_STARTED, heard.started!), hear(Events.CUTSCENE_ENDED, heard.ended!), hear(Events.CUTSCENE_MARK, heard.mark!)];
  sessions.indexTriggers([]);
});

afterEach(() => {
  for (const off of unhear) off();
  for (const player of made.splice(0)) {
    sessions.clear(player);
    playerCache.remove(player.id);
    mapIndex.removePlayer(player.id);
  }
});

afterAll(() => {
  sessions.indexTriggers([]);
  sessions.setCutsceneBridge(null);
});

// ---------------------------------------------------------------------- playing

describe("playing a scene", () => {
  test("sends it resolved and without its triggers, holds the player, and tells the listeners", async () => {
    install(makeScene("Intro", { triggers: [trigger({ on: "login" })] }));
    const player = makePlayer();
    expect(await sessions.play(player, "Intro")).toBe(true);

    expect(playsOf()).toHaveLength(1);
    const play = playsOf()[0]!;
    expect(play.to).toBe(player.username);
    expect(play.data.token).toMatch(/^[0-9a-f]{32}$/);
    expect(play.data.doc.name).toBe("Intro");
    expect(play.data.doc).not.toHaveProperty("triggers");
    expect(player.cutscene).toMatchObject({ name: "Intro", token: play.data.token, lock: true, phase: "pending" });
    // A hold the clock will end whatever the client does: 30 s until the client says it has begun.
    expect(player.cutscene.clockEndsAt - Date.now()).toBeGreaterThan(29_000);
    expect(player.cutscene.clockEndsAt - Date.now()).toBeLessThanOrEqual(30_000);
    expect(stopped).toEqual([player.username]);
    expect(held.isHeld(player)).toBe(true);
    expect(heard.started).toEqual([{ player, cutscene: "Intro" }]);
    // Timers are handles, not data: a session that is logged or copied does not carry them.
    expect(Object.keys(JSON.parse(JSON.stringify(player.cutscene))).sort()).toEqual(
      ["clockEndsAt", "depth", "duration", "end", "lock", "name", "origin", "phase", "skippable", "startedAt", "token"],
    );
  });

  test("each showing has a token of its own", async () => {
    install(makeScene("Intro"));
    const a = makePlayer();
    const b = makePlayer();
    await sessions.play(a, "Intro");
    await sessions.play(b, "Intro");
    expect(tokenOf(a)).not.toBe(tokenOf(b));
  });

  test("a scene that does not lock neither stops the player nor holds them", async () => {
    install(makeScene("Loose", { lock: false }));
    const player = makePlayer();
    expect(await sessions.play(player, "Loose")).toBe(true);
    expect(stopped).toEqual([]);
    expect(held.isHeld(player)).toBe(false);
    expect(player.cutscene).toMatchObject({ lock: false });
  });

  test("is refused for a scene there is not, a player who is dead or a ghost, and one in a scene already", async () => {
    install(makeScene("Intro"), makeScene("Other"));
    expect(await sessions.play(makePlayer(), "Nope")).toBe(false);
    expect(await sessions.play(makePlayer({ isDead: true }), "Intro")).toBe(false);
    expect(await sessions.play(makePlayer({ isGhost: true }), "Intro")).toBe(false);
    const player = makePlayer();
    expect(await sessions.play(player, "Intro")).toBe(true);
    const token = tokenOf(player);
    expect(await sessions.play(player, "Other")).toBe(false);
    expect(tokenOf(player)).toBe(token);
    expect(playsOf()).toHaveLength(1);
  });

  test("is refused for a player changing server node, and for a mirror of a player of another node", async () => {
    install(makeScene("Intro"));
    expect(await sessions.play(makePlayer({ handoff: { to: "n2" } }), "Intro")).toBe(false);
    expect(await sessions.play(makePlayer({ wt: { readyState: 1, data: { handedOff: true } } }), "Intro")).toBe(false);
    expect(await sessions.play(makePlayer({ remote: true }), "Intro")).toBe(false);
    expect(await sessions.play(null, "Intro")).toBe(false);
    expect(playsOf()).toHaveLength(0);
  });

  test("is refused for a player on another map, and for one whose connection is closed", async () => {
    install(makeScene("Intro"));
    expect(await sessions.play(makePlayer({ location: { map: "cave", position: { x: 0, y: 0 } } }), "Intro")).toBe(false);
    expect(await sessions.play(makePlayer({ wt: { readyState: 3, data: {} } }), "Intro")).toBe(false);
    // The map is named without ".json" however it is written.
    expect(await sessions.play(makePlayer({ location: { map: "MAIN.json", position: { x: 0, y: 0 } } }), "Intro")).toBe(true);
  });

  test("two starts at once begin one scene", async () => {
    install(makeScene("Intro"));
    const player = makePlayer();
    const results = await Promise.all([sessions.play(player, "Intro"), sessions.play(player, "Intro")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(playsOf()).toHaveLength(1);
  });

  test("forced, it ends the scene the player is in (with no end to run) and begins the other", async () => {
    install(makeScene("Intro", { end: { teleport: { map: "main", x: 1, y: 2 }, next: null } }), makeScene("Other"));
    const player = makePlayer();
    await sessions.play(player, "Intro");
    const first = tokenOf(player);
    expect(await sessions.play(player, "Other", { force: true })).toBe(true);
    expect(player.cutscene.name).toBe("Other");
    expect(tokenOf(player)).not.toBe(first);
    expect(sent.find((m) => m.type === "CUTSCENE_STOP")?.data).toEqual({ token: first });
    expect(heard.ended).toEqual([{ player, cutscene: "Intro", skipped: true }]);
    expect(moves).toEqual([]);
  });
});

// -------------------------------------------------------------- started and ended

describe("the client begins and ends the scene", () => {
  test("beginning sets the clock to the scene's length and 5 s", async () => {
    install(makeScene("Intro", { duration: 10 }));
    const player = makePlayer();
    await sessions.play(player, "Intro");
    expect(sessions.onStarted(player, tokenOf(player))).toBe(true);
    expect(player.cutscene.phase).toBe("running");
    const left = player.cutscene.clockEndsAt - Date.now();
    expect(left).toBeGreaterThan(14_000);
    expect(left).toBeLessThanOrEqual(15_000);
    // Once only: a second STARTED does not stretch the clock.
    expect(sessions.onStarted(player, tokenOf(player))).toBe(false);
  });

  test("the marks on the timeline fire as events when their time comes, and not after the scene is over", async () => {
    install(makeScene("Marked", { duration: 1, marks: [{ name: "first", t: 0.02 }, { name: "late", t: 0.2 }] }));
    const player = makePlayer();
    await sessions.play(player, "Marked");
    sessions.onStarted(player, tokenOf(player));
    await tick(80);
    expect(heard.mark).toEqual([{ player, cutscene: "Marked", name: "first", t: 0.02 }]);
    await sessions.onEnd(player, tokenOf(player), false);
    await tick(250);
    expect(heard.mark).toHaveLength(1);
  });

  test("an answer with a token that is not the session's is ignored", async () => {
    install(makeScene("Intro"));
    const player = makePlayer();
    await sessions.play(player, "Intro");
    expect(sessions.onStarted(player, "not-the-token")).toBe(false);
    expect(player.cutscene.phase).toBe("pending");
    expect(await sessions.onEnd(player, "not-the-token", false)).toBe(false);
    expect(await sessions.onEnd(player, undefined, false)).toBe(false);
    expect(player.cutscene).toBeDefined();
    expect(heard.ended).toEqual([]);
  });

  test("an answer about a scene that is over is ignored, and so is one from a player with no scene", async () => {
    install(makeScene("Intro"));
    const player = makePlayer();
    await sessions.play(player, "Intro");
    const token = tokenOf(player);
    expect(await sessions.onEnd(player, token, false)).toBe(true);
    expect(await sessions.onEnd(player, token, false)).toBe(false);
    expect(sessions.onStarted(player, token)).toBe(false);
    expect(await sessions.onEnd(makePlayer(), "anything", true)).toBe(false);
    expect(heard.ended).toHaveLength(1);
  });

  test("ending finishes the scene: the hold is gone, the listeners are told, and its end teleport is run", async () => {
    install(makeScene("Intro", { end: { teleport: { map: "cave", x: 5, y: 6 }, next: null } }));
    const player = makePlayer();
    await sessions.play(player, "Intro");
    sessions.onStarted(player, tokenOf(player));
    expect(await sessions.onEnd(player, tokenOf(player), false)).toBe(true);
    expect(player.cutscene).toBeUndefined();
    expect(held.isHeld(player)).toBe(false);
    expect(heard.ended).toEqual([{ player, cutscene: "Intro", skipped: false }]);
    expect(moves).toEqual([{ who: player.username, map: "cave", x: 5, y: 6 }]);
  });

  test("a scene that is skippable may be skipped at any time", async () => {
    install(makeScene("Intro", { skippable: true }));
    const player = makePlayer();
    await sessions.play(player, "Intro");
    sessions.onStarted(player, tokenOf(player));
    expect(await sessions.onEnd(player, tokenOf(player), true)).toBe(true);
    expect(heard.ended).toEqual([{ player, cutscene: "Intro", skipped: true }]);
  });

  test("a scene that is not skippable ignores a skip, unless it is within 2 s of its end", async () => {
    install(makeScene("Fixed", { skippable: false, duration: 10 }));
    const player = makePlayer();
    await sessions.play(player, "Fixed");
    // Before the client has begun there is no end to be near.
    expect(await sessions.onEnd(player, tokenOf(player), true)).toBe(false);
    sessions.onStarted(player, tokenOf(player));
    expect(await sessions.onEnd(player, tokenOf(player), true)).toBe(false);
    expect(player.cutscene).toBeDefined();
    // Seven seconds in, then 8.5: only the last is within 2 s of the end.
    player.cutscene.startedAt = Date.now() - 7_000;
    expect(await sessions.onEnd(player, tokenOf(player), true)).toBe(false);
    player.cutscene.startedAt = Date.now() - 8_500;
    expect(await sessions.onEnd(player, tokenOf(player), true)).toBe(true);
    expect(player.cutscene).toBeUndefined();
    // Ending without a skip is not a skip.
    await sessions.play(player, "Fixed");
    expect(await sessions.onEnd(player, tokenOf(player), false)).toBe(true);
  });
});

// ---------------------------------------------------------------------- the clock

describe("the clock", () => {
  test("a scene the client never begins is dropped when the 30 s are up, with no end to run, and the client is told", async () => {
    install(makeScene("Intro", { end: { teleport: { map: "cave", x: 5, y: 6 }, next: null } }));
    sessions.timing.pendingMs = 20;
    const player = makePlayer();
    await sessions.play(player, "Intro");
    const token = tokenOf(player);
    await tick(80);
    expect(player.cutscene).toBeUndefined();
    expect(sent.find((m) => m.type === "CUTSCENE_STOP")?.data).toEqual({ token });
    expect(heard.ended).toEqual([{ player, cutscene: "Intro", skipped: true }]);
    expect(moves).toEqual([]);
  });

  test("a scene that began and was never ended ends by itself, its end run as if the client had said so", async () => {
    install(makeScene("Short", { duration: 0.5, end: { teleport: { map: "cave", x: 5, y: 6 }, next: null } }));
    // The scene's length and 5 s, here 0.5 s less 480 ms.
    sessions.timing.graceMs = -480;
    const player = makePlayer();
    await sessions.play(player, "Short");
    sessions.onStarted(player, tokenOf(player));
    await tick(80);
    expect(player.cutscene).toBeUndefined();
    expect(sent.some((m) => m.type === "CUTSCENE_STOP")).toBe(true);
    expect(heard.ended).toEqual([{ player, cutscene: "Short", skipped: false }]);
    expect(moves).toHaveLength(1);
  });

  test("a hold ends by itself at the clock's end even if every timer failed", async () => {
    install(makeScene("Intro", { duration: 10 }));
    const player = makePlayer();
    await sessions.play(player, "Intro");
    sessions.onStarted(player, tokenOf(player));
    const endsAt = player.cutscene.clockEndsAt;
    expect(held.isHeld(player, endsAt - 1)).toBe(true);
    expect(held.isHeld(player, endsAt)).toBe(false);
    expect(held.isHeld(player, endsAt + 60_000)).toBe(false);
    // Nothing set to fire: the state is still there, and still holds no one.
    player.cutscene.clockEndsAt = Date.now() - 1;
    expect(player.cutscene).toBeDefined();
    expect(held.isHeld(player)).toBe(false);
  });

  test("isHeld is false without a scene, with one that does not lock, and with one that is done", () => {
    const now = Date.now();
    expect(held.isHeld(null)).toBe(false);
    expect(held.isHeld({})).toBe(false);
    expect(held.isHeld({ cutscene: { phase: "running", lock: true, clockEndsAt: now + 1000 } }, now)).toBe(true);
    expect(held.isHeld({ cutscene: { phase: "pending", lock: true, clockEndsAt: now + 1000 } }, now)).toBe(true);
    expect(held.isHeld({ cutscene: { phase: "running", lock: false, clockEndsAt: now + 1000 } }, now)).toBe(false);
    expect(held.isHeld({ cutscene: { phase: "done", lock: true, clockEndsAt: now + 1000 } }, now)).toBe(false);
    expect(held.isHeld({ cutscene: { phase: "running", lock: true, clockEndsAt: now - 1 } }, now)).toBe(false);
  });
});

// ----------------------------------------------------------------- the packets refused

describe("the packets a held player is refused", () => {
  const heldPlayer = () => ({ cutscene: { phase: "running", lock: true, clockEndsAt: Date.now() + 60_000 } });

  test("everything that acts on the world, and a step, but not the stop of a walk", () => {
    const who = heldPlayer();
    expect(held.refusedWhileHeld("MOVEXY", "left", who)).toBe(true);
    expect(held.refusedWhileHeld("MOVEXY", "up", who)).toBe(true);
    expect(held.refusedWhileHeld("MOVEXY", "abort", who)).toBe(false);
    expect(held.refusedWhileHeld("MOVEXY", "ABORT", who)).toBe(false);
    for (const type of [
      "ATTACK", "CREATURE_ATTACK", "HOTBAR", "MOUNT", "GATHER", "NPC_INTERACT", "PICKUP_LOOT", "BATCH_PICKUP_LOOT", "OPEN_LOOT_CHEST",
      "FISH_CAST", "FISH_REEL", "FISH_LAND", "USE_ITEM", "EQUIP_ITEM", "VENDOR_BUY", "QUEST_ACCEPT", "TRADE_REQUEST", "TELEPORTXY",
    ]) {
      expect(held.refusedWhileHeld(type, null, who)).toBe(true);
    }
  });

  test("but chat, the keepalive, the editors, logout and the scene's own packets flow", () => {
    const who = heldPlayer();
    for (const type of [
      "CHAT", "TYPING", "COMMAND", "PING", "PONG", "LOGOUT", "DISCONNECT", "CUTSCENE_STARTED", "CUTSCENE_END", "CUTSCENE_EDITOR_LIST",
      "MOUNT_EDITOR_SAVE", "CREATURE_EDITOR_LIST", "CANCEL_SPELL", "SELECTPLAYER", "FISH_CANCEL", "HANDOFF_GAP",
    ]) {
      expect(held.refusedWhileHeld(type, null, who)).toBe(false);
    }
  });

  test("and a player who is not held, or whose hold has run out, is refused nothing", () => {
    expect(held.refusedWhileHeld("MOVEXY", "left", {})).toBe(false);
    expect(held.refusedWhileHeld("MOVEXY", "left", null)).toBe(false);
    expect(held.refusedWhileHeld("HOTBAR", null, { cutscene: { phase: "running", lock: false, clockEndsAt: Date.now() + 1000 } })).toBe(false);
    expect(held.refusedWhileHeld("HOTBAR", null, { cutscene: { phase: "running", lock: true, clockEndsAt: Date.now() - 1 } })).toBe(false);
  });
});

// ----------------------------------------------------------------------- chains

describe("a chain of scenes", () => {
  test("moves the player to the next scene's map first, starts it there, and takes them home when the chain ends", async () => {
    install(
      makeScene("A", { end: { next: "B" } }),
      makeScene("B", { map: "cave", cameraAt: { x: 300, y: 400 } }),
    );
    const player = makePlayer();
    await sessions.play(player, "A");
    await sessions.onEnd(player, tokenOf(player), false);

    // To B's first camera key, then B itself, on the map it plays on.
    expect(moves).toEqual([{ who: player.username, map: "cave", x: 300, y: 400 }]);
    expect(playsOf().map((m) => m.data.doc.name)).toEqual(["A", "B"]);
    expect(player.cutscene).toMatchObject({ name: "B", depth: 1, origin: { map: "main", x: 10, y: 10, direction: "down" } });
    expect(held.isHeld(player)).toBe(true);
    expect(heard.started.map((e) => e.cutscene)).toEqual(["A", "B"]);

    await sessions.onEnd(player, tokenOf(player), false);
    expect(moves[1]).toEqual({ who: player.username, map: "main", x: 10, y: 10 });
    expect(player.cutscene).toBeUndefined();
    expect(heard.ended.map((e) => e.cutscene)).toEqual(["A", "B"]);
  });

  test("on the same map there is no move, and no home to go to", async () => {
    install(makeScene("A", { end: { next: "B" } }), makeScene("B"));
    const player = makePlayer();
    await sessions.play(player, "A");
    await sessions.onEnd(player, tokenOf(player), false);
    expect(player.cutscene).toMatchObject({ name: "B", origin: null });
    await sessions.onEnd(player, tokenOf(player), false);
    expect(moves).toEqual([]);
  });

  test("a last scene that places the player does, rather than taking them home", async () => {
    install(
      makeScene("A", { end: { next: "B" } }),
      makeScene("B", { map: "cave", end: { teleport: { map: "town", x: 7, y: 8 }, next: null } }),
    );
    const player = makePlayer();
    await sessions.play(player, "A");
    await sessions.onEnd(player, tokenOf(player), false);
    await sessions.onEnd(player, tokenOf(player), false);
    expect(moves.map((m) => m.map)).toEqual(["cave", "town"]);
  });

  test("a scene with no camera key starts the player at the map's spawn", async () => {
    cache.set("mapProperties", [{ name: "cave.json", width: 20, height: 10, tileWidth: 32, tileHeight: 32, spawn: { x: 64, y: 96 } }]);
    const bare = makeScene("B", { map: "cave" });
    bare.tracks = bare.tracks.filter((t) => t.kind !== "camera");
    install(makeScene("A", { end: { next: "B" } }), bare);
    const player = makePlayer();
    await sessions.play(player, "A");
    await sessions.onEnd(player, tokenOf(player), false);
    expect(moves[0]).toMatchObject({ map: "cave", x: 64, y: 96 });
  });

  test("a chain that goes round in a circle stops at the most scenes a chain plays", async () => {
    sessions.timing.maxChain = 3;
    install(makeScene("A", { end: { next: "B" } }), makeScene("B", { end: { next: "A" } }));
    const player = makePlayer();
    await sessions.play(player, "A");
    for (let i = 0; i < 6 && player.cutscene; i++) await sessions.onEnd(player, tokenOf(player), false);
    expect(player.cutscene).toBeUndefined();
    expect(playsOf().map((m) => m.data.doc.name)).toEqual(["A", "B", "A"]);
  });

  test("a scene whose next scene is gone just ends", async () => {
    install(makeScene("A", { end: { next: "Gone", teleport: { map: "cave", x: 1, y: 2 } } }));
    const player = makePlayer();
    await sessions.play(player, "A");
    await sessions.onEnd(player, tokenOf(player), false);
    expect(player.cutscene).toBeUndefined();
    // Its own teleport still runs.
    expect(moves).toEqual([{ who: player.username, map: "cave", x: 1, y: 2 }]);
  });

  test("a player who died in the scene is left where they lie", async () => {
    install(makeScene("A", { lock: false, end: { next: "B", teleport: { map: "cave", x: 1, y: 2 } } }), makeScene("B"));
    const player = makePlayer();
    await sessions.play(player, "A");
    player.isDead = true;
    await sessions.onEnd(player, tokenOf(player), false);
    expect(moves).toEqual([]);
    expect(playsOf()).toHaveLength(1);
  });
});

// ----------------------------------------------------------- stopped and disconnected

describe("stopping a scene, and a player leaving", () => {
  test("stopping tells the client and ends the scene with no end to run", async () => {
    install(makeScene("A", { end: { next: "B", teleport: { map: "cave", x: 1, y: 2 } } }), makeScene("B"));
    const player = makePlayer();
    await sessions.play(player, "A");
    const token = tokenOf(player);
    expect(await sessions.stop(player)).toBe(true);
    expect(sent.find((m) => m.type === "CUTSCENE_STOP")?.data).toEqual({ token });
    expect(player.cutscene).toBeUndefined();
    expect(heard.ended).toEqual([{ player, cutscene: "A", skipped: true }]);
    expect(moves).toEqual([]);
    expect(playsOf()).toHaveLength(1);
    // And nothing is left to stop.
    expect(await sessions.stop(player)).toBe(false);
  });

  test("a chain that moved the player is still taken home when it is stopped", async () => {
    install(makeScene("A", { end: { next: "B" } }), makeScene("B", { map: "cave" }));
    const player = makePlayer();
    await sessions.play(player, "A");
    await sessions.onEnd(player, tokenOf(player), false);
    moves.length = 0;
    await sessions.stop(player);
    expect(moves).toEqual([{ who: player.username, map: "main", x: 10, y: 10 }]);
  });

  test("a disconnect clears the timers and the state and does nothing else", async () => {
    install(makeScene("A", { duration: 1, marks: [{ name: "m", t: 0.05 }], end: { next: "B", teleport: { map: "cave", x: 1, y: 2 } } }), makeScene("B"));
    const player = makePlayer();
    await sessions.play(player, "A");
    sessions.onStarted(player, tokenOf(player));
    sent.length = 0;
    listener.emit(Events.PLAYER_DISCONNECT, { player });
    await tick(120);
    expect(player.cutscene).toBeUndefined();
    expect(held.isHeld(player)).toBe(false);
    expect(heard.ended).toEqual([]);
    expect(heard.mark).toEqual([]);
    expect(moves).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("a logout does the same, and so a player in the middle of a chain stays where they are", async () => {
    install(makeScene("A", { end: { next: "B" } }), makeScene("B", { map: "cave" }));
    const player = makePlayer();
    await sessions.play(player, "A");
    await sessions.onEnd(player, tokenOf(player), false);
    moves.length = 0;
    listener.emit(Events.PLAYER_LOGOUT, { player });
    expect(player.cutscene).toBeUndefined();
    expect(moves).toEqual([]);
    expect(player.location.map).toBe("cave");
  });

  test("a player who dies in a scene that does not lock is no longer watching it", async () => {
    install(makeScene("A", { lock: false, end: { teleport: { map: "cave", x: 1, y: 2 }, next: null } }));
    const player = makePlayer();
    await sessions.play(player, "A");
    player.isDead = true;
    listener.emit(Events.PLAYER_DEATH, { player });
    await tick();
    expect(player.cutscene).toBeUndefined();
    expect(moves).toEqual([]);
    expect(sent.some((m) => m.type === "CUTSCENE_STOP")).toBe(true);
  });
});

// ------------------------------------------------------------------------ triggers

describe("triggers", () => {
  test("an NPC's scene plays instead of the talk, and a scene that plays once has been seen the next time", async () => {
    install(makeScene("Greeting", { triggers: [trigger({ on: "npc", npcId: 7, once: true })] }));
    const player = makePlayer();
    expect(await sessions.onNpcInteract(player, 8)).toBe(false);
    expect(await sessions.onNpcInteract(player, 7)).toBe(true);
    expect(player.cutscene.name).toBe("Greeting");
    const insert = queries.find((q) => /INSERT .*INTO cutscene_views/.test(q.sql))!;
    expect(insert.params.slice(0, 2)).toEqual([player.username, "Greeting"]);
    expect(insert.params[2]).toBeGreaterThan(0);
    await sessions.onEnd(player, tokenOf(player), false);
    expect(await sessions.onNpcInteract(player, 7)).toBe(false);
    expect(writes()).toHaveLength(1);
  });

  test("what a character has seen is read once, from the table, when first needed", async () => {
    install(makeScene("Greeting", { triggers: [trigger({ on: "npc", npcId: 7, once: true })] }));
    viewRows = [{ cutscene: "greeting" }];
    const player = makePlayer();
    expect(await sessions.onNpcInteract(player, 7)).toBe(false);
    expect(await sessions.onNpcInteract(player, 7)).toBe(false);
    expect(queries.filter((q) => q.sql.startsWith("SELECT cutscene FROM cutscene_views"))).toHaveLength(1);
    expect(queries.find((q) => q.sql.startsWith("SELECT cutscene FROM cutscene_views"))!.params).toEqual([player.username]);
    expect(writes()).toHaveLength(0);
  });

  test("a scene that plays once is not played when the table cannot be read", async () => {
    install(makeScene("Greeting", { triggers: [trigger({ on: "npc", npcId: 7, once: true })] }));
    viewRows = null;
    expect(await sessions.onNpcInteract(makePlayer(), 7)).toBe(false);
  });

  test("a scene that plays every time asks the table nothing", async () => {
    install(makeScene("Greeting", { triggers: [trigger({ on: "npc", npcId: 7, once: false })] }));
    const player = makePlayer();
    expect(await sessions.onNpcInteract(player, 7)).toBe(true);
    await sessions.onEnd(player, tokenOf(player), false);
    expect(await sessions.onNpcInteract(player, 7)).toBe(true);
    expect(queries).toHaveLength(0);
  });

  test("a scene with a once trigger is seen however it began, and /cutscene reset lets the triggers play it again", async () => {
    install(makeScene("Greeting", { triggers: [trigger({ on: "npc", npcId: 7, once: true })] }));
    const player = makePlayer();
    expect(await sessions.play(player, "Greeting")).toBe(true);
    expect(writes()).toHaveLength(1);
    await sessions.onEnd(player, tokenOf(player), false);
    // The table now holds the row the start wrote.
    viewRows = [{ cutscene: "Greeting" }];
    expect(await sessions.onNpcInteract(player, 7)).toBe(false);
    expect(await sessions.resetViews("greeting", player.username.toUpperCase())).toBe(true);
    expect(queries.find((q) => q.sql === "DELETE FROM cutscene_views WHERE username = ? AND cutscene = ?")!.params).toEqual([player.username, "Greeting"]);
    expect(await sessions.onNpcInteract(player, 7)).toBe(true);
    expect(await sessions.resetViews("Nothing", player.username)).toBe(false);
  });

  test("the character's level has to be enough", async () => {
    install(makeScene("Veterans", { triggers: [trigger({ on: "npc", npcId: 7, minLevel: 10 })] }));
    expect(await sessions.onNpcInteract(makePlayer({ stats: { level: 9 } }), 7)).toBe(false);
    expect(await sessions.onNpcInteract(makePlayer({ stats: { level: 10 } }), 7)).toBe(true);
    expect(await sessions.onNpcInteract(makePlayer({ stats: undefined }), 7)).toBe(false);
  });

  test("no scene starts while one is running", async () => {
    install(
      makeScene("First", { triggers: [trigger({ on: "npc", npcId: 7 })] }),
      makeScene("Second", { triggers: [trigger({ on: "npc", npcId: 7 })] }),
    );
    const player = makePlayer();
    expect(await sessions.onNpcInteract(player, 7)).toBe(true);
    expect(player.cutscene.name).toBe("First");
    expect(await sessions.onNpcInteract(player, 7)).toBe(false);
    expect(playsOf()).toHaveLength(1);
  });

  test("a scene on another map is not offered, and a kind with no triggers does nothing at all", async () => {
    install(makeScene("Elsewhere", { map: "cave", triggers: [trigger({ on: "npc", npcId: 7, once: true })] }), makeScene("Plain"));
    const player = makePlayer();
    expect(await sessions.onNpcInteract(player, 7)).toBe(false);
    expect(await sessions.onQuest(player.username, "quest_accept", 4)).toBe(false);
    expect(await sessions.onMapEnter(player, "main")).toBe(false);
    expect(queries).toHaveLength(0);
  });

  test("when the first of two scenes on a trigger will not play, the second does", async () => {
    install(
      makeScene("Aaa", { triggers: [trigger({ on: "npc", npcId: 7, minLevel: 50 })] }),
      makeScene("Bbb", { triggers: [trigger({ on: "npc", npcId: 7 })] }),
    );
    const player = makePlayer();
    expect(await sessions.onNpcInteract(player, 7)).toBe(true);
    expect(player.cutscene.name).toBe("Bbb");
  });

  test("the index follows the cached list", async () => {
    cache.set("cutscenes", [makeScene("Greeting", { triggers: [trigger({ on: "npc", npcId: 7 })] })]);
    expect(await sessions.onNpcInteract(makePlayer(), 7)).toBe(false);
    await sessions.reindex();
    expect(await sessions.onNpcInteract(makePlayer(), 7)).toBe(true);
    cache.set("cutscenes", []);
    await sessions.reindex();
    expect(await sessions.onNpcInteract(makePlayer(), 7)).toBe(false);
  });

  test("entering a map starts the scenes of the map triggers on it", async () => {
    install(makeScene("CaveIntro", { map: "cave", triggers: [trigger({ on: "map" })] }), makeScene("MainIntro", { triggers: [trigger({ on: "map" })] }));
    const player = makePlayer({ location: { map: "cave", position: { x: 1, y: 1, direction: "down" } } });
    listener.emit(Events.MAP_ENTER, { player, mapName: "cave", position: { x: 1, y: 1 } });
    await tick(20);
    expect(player.cutscene?.name).toBe("CaveIntro");
  });

  test("accepting and completing a quest start the scenes of that quest's triggers", async () => {
    install(
      makeScene("Accepted", { triggers: [trigger({ id: "a", on: "quest_accept", questId: 4 })] }),
      makeScene("Completed", { triggers: [trigger({ id: "c", on: "quest_complete", questId: 4 })] }),
    );
    const accepting = enter(makePlayer());
    listener.emit(Events.QUEST_ACCEPTED, { username: accepting.username, questId: 9 });
    await tick(20);
    expect(accepting.cutscene).toBeUndefined();
    listener.emit(Events.QUEST_ACCEPTED, { username: accepting.username, questId: 4 });
    await tick(20);
    expect(accepting.cutscene?.name).toBe("Accepted");

    const completing = enter(makePlayer());
    listener.emit(Events.QUEST_COMPLETED, { username: completing.username, questId: 4, rewards: [] });
    await tick(20);
    expect(completing.cutscene?.name).toBe("Completed");
    // A quest of a player who is not here (another node's) is no one's to start.
    listener.emit(Events.QUEST_COMPLETED, { username: "nobody", questId: 4 });
    await tick(20);
  });

  test("a login starts the scenes of the login triggers once the player is in the world, and a handoff is not a login", async () => {
    sessions.timing.loginDelayMs = 5;
    install(makeScene("Welcome", { triggers: [trigger({ on: "login" })] }));
    const arriving = makePlayer({ wt: { readyState: 1, data: { handoffLanding: true } } });
    listener.emit(Events.PLAYER_AUTH_COMPLETE, { username: arriving.username });
    enter(arriving);
    await tick(30);
    expect(arriving.cutscene).toBeUndefined();

    const player = makePlayer({ wt: { readyState: 1, data: {} } });
    listener.emit(Events.PLAYER_AUTH_COMPLETE, { username: player.username });
    // Not yet: the auth is done but the player is not in the world.
    await tick(30);
    expect(player.cutscene).toBeUndefined();
    enter(player);
    await tick(30);
    expect(player.cutscene?.name).toBe("Welcome");
  });

  test("walking into an area starts its scene once, and again only after leaving it and coming back", async () => {
    install(makeScene("Gate", { triggers: [trigger({ on: "area", x: 0, y: 0, w: 100, h: 100 })] }));
    const player = enter(makePlayer());
    player.location.position.x = 500;
    player.location.position.y = 500;
    await sessions.tickAreas();
    expect(player.cutscene).toBeUndefined();

    player.location.position.x = 50;
    player.location.position.y = 50;
    await sessions.tickAreas();
    expect(player.cutscene?.name).toBe("Gate");

    // Still standing in it when the scene is over: not again.
    await sessions.onEnd(player, tokenOf(player), false);
    await sessions.tickAreas();
    expect(player.cutscene).toBeUndefined();

    player.location.position.x = 500;
    await sessions.tickAreas();
    player.location.position.x = 50;
    await sessions.tickAreas();
    expect(player.cutscene?.name).toBe("Gate");
    expect(playsOf()).toHaveLength(2);
  });

  test("an area is a rectangle: its far edges are outside it", async () => {
    install(makeScene("Gate", { triggers: [trigger({ on: "area", x: 10, y: 20, w: 30, h: 40 })] }));
    const player = enter(makePlayer());
    for (const [x, y] of [[40, 30], [20, 60], [9, 30], [20, 19]]) {
      player.location.position.x = x;
      player.location.position.y = y;
      await sessions.tickAreas();
      expect(player.cutscene).toBeUndefined();
    }
    player.location.position.x = 10;
    player.location.position.y = 20;
    await sessions.tickAreas();
    expect(player.cutscene?.name).toBe("Gate");
  });

  test("only the players on the maps that have an area are looked at", async () => {
    install(makeScene("Gate", { triggers: [trigger({ on: "area", x: 0, y: 0, w: 100, h: 100 })] }));
    const there = enter(makePlayer({ location: { map: "cave", position: { x: 50, y: 50, direction: "down" } } }));
    const here = enter(makePlayer());
    await sessions.tickAreas();
    expect(there.cutscene).toBeUndefined();
    expect(here.cutscene?.name).toBe("Gate");
  });

  test("the area's scene is once, level-gated and one-at-a-time like any other", async () => {
    install(makeScene("Gate", { triggers: [trigger({ on: "area", x: 0, y: 0, w: 100, h: 100, once: true, minLevel: 3 })] }));
    const low = enter(makePlayer({ stats: { level: 2 } }));
    const high = enter(makePlayer({ stats: { level: 3 } }));
    await sessions.tickAreas();
    expect(low.cutscene).toBeUndefined();
    expect(high.cutscene?.name).toBe("Gate");
    expect(writes()).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------- commands

describe("/cutscene", () => {
  const admin = () => makePlayer({ isAdmin: true, permissions: [] });

  test("is for those who may use the editor", async () => {
    install(makeScene("Intro"));
    const player = makePlayer({ permissions: ["chat.say"] });
    expect(await sessions.runCommand(player, ["play", "Intro"])).toEqual(["You don't have permission to use this command"]);
    expect(player.cutscene).toBeUndefined();
    const director = makePlayer({ permissions: ["tools.cutscene_editor"] });
    expect(await sessions.runCommand(director, ["list"])).toEqual(["Cutscenes (1): Intro"]);
  });

  test("lists the scenes", async () => {
    expect(await sessions.runCommand(admin(), ["list"])).toEqual(["There are no cutscenes"]);
    install(makeScene("Zeta"), makeScene("Alpha"));
    expect(await sessions.runCommand(admin(), ["list"])).toEqual(["Cutscenes (2): Alpha, Zeta"]);
  });

  test("plays a scene to yourself, to a player, or to every player on your map", async () => {
    install(makeScene("Intro"));
    const me = admin();
    expect(await sessions.runCommand(me, ["play", "intro"])).toEqual(["Playing Intro to you"]);
    expect(me.cutscene.name).toBe("Intro");

    const other = enter(makePlayer());
    expect(await sessions.runCommand(me, ["play", "Intro", other.username.toUpperCase()])).toEqual([`Playing Intro to ${other.username}`]);
    expect(other.cutscene.name).toBe("Intro");

    // Every player on the map, the admin too: the dead one cannot watch, and the one who already is does not start over.
    const third = enter(makePlayer());
    const dead = enter(makePlayer({ isDead: true }));
    const admin2 = enter(makePlayer({ isAdmin: true, permissions: [] }));
    const result = await sessions.runCommand(admin2, ["play", "Intro", "map"]);
    expect(result).toEqual(["Playing Intro to 2 players on main (2 could not watch it)"]);
    expect(third.cutscene?.name).toBe("Intro");
    expect(admin2.cutscene?.name).toBe("Intro");
    expect(dead.cutscene).toBeUndefined();
    expect(other.cutscene.token).not.toBe(third.cutscene.token);
  });

  test("says why a scene could not be played, and what there is not", async () => {
    install(makeScene("Intro"));
    expect(await sessions.runCommand(admin(), ["play", "Nope"])).toEqual(["There is no cutscene called Nope"]);
    expect(await sessions.runCommand(admin(), ["play", "Intro", "ghosty"])).toEqual(["ghosty is not online on this server"]);
    expect(await sessions.runCommand(admin(), ["play"])).toEqual([expect.stringContaining("Use /cutscene")]);
    expect(await sessions.runCommand(admin(), [])).toEqual([expect.stringContaining("Use /cutscene")]);
    const away = admin();
    away.location.map = "cave";
    expect(await sessions.runCommand(away, ["play", "Intro"])).toEqual(["Intro could not be played to you: Intro plays on main, not here"]);
  });

  test("stops the scene of yourself or of a player", async () => {
    install(makeScene("Intro"));
    const me = admin();
    expect(await sessions.runCommand(me, ["stop"])).toEqual(["You are not in a cutscene"]);
    await sessions.play(me, "Intro");
    expect(await sessions.runCommand(me, ["stop"])).toEqual(["Stopped the cutscene of you"]);
    expect(me.cutscene).toBeUndefined();

    const other = enter(makePlayer());
    await sessions.play(other, "Intro");
    expect(await sessions.runCommand(me, ["stop", other.username])).toEqual([`Stopped the cutscene of ${other.username}`]);
    expect(await sessions.runCommand(me, ["stop", "ghosty"])).toEqual(["ghosty is not online on this server"]);
  });

  test("resets what a character has seen, online or not", async () => {
    install(makeScene("Intro"));
    expect(await sessions.runCommand(admin(), ["reset", "Intro", "somebody"])).toEqual(["somebody has not seen Intro now: it plays for them again"]);
    expect(queries.find((q) => q.sql.startsWith("DELETE FROM cutscene_views"))!.params).toEqual(["somebody", "Intro"]);
    expect(await sessions.runCommand(admin(), ["reset", "Nope", "somebody"])).toEqual(["There is no cutscene called Nope"]);
    expect(await sessions.runCommand(admin(), ["reset", "Intro"])).toEqual([expect.stringContaining("Use /cutscene")]);
  });
});

describe("the harm a held player is kept from", () => {
  test("a damage over time passes over them, and bites again once they are let go", async () => {
    const { applyDot, clearDots } = await import("../systems/dots");
    const target: any = {
      id: "held-dot", username: "Held", stats: { health: 100, total_max_health: 100 },
      cutscene: { phase: "running", lock: true, clockEndsAt: Date.now() + 60_000 },
    };
    playerCache.add(target.id, target);
    try {
      await applyDot(null, target, { name: "Poison" } as any, { type: "damage_over_time", value: 5, duration: 5, interval: 0.05 } as any);
      await Bun.sleep(400);
      expect(target.stats.health).toBe(100);
      target.cutscene = undefined;
      await Bun.sleep(400);
      expect(target.stats.health).toBeLessThan(100);
    } finally {
      clearDots(target.id);
      playerCache.remove(target.id);
    }
  });

  test("every area spell and ground zone asks before it hurts", async () => {
    const source = (file: string) => Bun.file(new URL(file, import.meta.url)).text();
    const combat = await source("../socket/handlers/combat.ts");
    expect(combat.match(/isHeld\(p\)\) continue;/g)?.length).toBe(3);
    expect(await source("../systems/groundaoe.ts")).toContain("if (isHeld(player)) continue;");
  });
});

describe("changing server node", () => {
  /** The session as the new node reads it: over the link and through its own check. */
  const carried = (player: any, now = Date.now()) => {
    const record = JSON.parse(JSON.stringify({ cutscene: sessions.carriedScene(player) }));
    return handoffStateOf(record, arrivalLimits([], now), "Probe").cutscene;
  };
  /** The same player as the new node makes them: a new object with an id of its own. */
  const landed = (player: any) => enter(makePlayer({ username: player.username }));

  test("the new node takes the session over: the same showing and clock, the player held, and nothing sent", async () => {
    install(makeScene("A", { duration: 10 }));
    const old = enter(makePlayer());
    await sessions.play(old, "A");
    sessions.onStarted(old, tokenOf(old));
    const token = tokenOf(old);
    const endsAt = old.cutscene.clockEndsAt;

    const scene = carried(old)!;
    sessions.clear(old);
    playerCache.remove(old.id);
    expect(old.cutscene).toBeUndefined();
    sent.length = 0;
    const there = landed(old);
    sessions.adopt(there, scene);

    expect(tokenOf(there)).toBe(token);
    expect(there.cutscene.phase).toBe("running");
    expect(there.cutscene.clockEndsAt).toBeGreaterThanOrEqual(endsAt - 1);
    expect(there.cutscene.clockEndsAt).toBeLessThanOrEqual(endsAt + 50);
    expect(held.isHeld(there)).toBe(true);
    expect(sent).toEqual([]);
    expect(heard.ended).toEqual([]);

    await sessions.onEnd(there, token, false);
    expect(heard.ended.map((e) => e.cutscene)).toEqual(["A"]);
    expect(held.isHeld(there)).toBe(false);
  });

  test("a client repeating what it told the old node changes nothing", async () => {
    install(makeScene("A", { duration: 10, marks: [{ name: "m", t: 5 }] }));
    const old = enter(makePlayer());
    await sessions.play(old, "A");
    sessions.onStarted(old, tokenOf(old));
    const scene = carried(old)!;
    sessions.clear(old);
    const there = landed(old);
    sessions.adopt(there, scene);
    const startedAt = there.cutscene.startedAt;
    await tick(2);
    expect(sessions.onStarted(there, tokenOf(there))).toBe(false);
    expect(there.cutscene.startedAt).toBe(startedAt);
  });

  test("a scene not begun yet is carried as that: the client's word begins it on the new node", async () => {
    install(makeScene("A", { duration: 10 }));
    const old = enter(makePlayer());
    await sessions.play(old, "A");
    const scene = carried(old)!;
    expect(scene.phase).toBe("pending");
    sessions.clear(old);
    const there = landed(old);
    sessions.adopt(there, scene);
    expect(sessions.onStarted(there, tokenOf(there))).toBe(true);
    expect(there.cutscene.phase).toBe("running");
  });

  test("each mark fires once: the old node's before the move, the new node's after", async () => {
    install(makeScene("A", { duration: 1, marks: [{ name: "before", t: 0 }, { name: "after", t: 0.06 }] }));
    const old = enter(makePlayer());
    await sessions.play(old, "A");
    sessions.onStarted(old, tokenOf(old));
    await tick(20);
    expect(heard.mark.map((m) => m.name)).toEqual(["before"]);

    const scene = carried(old)!;
    sessions.clear(old);
    const there = landed(old);
    sessions.adopt(there, scene);
    await tick(90);
    expect(heard.mark.map((m) => m.name)).toEqual(["before", "after"]);
    expect(heard.mark[1].player).toBe(there);
  });

  test("a clock that runs out as the player changes node waits for them to land", async () => {
    sessions.timing.pendingMs = 5;
    sessions.timing.landingMs = 15;
    install(makeScene("A"));
    const old = enter(makePlayer());
    await sessions.play(old, "A");
    old.handoff = true;
    await tick(30);
    expect(old.cutscene?.phase).toBe("pending");
    expect(heard.ended).toEqual([]);
    expect(sent.filter((m) => m.type === "CUTSCENE_STOP")).toEqual([]);

    // The handoff was refused: the player stayed, and the scene ends here.
    old.handoff = false;
    await tick(30);
    expect(heard.ended).toHaveLength(1);
  });

  test("a clock gone by the arrival runs the end once the player has landed", async () => {
    sessions.timing.landingMs = 5;
    install(makeScene("A", { end: { teleport: { map: "cave", x: 1, y: 2 } } }));
    const old = enter(makePlayer());
    await sessions.play(old, "A");
    sessions.onStarted(old, tokenOf(old));
    const scene = carried(old)!;
    sessions.clear(old);
    const there = landed(old);
    sessions.adopt(there, { ...scene, clockEndsAt: Date.now() - 1000 });
    expect(held.isHeld(there)).toBe(true);
    await tick(25);
    expect(sent.filter((m) => m.type === "CUTSCENE_STOP").map((m) => m.to)).toEqual([there.username]);
    expect(moves).toEqual([{ who: there.username, map: "cave", x: 1, y: 2 }]);
  });

  test("a chain onto another node's ground goes with the player, and is taken home at its end", async () => {
    sessions.timing.loginDelayMs = 0;
    install(makeScene("A", { end: { next: "B" } }), makeScene("B", { map: "cave", duration: 10 }));
    const old = enter(makePlayer());
    await sessions.play(old, "A");
    sessions.onStarted(old, tokenOf(old));
    const token = tokenOf(old);

    // The move is a handoff: the node takes its snapshot inside it, and the player is gone when it returns.
    let chain = null as ReturnType<typeof sessions.carriedChain>;
    sessions.setCutsceneBridge({
      ...fakeBridge,
      teleport: async (player) => {
        chain = sessions.carriedChain(player);
        player.handoff = true;
      },
    });
    try {
      await sessions.onEnd(old, token, false);
    } finally {
      sessions.setCutsceneBridge(fakeBridge);
    }
    expect(chain).toEqual({ name: "B", origin: { map: "main", x: 10, y: 10, direction: "down" }, depth: 1 });
    expect(sessions.carriedChain(old)).toBeNull();
    expect(playsOf().map((m) => m.data.doc.name)).toEqual(["A"]);

    const record = JSON.parse(JSON.stringify({ cutsceneChain: chain }));
    const arriving = handoffStateOf(record, arrivalLimits([]), "Probe").cutsceneChain!;
    const there = landed({ username: old.username });
    there.location.map = "cave";
    sessions.adoptChain(there, arriving);
    await tick(10);
    expect(playsOf().map((m) => m.data.doc.name)).toEqual(["A", "B"]);
    expect(there.cutscene.depth).toBe(1);

    await sessions.onEnd(there, tokenOf(there), false);
    expect(moves).toEqual([{ who: there.username, map: "main", x: 10, y: 10 }]);
  });

  test("a chain whose scene cannot begin on the new node takes the player home", async () => {
    sessions.timing.loginDelayMs = 0;
    install();
    const there = enter(makePlayer());
    sessions.adoptChain(there, { name: "Gone", origin: { map: "main", x: 1, y: 2, direction: "down" }, depth: 1 });
    await tick(10);
    expect(moves).toEqual([{ who: there.username, map: "main", x: 1, y: 2 }]);
  });

  test("landing in a trigger's area is not walking into it", async () => {
    install(makeScene("Area", { triggers: [trigger({ on: "area", x: 0, y: 0, w: 100, h: 100 })] }));
    enter(makePlayer({ wt: { readyState: 1, data: { handoffLanding: true } } }));
    await sessions.tickAreas();
    expect(playsOf()).toEqual([]);
  });

  test("the limits the arrival checks a scene by are the store's and the sessions'", () => {
    expect(SCENE_LIMITS).toEqual({
      nameMax: scenes.LIMITS.nameMax, durationMax: scenes.LIMITS.durationMax,
      marksMax: scenes.LIMITS.itemsPerDocMax, chainMax: DEFAULT_TIMING.maxChain,
    });
    expect(SCENE_CLOCK_SLACK_MS).toBe(DEFAULT_TIMING.pendingMs);
    expect(SCENE_CLOCK_SLACK_MS).toBeGreaterThanOrEqual(DEFAULT_TIMING.graceMs);
  });

  test("what could not be a session of this node's rules is dropped", () => {
    const now = Date.now();
    const good = {
      name: "A", token: "0123456789abcdef0123456789abcdef", lock: true, phase: "running", clockEndsAt: now + 5000, startedAt: now - 1000,
      duration: 10, skippable: true, end: { next: null, teleport: null }, origin: null, depth: 0, marks: [{ name: "m", t: 1 }], at: now,
    };
    const read = (cutscene: unknown, record: Record<string, unknown> = {}) => handoffStateOf({ cutscene, ...record }, arrivalLimits([], now), "Probe").cutscene;

    expect(read(good)).toEqual(good as any);
    expect(read(null)).toBeNull();
    expect(read(good, { deadState: 1 })).toBeNull();
    for (const bad of [
      { name: "" }, { name: "x".repeat(65) }, { token: "short" }, { phase: "done" }, { duration: 0 }, { duration: 601 },
      { clockEndsAt: now + 10 * 60 * 60_000 }, { startedAt: now + 60_000 }, { at: "soon" }, { depth: -1 }, { depth: 17 },
      { end: null }, { end: { next: 5, teleport: null } }, { end: { next: null, teleport: { map: "cave" } } }, { origin: { x: 1 } },
      { marks: "m" }, { marks: [{ name: "m", t: -1 }] }, { marks: Array.from({ length: 4001 }, () => ({ name: "m", t: 1 })) },
    ]) {
      expect(read({ ...good, ...bad })).toBeNull();
    }
  });

  test("what could not be a chain is dropped", () => {
    const read = (cutsceneChain: unknown) => handoffStateOf({ cutsceneChain }, arrivalLimits([]), "Probe").cutsceneChain;
    expect(read({ name: "B", origin: null, depth: 1 })).toEqual({ name: "B", origin: null, depth: 1 });
    expect(read({ name: "", origin: null, depth: 1 })).toBeNull();
    expect(read({ name: "B", origin: null, depth: 16 })).toBeNull();
    expect(read({ name: "B", origin: { x: 1 }, depth: 1 })).toBeNull();
  });
});

describe("admins and a held player", () => {
  test("the admin is told how to end the scene", () => {
    expect(held.heldNote({ username: "hero" }, "Hero")).toBe("You are in a cutscene; /cutscene stop ends it");
    expect(held.heldNote({ username: "hero" }, "someone")).toBe("Hero is in a cutscene; /cutscene stop hero ends it");
  });

  test("every command that moves or kills a player asks first", () => {
    const source = readFileSync(join(import.meta.dir, "..", "socket", "handlers", "commands.ts"), "utf8");
    for (const name of ["DRAG_PLAYER_START", "SUMMON", "TELEPORT", "RESPAWN", "KILL", "WARP"]) {
      const from = source.indexOf(`case "${name}":`);
      expect(from).toBeGreaterThan(-1);
      const rest = source.slice(from + 1);
      const body = rest.slice(0, rest.search(/\n\s*case "/));
      expect(`${name}: ${body.includes("heldInScene(")}`).toBe(`${name}: true`);
    }
  });

  test("the player editor refuses to move one", () => {
    const source = readFileSync(join(import.meta.dir, "..", "systems", "playereditor.ts"), "utf8");
    expect(source).toContain('if (isHeld(live)) return [heldNote(live, "")];');
  });
});

describe("deleting a scene others go on to", () => {
  test("clears their end.next and names them", async () => {
    const gone = makeScene("B");
    install(makeScene("A", { end: { next: "b" } }), gone, makeScene("C", { end: { next: "Other" } }));
    expect(await scenes.removeScene(gone, "admin")).toEqual(["A"]);
    const left = cache.get("cutscenes") as any[];
    expect(left.map((s) => s.name).sort()).toEqual(["A", "C"]);
    expect(left.find((s) => s.name === "A").end.next).toBeNull();
    expect(left.find((s) => s.name === "C").end.next).toBe("Other");
  });
});

describe("the events", () => {
  test("are named for the plugins", () => {
    expect(Events.CUTSCENE_STARTED).toBe("onCutsceneStarted");
    expect(Events.CUTSCENE_ENDED).toBe("onCutsceneEnded");
    expect(Events.CUTSCENE_MARK).toBe("onCutsceneMark");
  });
});
