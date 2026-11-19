import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { characterDatabaseModule, withLeaveSaves } from "./setup";

// Row 41(b) of cells phase 7: a leave (a disconnect or a handoff) writes the achievement progress, and keeps the
// effects and sickness for a later login here, only while this node owns the player. server.ts cannot be imported (it
// starts the server), so the leave paths are run from its source with the names they use handed in. The achievement
// store, the effect manager and the sickness map are the real ones; only the database is stubbed.
mock.module("../controllers/sqldatabase", () => characterDatabaseModule({
  default: async (_sql: string, _params?: any[]) => [],
}));

const store = await import("../systems/achievements/store");
const { default: effectManager } = await import("../services/effectmanager");
const resurrection = await import("../systems/resurrection");
const { default: realPlayerCache } = await import("../services/playermanager");
const { fencedSaves } = await import("../cluster/ownerepoch");

const transpiler = new Bun.Transpiler({ loader: "ts" });
const serverSource = readFileSync(join(import.meta.dir, "..", "socket", "server.ts"), "utf8");

/** `source` from where `from` starts up to the first match of `until` after it. */
function cut(source: string, from: string, until: RegExp): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`Not found in the source: ${from}`);
  const rest = source.slice(start);
  const end = rest.search(until);
  if (end < 0) throw new Error(`No end found for: ${from}`);
  return rest.slice(0, end);
}

/** Code that names `names`, made into a function of them. */
function withNames(names: string[], code: string): (given: Record<string, any>) => any {
  return new Function(`"use strict";\n${transpiler.transformSync(`function make({ ${names.join(", ")} }: any) { ${code} }`)}\nreturn make;`)();
}

/** The top-level function that starts with `head` ("function name(" or "async function name(") in the server source. */
const functionOf = (head: string) => `${cut(serverSource, head, /\r?\n}\r?\n/)}\n}`;

// What each run sees: the sessions live here, the progress each flush would write, what was dropped.
let live: Record<string, any> = {};
let flushed: Array<{ username: string; progress: Array<[number, number]> }> = [];
let forgottenRows: string[] = [];
let forgottenSickness: string[] = [];
let errors: string[] = [];
const order: string[] = [];
const quiet = { info: () => {}, warn: () => {}, debug: () => {}, success: () => {}, error: (e: any) => errors.push(String(e)) };

const playerCache = {
  get: (id: string) => live[id],
  getByUsername: (username: string) => Object.values(live).find((p: any) => p.username?.toLowerCase() === username.toLowerCase()),
};
// The achievement module's onLeave flushes what waits in the store: the test reads what that would be.
const achievements = {
  onLeave: async ({ player }: any) => {
    order.push("flush");
    flushed.push({ username: player.username, progress: [...store.changedOf(player.username)] });
  },
};

const helperNames = ["changedOf", "clearChanged", "markChanged", "forgetRows", "playerCache", "achievements", "log", "effectManager", "forgetSickness"];
const helpers = withNames(
  helperNames,
  `${functionOf("function takeAchievementProgress(")}\n${functionOf("async function settleFencedLeave(")}\nreturn { takeAchievementProgress, settleFencedLeave };`,
)({
  changedOf: store.changedOf,
  clearChanged: store.clearChanged,
  markChanged: store.markChanged,
  forgetRows: async (username: string) => {
    forgottenRows.push(username);
    await store.forgetRows(username);
  },
  playerCache,
  achievements,
  log: quiet,
  effectManager,
  forgetSickness: (p: any) => {
    forgottenSickness.push(p.username);
    resurrection.forgetSickness(p);
  },
});
const { takeAchievementProgress, settleFencedLeave } = helpers;

/** Leftovers kept here for a later login of `username`: the saved effects and the sickness. */
function keepLeftovers(username: string): void {
  const lower = username.toLowerCase();
  effectManager.saveDots(lower, [{ id: "burn", expiresAt: Date.now() + 60_000 }]);
  effectManager.saveBarriers(lower, [{ id: "shield", expiresAt: 0 }]);
  effectManager.saveStuns(lower, [{ expiresAt: Date.now() + 60_000 }]);
  effectManager.saveSlows(lower, [{ expiresAt: Date.now() + 60_000 }]);
  resurrection.saveOnDisconnect({ username, resurrectionSickUntil: Date.now() + 60_000 });
}

/** Whether the leftovers of `username` are still kept here. */
function leftoversKept(username: string): { effects: boolean; sick: boolean } {
  const lower = username.toLowerCase();
  const effects = effectManager._playerDots.has(lower) && effectManager._playerBarriers.has(lower)
    && effectManager._playerStuns.has(lower) && effectManager._playerSlows.has(lower);
  const probe: any = { id: `probe-${username}`, username, stats: {} };
  const sick = resurrection.restoreOnLogin(probe);
  if (sick) {
    // restoreOnLogin arms a timer and caches the probe: put the sickness back for the next look, and drop the probe
    // (other test files share the player cache).
    resurrection.forgetSickness(probe);
    resurrection.saveOnDisconnect({ username, resurrectionSickUntil: probe.resurrectionSickUntil });
  }
  realPlayerCache.remove(probe.id);
  return { effects, sick };
}

function clearLeftovers(username: string): void {
  const lower = username.toLowerCase();
  effectManager.saveDots(lower, []);
  effectManager.saveBarriers(lower, []);
  effectManager.saveStuns(lower, []);
  effectManager.saveSlows(lower, []);
  resurrection.forgetSickness({ id: "none", username });
}

beforeEach(() => {
  live = {};
  flushed = [];
  forgottenRows = [];
  forgottenSickness = [];
  errors = [];
  order.length = 0;
  store.resetChanges();
});

afterEach(() => {
  clearLeftovers("alice");
  store.resetChanges();
});

describe("takeAchievementProgress and settleFencedLeave", () => {
  test("taking the progress leaves nothing in the store for a flush to write", () => {
    store.markChanged("alice", 1, 5);
    store.markChanged("alice", 2, 3);
    const taken = takeAchievementProgress("alice");
    expect([...taken]).toEqual([[1, 5], [2, 3]]);
    expect(store.changedOf("alice").size).toBe(0);
  });

  test("an owned leave gives the progress back, under anything higher counted since, and flushes it", async () => {
    store.markChanged("alice", 1, 5);
    store.markChanged("alice", 2, 3);
    const taken = takeAchievementProgress("alice");
    store.markChanged("alice", 2, 9);
    keepLeftovers("alice");
    await settleFencedLeave({ id: "p1", username: "alice" }, true, taken);
    expect(flushed).toEqual([{ username: "alice", progress: [[2, 9], [1, 5]] }]);
    expect(leftoversKept("alice")).toEqual({ effects: true, sick: true });
    expect(forgottenRows).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("a leave whose save threw is treated as owned: nothing is lost", async () => {
    store.markChanged("alice", 1, 5);
    const taken = takeAchievementProgress("alice");
    keepLeftovers("alice");
    await settleFencedLeave({ id: "p1", username: "alice" }, null, taken);
    expect(flushed).toEqual([{ username: "alice", progress: [[1, 5]] }]);
    expect(leftoversKept("alice")).toEqual({ effects: true, sick: true });
  });

  test("a refused leave drops the progress, the effects and the sickness kept here, and writes nothing", async () => {
    store.markChanged("alice", 1, 5);
    const taken = takeAchievementProgress("alice");
    store.markChanged("alice", 3, 2);
    keepLeftovers("alice");
    await settleFencedLeave({ id: "p1", username: "alice" }, false, taken);
    expect(flushed).toEqual([]);
    expect(store.changedOf("alice").size).toBe(0);
    expect(forgottenRows).toEqual(["alice"]);
    expect(forgottenSickness).toEqual(["alice"]);
    expect(leftoversKept("alice")).toEqual({ effects: false, sick: false });
    expect(errors).toEqual([]);
  });

  test("a refused leave with a newer session of the player live here drops nothing: this node owns the player", async () => {
    store.markChanged("alice", 1, 5);
    const taken = takeAchievementProgress("alice");
    keepLeftovers("alice");
    live = { p2: { id: "p2", username: "Alice" } };
    await settleFencedLeave({ id: "p1", username: "alice" }, false, taken);
    expect(flushed).toEqual([{ username: "alice", progress: [[1, 5]] }]);
    expect(leftoversKept("alice")).toEqual({ effects: true, sick: true });
    expect(forgottenRows).toEqual([]);
  });

  test("the leaving session itself still in the cache (a handoff) is not a newer session", async () => {
    store.markChanged("alice", 1, 5);
    const taken = takeAchievementProgress("alice");
    keepLeftovers("alice");
    const leaving = { id: "p1", username: "alice" };
    live = { p1: leaving };
    await settleFencedLeave(leaving, false, taken);
    expect(flushed).toEqual([]);
    expect(leftoversKept("alice")).toEqual({ effects: false, sick: false });
  });
});

describe("the disconnect", () => {
  const listenerNames = [
    "playerCache", "packetManager", "effectManager", "dots", "getStunsForPlayer", "getSlowsForPlayer", "saveSicknessOnDisconnect",
    "loot", "cleanupPlayerState", "releaseDraggedBy", "listener", "Events", "removeFromAuthenticationQueues", "worlds", "log", "player",
    "console", "forgetPlayer", "fencedSaves", "clusterEnabled", "isOnline", "tellContactsOffline", "takeAchievementProgress", "settleFencedLeave",
    "saveLeavingEffects", "saveLeavingState",
  ];
  const make = withNames(
    listenerNames,
    `return ${cut(serverSource, 'listener.on("onDisconnect", ', /\r?\n}\);\r?\n/).replace('listener.on("onDisconnect", ', "")}\n};`,
  );

  /** The listener, with the save answering `answer` and the PLAYER_DISCONNECT flush seen as the achievement module does it. */
  function onDisconnect(answer: "saved" | "fenced", over: Record<string, any> = {}) {
    return make(withLeaveSaves({
      playerCache: { ...playerCache },
      packetManager: { notify: () => [{}], updateOnlineStatus: () => [{}] },
      effectManager,
      dots: { getPlayerDots: () => [{ id: "burn", expiresAt: Date.now() + 60_000 }] },
      getStunsForPlayer: () => [{ expiresAt: Date.now() + 60_000 }],
      getSlowsForPlayer: () => [{ expiresAt: Date.now() + 60_000 }],
      saveSicknessOnDisconnect: resurrection.saveOnDisconnect,
      loot: { scheduleCleanup: () => {} },
      cleanupPlayerState: (p: any) => { delete live[p.id]; },
      releaseDraggedBy: () => {},
      listener: { emit: (_event: string, payload: any) => void achievements.onLeave(payload) },
      Events: { PLAYER_DISCONNECT: "onPlayerDisconnect" },
      removeFromAuthenticationQueues: () => {},
      worlds: { adjustPlayerCount: async () => 0 },
      log: quiet,
      player: {
        saveFenced: async () => answer,
        setStats: async () => {},
        setLocation: async () => {},
        clearSessionId: async () => {},
      },
      console: { error: () => {} },
      forgetPlayer: async () => {},
      fencedSaves,
      clusterEnabled: () => false,
      isOnline: async () => false,
      tellContactsOffline: async () => {},
      takeAchievementProgress,
      settleFencedLeave,
      ...over,
    }));
  }

  const alice = (more: Record<string, any> = {}) => ({
    id: "p1", username: "alice", barriers: [{ id: "shield", expiresAt: 0 }], resurrectionSickUntil: Date.now() + 60_000,
    stats: { health: 7 }, location: { map: "main", position: { x: 1, y: 2 } }, ...more,
  });

  test("a disconnect refused by the fence flushes no progress and keeps no effects or sickness here", async () => {
    store.markChanged("alice", 1, 5);
    live = { p1: alice({ ownerEpoch: 4 }) };
    await onDisconnect("fenced")({ id: "p1", reason: "player_left" });
    expect(flushed).toEqual([{ username: "alice", progress: [] }]);
    expect(store.changedOf("alice").size).toBe(0);
    expect(leftoversKept("alice")).toEqual({ effects: false, sick: false });
    expect(errors).toEqual([]);
  });

  test("an owned disconnect flushes its progress after the save, and keeps the effects and sickness here", async () => {
    store.markChanged("alice", 1, 5);
    live = { p1: alice({ ownerEpoch: 4 }) };
    await onDisconnect("saved")({ id: "p1", reason: "player_left" });
    expect(flushed).toEqual([{ username: "alice", progress: [] }, { username: "alice", progress: [[1, 5]] }]);
    expect(leftoversKept("alice")).toEqual({ effects: true, sick: true });
    expect(errors).toEqual([]);
  });

  test("a fenced player with no location saves nothing, and flushes the progress and keeps the leftovers, owner unknown (review m4)", async () => {
    store.markChanged("alice", 1, 5);
    live = { p1: alice({ ownerEpoch: 4, location: null }) };
    await onDisconnect("fenced")({ id: "p1", reason: "player_left" });
    expect(flushed).toEqual([{ username: "alice", progress: [] }, { username: "alice", progress: [[1, 5]] }]);
    expect(leftoversKept("alice")).toEqual({ effects: true, sick: true });
    expect(forgottenRows).toEqual([]);
  });

  test("a throw before the fenced save answered gives the progress back and flushes it", async () => {
    store.markChanged("alice", 1, 5);
    live = { p1: alice({ ownerEpoch: 4, wt: { data: { id: "p1", connectionToken: "t" } } }) };
    await onDisconnect("fenced", { removeFromAuthenticationQueues: () => { throw new Error("queue gone"); } })({ id: "p1", reason: "player_left" });
    expect(flushed).toEqual([{ username: "alice", progress: [] }, { username: "alice", progress: [[1, 5]] }]);
    expect(leftoversKept("alice")).toEqual({ effects: true, sick: true });
    expect(errors.some((e) => e.includes("queue gone"))).toBe(true);
  });

  test("with CLUSTER=false (no owner epoch) the leave flushes at PLAYER_DISCONNECT and keeps everything, as before", async () => {
    store.markChanged("alice", 1, 5);
    live = { p1: alice() };
    await onDisconnect("fenced")({ id: "p1", reason: "player_left" });
    expect(flushed).toEqual([{ username: "alice", progress: [[1, 5]] }]);
    expect(leftoversKept("alice")).toEqual({ effects: true, sick: true });
    expect(forgottenRows).toEqual([]);
  });
});

describe("the handoff save", () => {
  const make = withNames(
    ["worlds", "achievements", "log", "player", "fencedSaves", "takeAchievementProgress", "settleFencedLeave"],
    `${functionOf("async function saveHandedOff(")}\nreturn saveHandedOff;`,
  );
  // What the save tick's flush would find while the fenced save runs: nothing, the progress is taken first.
  let waitingAtSave = -1;
  const saveHandedOff = (answer: "saved" | "fenced" | Error) => make({
    worlds: { adjustPlayerCount: async () => 0 },
    achievements,
    log: quiet,
    player: {
      saveFenced: async () => {
        order.push("save");
        waitingAtSave = store.changedOf("alice").size;
        if (answer instanceof Error) throw answer;
        return answer;
      },
      setStats: async () => { order.push("setStats"); },
      setLocation: async () => { order.push("setLocation"); },
    },
    fencedSaves,
    takeAchievementProgress,
    settleFencedLeave,
  });
  const handed = (more: Record<string, any> = {}) => ({
    id: "p1", username: "alice", stats: { health: 7 }, location: { map: "main", position: { x: 1, y: 2 } }, ...more,
  });

  test("a handoff refused by the fence flushes no progress", async () => {
    store.markChanged("alice", 1, 5);
    await saveHandedOff("fenced")(handed({ ownerEpoch: 4 }));
    expect(order).toEqual(["save"]);
    expect(waitingAtSave).toBe(0);
    expect(flushed).toEqual([]);
    expect(store.changedOf("alice").size).toBe(0);
    expect(forgottenRows).toEqual(["alice"]);
  });

  test("an owned handoff flushes its progress after the save", async () => {
    store.markChanged("alice", 1, 5);
    await saveHandedOff("saved")(handed({ ownerEpoch: 4 }));
    expect(order).toEqual(["save", "flush"]);
    expect(flushed).toEqual([{ username: "alice", progress: [[1, 5]] }]);
  });

  test("a handoff whose save threw gives the progress back, flushes it, and throws on", async () => {
    store.markChanged("alice", 1, 5);
    await expect(saveHandedOff(new Error("database gone"))(handed({ ownerEpoch: 4 }))).rejects.toThrow("database gone");
    expect(order).toEqual(["save", "flush"]);
    expect(flushed).toEqual([{ username: "alice", progress: [[1, 5]] }]);
  });

  test("a fenced handoff with no location saves nothing and flushes its progress, owner unknown (review m4)", async () => {
    store.markChanged("alice", 1, 5);
    await saveHandedOff("fenced")(handed({ ownerEpoch: 4, location: null }));
    expect(order).toEqual(["flush"]);
    expect(flushed).toEqual([{ username: "alice", progress: [[1, 5]] }]);
    expect(forgottenRows).toEqual([]);
  });

  test("with CLUSTER=false the handoff flushes first and writes unfenced, as before", async () => {
    store.markChanged("alice", 1, 5);
    await saveHandedOff("fenced")(handed());
    expect(order).toEqual(["flush", "setStats", "setLocation"]);
    expect(flushed).toEqual([{ username: "alice", progress: [[1, 5]] }]);
  });
});

describe("the kick save (a newer login of the account)", () => {
  const kickNames = [
    "effectManager", "dots", "getStunsForPlayer", "getSlowsForPlayer", "saveSicknessOnDisconnect", "loot", "fencedSaves",
    "takeAchievementProgress", "settleFencedLeave", "player", "log", "achievements", "saveLeavingEffects", "saveLeavingState",
  ];
  const makeKick = withNames(kickNames, `${functionOf("export async function saveKickedPlayer(").replace("export ", "")}\nreturn saveKickedPlayer;`);
  const disconnectNames = [
    "playerCache", "packetManager", "effectManager", "dots", "getStunsForPlayer", "getSlowsForPlayer", "saveSicknessOnDisconnect",
    "loot", "cleanupPlayerState", "releaseDraggedBy", "listener", "Events", "removeFromAuthenticationQueues", "worlds", "log", "player",
    "console", "forgetPlayer", "fencedSaves", "clusterEnabled", "isOnline", "tellContactsOffline", "takeAchievementProgress", "settleFencedLeave",
    "saveLeavingEffects", "saveLeavingState",
  ];
  const makeDisconnect = withNames(
    disconnectNames,
    `return ${cut(serverSource, 'listener.on("onDisconnect", ', /\r?\n}\);\r?\n/).replace('listener.on("onDisconnect", ', "")}\n};`,
  );

  // What each leave wrote, in order: the effects, the loot cleanup, the flush, and the player's rows.
  let wrote: string[] = [];
  const recordingDeps = (answer: "saved" | "fenced") => ({
    effectManager: {
      saveDots: (u: string) => { wrote.push(`dots ${u}`); },
      saveBarriers: (u: string) => { wrote.push(`barriers ${u}`); },
      saveStuns: (u: string) => { wrote.push(`stuns ${u}`); },
      saveSlows: (u: string) => { wrote.push(`slows ${u}`); },
    },
    dots: { getPlayerDots: () => [] },
    getStunsForPlayer: () => [],
    getSlowsForPlayer: () => [],
    saveSicknessOnDisconnect: (p: any) => { wrote.push(`sickness ${p.username}`); },
    loot: { scheduleCleanup: (u: string) => { wrote.push(`loot cleanup ${u}`); } },
    fencedSaves,
    takeAchievementProgress,
    settleFencedLeave,
    log: quiet,
    achievements: { onLeave: async (payload: any) => { wrote.push("flush"); await achievements.onLeave(payload); } },
    player: {
      saveFenced: async (who: any) => { wrote.push(`saveFenced ${who.username}`); return answer; },
      setStats: async (who: any) => { wrote.push(`stats ${who.username}`); },
      setLocation: async () => { wrote.push("location by session"); },
      setLocationByUsername: async (u: string) => { wrote.push(`location of ${u}`); },
      clearSessionId: async () => {},
    },
  });
  const kick = (answer: "saved" | "fenced" = "saved") => makeKick(withLeaveSaves(recordingDeps(answer)));
  const disconnect = (answer: "saved" | "fenced" = "saved", emit?: (event: string, payload: any) => void) => {
    const deps = recordingDeps(answer);
    return makeDisconnect(withLeaveSaves({
      ...deps,
      playerCache: { ...playerCache },
      packetManager: { notify: () => [{}], updateOnlineStatus: () => [{}] },
      cleanupPlayerState: (p: any) => { delete live[p.id]; },
      releaseDraggedBy: () => {},
      // PLAYER_DISCONNECT: the achievement module's flush, as the module registers it.
      listener: { emit: emit ?? ((_event: string, payload: any) => void deps.achievements.onLeave(payload)) },
      Events: { PLAYER_DISCONNECT: "onPlayerDisconnect" },
      removeFromAuthenticationQueues: () => {},
      worlds: { adjustPlayerCount: async () => 0 },
      console: { error: () => {} },
      forgetPlayer: async () => {},
      clusterEnabled: () => false,
      isOnline: async () => false,
      tellContactsOffline: async () => {},
    }));
  };
  const bob = (more: Record<string, any> = {}) => ({
    id: "k1", username: "bob", stats: { health: 3 }, location: { map: "main", position: { x: 4, y: 5 } }, ...more,
  });

  beforeEach(() => { wrote = []; });
  afterEach(() => { clearLeftovers("bob"); });

  test("writes what a disconnect writes, the location by the character instead of the old session", async () => {
    store.markChanged("bob", 1, 5);
    await kick()(bob());
    const kicked = wrote;
    const kickFlushed = flushed;
    wrote = [];
    flushed = [];
    store.markChanged("bob", 1, 5);
    live = { k1: bob() };
    await disconnect()({ id: "k1", reason: "player_left" });
    expect(kicked).toEqual(wrote.map((w) => (w === "location by session" ? "location of bob" : w)));
    expect(kicked).toEqual([
      "dots bob", "barriers bob", "stuns bob", "slows bob", "sickness bob", "loot cleanup bob", "flush", "stats bob", "location of bob",
    ]);
    expect(kickFlushed).toEqual([{ username: "bob", progress: [[1, 5]] }]);
    expect(flushed).toEqual([{ username: "bob", progress: [[1, 5]] }]);
  });

  // The flush after a fenced save is settleFencedLeave's (its own achievements stand-in): seen in what was flushed.
  test("fenced and owned: the fenced save, then the progress flushed, as a fenced disconnect", async () => {
    store.markChanged("bob", 1, 5);
    await kick("saved")(bob({ ownerEpoch: 4 }));
    expect(wrote).toEqual(["dots bob", "barriers bob", "stuns bob", "slows bob", "sickness bob", "loot cleanup bob", "saveFenced bob"]);
    expect(flushed).toEqual([{ username: "bob", progress: [[1, 5]] }]);
  });

  test("fenced and refused: no progress flushed, the leftovers kept here dropped", async () => {
    store.markChanged("bob", 1, 5);
    await kick("fenced")(bob({ ownerEpoch: 4 }));
    expect(flushed).toEqual([]);
    expect(store.changedOf("bob").size).toBe(0);
    expect(forgottenRows).toEqual(["bob"]);
  });

  test("a guest is not saved", async () => {
    await kick()(bob({ isGuest: true }));
    expect(wrote).toEqual([]);
  });

  test("the kicked session's own close, while the kick saves it, saves nothing again (no second loot cleanup either)", async () => {
    const kicked = bob();
    live = { k1: kicked };
    const saving = kick()(kicked);
    await disconnect()({ id: "k1", reason: "player_left" });
    await saving;
    expect(wrote.filter((w) => w === "loot cleanup bob")).toHaveLength(1);
    expect(wrote.filter((w) => w === "stats bob")).toHaveLength(1);
    expect(wrote).not.toContain("location by session");
  });

  // The PLAYER_DISCONNECT listeners as the systems register them: some look up by the player's id (creatures, fishing,
  // gathering, the cutscene's "inside"), some by its name (vendor buyback and trade end, the cutscene's seen views, the
  // achievement flush). Each records the player it ran for and clears what it holds for it.
  const makeLeave = withNames(["listener", "Events"], `${functionOf("export function leaveKickedPlayer(").replace("export ", "")}
return leaveKickedPlayer;`);
  const PLAYER_DISCONNECT = "onPlayerDisconnect";
  const systems = () => {
    const ran: string[] = [];
    const byId = new Map<string, Set<string>>();
    const byName = new Map<string, Set<string>>();
    const hold = (map: Map<string, Set<string>>, key: string, what: string) => (map.get(key) ?? map.set(key, new Set()).get(key)!).add(what);
    const idListeners = ["creatures", "fishing", "gathering", "cutscene inside"];
    const nameListeners = ["vendor buyback", "trade", "cutscene views", "achievements"];
    const emit = (event: string, payload: any) => {
      if (event !== PLAYER_DISCONNECT) return;
      const p = payload?.player;
      for (const what of idListeners) { ran.push(`${what} ${p.id}`); byId.get(String(p.id))?.delete(what); }
      for (const what of nameListeners) { ran.push(`${what} ${p.username}`); byName.get(String(p.username))?.delete(what); }
    };
    const enter = (p: any) => {
      for (const what of idListeners) hold(byId, String(p.id), what);
      for (const what of nameListeners) hold(byName, String(p.username), what);
    };
    return { ran, byId, byName, emit, enter, idListeners, nameListeners };
  };

  test("a kick runs each PLAYER_DISCONNECT listener once for the old session; its close runs none; the new session keeps its state", async () => {
    const world = systems();
    const leave = makeLeave({ listener: { emit: world.emit }, Events: { PLAYER_DISCONNECT } });
    const old = bob({ id: "k1" });
    live = { k1: old };
    world.enter(old);

    // kickDuplicateSessions: saved, left, told, dropped.
    await kick()(old);
    leave(old);
    leave(old);
    delete live.k1;
    expect(world.ran).toEqual([...world.idListeners.map((w) => `${w} k1`), ...world.nameListeners.map((w) => `${w} bob`)]);
    expect([...(world.byId.get("k1") ?? [])]).toEqual([]);
    expect([...(world.byName.get("bob") ?? [])]).toEqual([]);

    // The new login of the same character is added, and plays.
    const newer = bob({ id: "k2" });
    live = { k2: newer };
    world.enter(newer);
    world.ran.length = 0;

    // The old socket's close, then: nothing runs, and the new session keeps all it holds.
    await disconnect("saved", world.emit)({ id: "k1", reason: "player_left" });
    expect(world.ran).toEqual([]);
    expect([...(world.byId.get("k2") ?? [])].sort()).toEqual([...world.idListeners].sort());
    expect([...(world.byName.get("bob") ?? [])].sort()).toEqual([...world.nameListeners].sort());
  });

  test("a kicked session still in the cache (a drop that threw before taking it out) runs no listener at its close", async () => {
    const world = systems();
    const leave = makeLeave({ listener: { emit: world.emit }, Events: { PLAYER_DISCONNECT } });
    const old = bob({ id: "k1" });
    live = { k1: old };
    await kick()(old);
    leave(old);
    world.ran.length = 0;
    wrote = [];
    await disconnect("saved", world.emit)({ id: "k1", reason: "player_left" });
    expect(world.ran).toEqual([]);
    expect(wrote).toEqual([]);
  });

  test("a kicked guest is left too (its listeners run once), though nothing is saved for it", async () => {
    const world = systems();
    const leave = makeLeave({ listener: { emit: world.emit }, Events: { PLAYER_DISCONNECT } });
    const guest = bob({ id: "g1", isGuest: true });
    await kick()(guest);
    leave(guest);
    leave(guest);
    expect(world.ran).toHaveLength(world.idListeners.length + world.nameListeners.length);
    expect(wrote).toEqual([]);
  });
});
