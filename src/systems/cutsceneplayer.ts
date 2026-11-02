/**
 * Cutscene sessions: playing a saved scene (systems/cutscenes.ts) to a player, holding them still and out of harm's
 * way while it runs, running the end of it, and the triggers that start scenes by themselves. The scene store, the
 * document and the editor's packets are cutscenes.ts; whether a player is held, and which of their packets a held
 * player is refused, is the leaf cutsceneheld.ts, so the receiver and the damage paths need not load this.
 *
 * A session lives on the player object as `player.cutscene`: the scene's name, a random token the client must give back,
 * whether it holds the player, its phase and the clock that ends it. The client is trusted with nothing: a scene ends
 * when the client says so, but also when its clock runs out, so a client that disappears or never answers cannot
 * leave a player held. Timers are only the means; a hold is judged by comparing times (cutsceneheld.ts isHeld), so it
 * ends by itself even if every timer failed.
 */
import { randomBytes } from "node:crypto";
import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import assetCache from "../services/assetCache";
import mapIndex from "../services/mapindex";
import playerCache from "../services/playermanager";
import { packetManager } from "../socket/packet_manager";
import { bareMap, canUseEditor, findScene, allScenes, resolveForPlay, type CameraKey, type CutsceneDoc, type Trigger, type TriggerKind } from "./cutscenes";
import { isHeld } from "./cutsceneheld";
import { Events, listener, type CutsceneEndedEvent, type CutsceneMarkEvent, type CutsceneStartedEvent } from "./events";

export { isHeld };

/** Where a player stood: the place a chain of scenes takes them home to. */
export interface Place { map: string; x: number; y: number; direction: string }

export type Phase = "pending" | "running" | "done";

/** What `player.cutscene` holds while a scene runs for the player. */
export interface CutsceneState {
  name: string;
  /** Random, per showing: the client must give it back, so an answer about an earlier scene is ignored. */
  token: string;
  /** The scene holds the player still and out of harm's way. */
  lock: boolean;
  /** `pending` until the client says it has begun, `running` after, `done` once it is over. */
  phase: Phase;
  /** When the scene is over whatever the client says (epoch ms). */
  clockEndsAt: number;
  /** When the client said it began (epoch ms); 0 until then. */
  startedAt: number;
  /** The scene's length, in seconds. */
  duration: number;
  skippable: boolean;
  end: CutsceneDoc["end"];
  /** Where a chain of scenes started, once it has moved the player to another map; null while it has not. */
  origin: Place | null;
  /** How many scenes of the chain came before this one. */
  depth: number;
  // Not listed when the state is logged or copied: timers are handles, not data.
  marks: Array<ReturnType<typeof setTimeout>>;
  clock: ReturnType<typeof setTimeout> | null;
  plan: { marks: Array<{ name: string; t: number }> };
}

type SessionFields = Pick<CutsceneState, "name" | "token" | "lock" | "phase" | "clockEndsAt" | "startedAt" | "duration" | "skippable" | "end" | "origin" | "depth">;

/** A session as it crosses to another node (cluster mode), in the handoff's state record: plain data, its times as Date.now() values. */
export interface CarriedScene extends SessionFields {
  /** The marks on the scene's timeline. */
  marks: Array<{ name: string; t: number }>;
  /** When the old node let it go (Date.now()): it fired the marks up to here. */
  at: number;
}

/** A chain whose next scene is on another node's ground, in the handoff's state record: that node begins the scene. */
export interface CarriedChain {
  name: string;
  /** Where the chain began: the player is taken home to it at the end. */
  origin: Place | null;
  depth: number;
}

/** What the socket layer does for the sessions, so this module need not import receiver.ts (which starts the server). */
export interface CutsceneBridge {
  /** Sends packets to the player's connection. */
  send(player: any, packets: any[]): void;
  /** Stops the player's walk and interrupts a cast: what a scene that holds them begins with. */
  hold(player: any): Promise<void>;
  /** Moves the player to a place, loading the map when it is another one. */
  teleport(player: any, map: string, x: number, y: number): Promise<void>;
}

const direct: CutsceneBridge = {
  send: (player, packets) => {
    const wt = player?.wt;
    if (!wt || wt.readyState !== 1) return;
    try {
      for (const packet of packets) wt.send(packet);
    } catch {
      // Connection closing.
    }
  },
  hold: async () => {},
  teleport: async (player) => {
    log.warn(`[Cutscenes] ${player?.username} could not be moved: the socket layer has not said how`);
  },
};

let bridge: CutsceneBridge = direct;

/** Set once by socket/receiver.ts, which has the helpers that stop a walk, interrupt a cast and move a player. Null puts the default back. */
export function setCutsceneBridge(next: CutsceneBridge | null): void {
  bridge = next ?? direct;
}

/** How long things last. Mutable only so a test need not wait them out. */
export const timing = {
  /** A scene the client has not begun: it is dropped after this. */
  pendingMs: 30_000,
  /** The clock of a scene that has begun is its length and this. */
  graceMs: 5_000,
  /** A scene may be skipped, whether or not it is skippable, this close to its end. */
  endSlackMs: 2_000,
  /** A login scene is started this long after the player is in the world, behind the packets the login sends. */
  loginDelayMs: 500,
  /** The most scenes a chain plays: a chain that loops cannot go on for ever. */
  maxChain: 16,
  /** A scene's clock that runs out as its player changes node is given this long: the end runs once they have landed. */
  landingMs: 1_000,
};

const lower = (value: unknown) => String(value ?? "").trim().toLowerCase();
const sqlite = () => (process.env.DATABASE_ENGINE || "mysql") === "sqlite";
const keyOf = (player: any) => String(player?.id ?? player?.username ?? "");

/** A player being handed to another node (cluster mode), as receiver.ts counts it: nothing is done to them. */
const inHandoff = (player: any): boolean => !!(player?.handoff || player?.wt?.data?.handedOff);

/** The listener of an event may throw: a scene must not end up half-ended for it. */
function emit(event: string, payload: object): void {
  try {
    listener.emit(event, payload);
  } catch (error) {
    log.error(`[Cutscenes] A listener of ${event} threw: ${error}`);
  }
}

// ----------------------------------------------------------------- sessions

/** The running session of a player, or null. */
function live(player: any): CutsceneState | null {
  const state = player?.cutscene as CutsceneState | undefined;
  return state && state.phase !== "done" ? state : null;
}

/** Whether the player is in a scene now. */
export function inScene(player: any): boolean {
  return live(player) !== null;
}

/** Players a scene is being started for: a second start meanwhile is refused, since the first has not set the session yet. */
const starting = new Set<string>();
/** Players a chain is moving between scenes: a trigger fired by the move must not start another scene in its place. */
const chaining = new Set<string>();

function sessionOf(fields: SessionFields, marks: CutsceneState["plan"]["marks"]): CutsceneState {
  const state = { ...fields } as CutsceneState;
  Object.defineProperties(state, {
    marks: { value: [], enumerable: false, writable: true },
    clock: { value: null, enumerable: false, writable: true },
    plan: { value: { marks }, enumerable: false },
  });
  return state;
}

function newState(scene: CutsceneDoc, token: string, origin: Place | null, depth: number): CutsceneState {
  const marks: CutsceneState["plan"]["marks"] = [];
  for (const track of scene.tracks) if (track.kind === "mark") for (const item of track.items) marks.push({ name: item.name, t: item.t });
  return sessionOf({
    name: scene.name, token, lock: scene.settings.lock, phase: "pending", clockEndsAt: 0, startedAt: 0,
    duration: scene.duration, skippable: scene.settings.skippable, end: scene.end, origin, depth,
  }, marks);
}

/** Ends the clock and the marks' timers, and takes the session off the player. Nothing is sent, nothing emitted. */
function retire(player: any, state: CutsceneState): void {
  state.phase = "done";
  // Whoever still holds this object (a copy of the player made before) sees a session that holds no one.
  state.lock = false;
  state.clockEndsAt = 0;
  if (state.clock) clearTimeout(state.clock);
  state.clock = null;
  for (const timer of state.marks) clearTimeout(timer);
  state.marks.length = 0;
  if (player.cutscene === state) delete player.cutscene;
  const cached = playerCache.get(player.id);
  if (cached && cached.cutscene === state) delete cached.cutscene;
}

function startClock(player: any, state: CutsceneState, ms: number): void {
  state.clockEndsAt = Date.now() + ms;
  if (state.clock) clearTimeout(state.clock);
  state.clock = setTimeout(() => expire(player, state), ms);
  (state.clock as any)?.unref?.();
}

/**
 * The clock ran out. A scene the client never began is dropped as a stop would drop it, with no end to run: the player
 * never saw it. One that began is over: its end runs, as if the client had said so. The client is told either way, in
 * case it is still showing it.
 */
function expire(player: any, state: CutsceneState): void {
  if (state.phase === "done") return;
  // Nothing of an end runs for a player changing node: the clock waits to see where they land.
  if (inHandoff(player)) {
    startClock(player, state, timing.landingMs);
    return;
  }
  const began = state.phase === "running";
  bridge.send(player, packetManager.cutsceneStop({ token: state.token }));
  void finish(player, state, { skipped: !began, runEnd: began, home: true })
    .catch((error) => log.error(`[Cutscenes] The end of ${state.name} for ${player?.username} failed: ${error}`));
}

export type PlayResult = { ok: true } | { ok: false; reason: string };
const no = (reason: string): PlayResult => ({ ok: false, reason });

export interface PlayOptions {
  /** A scene the player is in is ended (with no end to run) and this one begins in its place. */
  force?: boolean;
  /** Set by a chain moving on to its next scene: the player was moved to its map, and where the chain began. */
  chain?: { origin: Place | null; depth: number };
}

/**
 * Plays the saved scene `name` to the player. Refused when there is no such scene, the player is dead or a ghost, in a
 * scene already, changing server node, or a mirror of a player of another node, or is not on the scene's map (unless a
 * chain just moved them there). Otherwise a token is made, the player is held when the scene locks, and CUTSCENE_PLAY is
 * sent with the scene resolved and without its triggers; the session's clock is 30 s until the client says it has begun.
 */
export async function begin(player: any, name: string, options: PlayOptions = {}): Promise<PlayResult> {
  if (!player || player.remote) return no("on another server node");
  if (player.isDead || player.isGhost) return no("dead or a ghost");
  if (inHandoff(player)) return no("changing server node");
  if (player.wt && player.wt.readyState !== 1) return no("not connected");
  const key = keyOf(player);
  if (starting.has(key)) return no("another scene is starting");

  let carried: Place | null = options.chain?.origin ?? null;
  const running = live(player);
  if (running) {
    if (!options.force) return no(`already watching ${running.name}`);
    // Ended where they stand, with no end to run; a chain they were in goes on being theirs to be taken home from.
    carried = carried ?? running.origin;
    bridge.send(player, packetManager.cutsceneStop({ token: running.token }));
    await finish(player, running, { skipped: true, runEnd: false, home: false });
  }

  starting.add(key);
  try {
    const stored = await findScene(name);
    if (!stored) return no(`there is no cutscene called ${name}`);
    if (!options.chain && lower(bareMap(player.location?.map)) !== lower(bareMap(stored.map))) {
      return no(`${stored.name} plays on ${stored.map}, not here`);
    }
    const doc = await resolveForPlay(stored);
    // The player may have died, been taken to another node or been given a scene while the scene was read.
    if (live(player) || player.isDead || player.isGhost || inHandoff(player)) return no("their state changed as it began");

    const state = newState(stored, randomBytes(16).toString("hex"), carried, options.chain?.depth ?? 0);
    player.cutscene = state;
    const cached = playerCache.get(player.id);
    if (cached && cached !== player) cached.cutscene = state;
    startClock(player, state, timing.pendingMs);

    if (state.lock) {
      try {
        await bridge.hold(player);
      } catch (error) {
        log.warn(`[Cutscenes] ${player.username} could not be stopped for ${stored.name}: ${error}`);
      }
    }
    // Ended while they were being stopped (they left, or the scene was stopped).
    if (player.cutscene !== state) return no("it ended as it began");

    bridge.send(player, packetManager.cutscenePlay({ token: state.token, doc }));
    emit(Events.CUTSCENE_STARTED, { player, cutscene: stored.name } satisfies CutsceneStartedEvent);
    if (stored.triggers.some((t) => t.once)) markSeen(player.username, stored.name);
    return { ok: true };
  } finally {
    starting.delete(key);
  }
}

/** Plays a saved scene to a player: true when it began. */
export async function play(player: any, name: string, options: PlayOptions = {}): Promise<boolean> {
  return (await begin(player, name, options)).ok;
}

/** Sets the marks from `fromMs` into the scene on to fire at their time. One whose time has passed fires at once. */
function setMarks(player: any, state: CutsceneState, fromMs: number): void {
  const elapsed = Date.now() - state.startedAt;
  for (const mark of state.plan.marks) {
    const at = mark.t * 1000;
    if (at < fromMs) continue;
    const timer = setTimeout(() => {
      if (state.phase !== "running") return;
      emit(Events.CUTSCENE_MARK, { player, cutscene: state.name, name: mark.name, t: mark.t } satisfies CutsceneMarkEvent);
    }, Math.max(0, at - elapsed));
    (timer as any)?.unref?.();
    state.marks.push(timer);
  }
}

/**
 * CUTSCENE_STARTED: the client has begun the scene. The clock becomes the scene's length and 5 s, and the marks on its
 * timeline are set to fire. A token that is not the session's, or a session that has begun, is ignored.
 */
export function onStarted(player: any, token: unknown): boolean {
  const state = live(player);
  if (!state || state.token !== token || state.phase !== "pending") return false;
  state.phase = "running";
  state.startedAt = Date.now();
  startClock(player, state, state.duration * 1000 + timing.graceMs);
  setMarks(player, state, 0);
  return true;
}

/** The player's scene as the handoff's state record carries it, or null when they are in none. */
export function carriedScene(player: any): CarriedScene | null {
  const state = live(player);
  return state ? { ...state, marks: state.plan.marks, at: Date.now() } : null;
}

/**
 * A scene the player brought from the node they left goes on here: the same showing under the same token, which their
 * client is still playing, so nothing is sent and they are not stopped again. The clock runs to the time it had, and
 * the marks the old node did not fire are set; a clock that ran out on the way runs the end once the player has landed.
 */
export function adopt(player: any, carried: CarriedScene): void {
  const { marks, at, ...fields } = carried;
  const state = sessionOf(fields, marks);
  player.cutscene = state;
  const cached = playerCache.get(player.id);
  if (cached && cached !== player) cached.cutscene = state;
  startClock(player, state, Math.max(timing.landingMs, state.clockEndsAt - Date.now()));
  if (state.phase === "running") setMarks(player, state, at - state.startedAt);
}

/**
 * CUTSCENE_END: the scene is over or was skipped. A skip of a scene that is not skippable is ignored, unless it comes
 * within 2 s of the scene's end: the client's clock and the server's are not the same. Otherwise the scene finishes and
 * its end runs. A token that is not the session's is ignored.
 */
export async function onEnd(player: any, token: unknown, skipped: boolean): Promise<boolean> {
  const state = live(player);
  if (!state || state.token !== token) return false;
  if (skipped && !state.skippable) {
    const endsAt = state.startedAt + state.duration * 1000;
    if (state.phase !== "running" || Date.now() < endsAt - timing.endSlackMs) return false;
  }
  await finish(player, state, { skipped, runEnd: true, home: true });
  return true;
}

/**
 * Ends the player's scene from the server: the client is told to drop it, and nothing of its end runs (no next scene, no
 * teleport). A chain that had moved the player is still taken home. True when there was a scene.
 */
export async function stop(player: any): Promise<boolean> {
  const state = live(player);
  if (!state) return false;
  bridge.send(player, packetManager.cutsceneStop({ token: state.token }));
  await finish(player, state, { skipped: true, runEnd: false, home: true });
  return true;
}

/**
 * A player left (a disconnect or a logout): the clock, the marks and the session go, and nothing else. A player who
 * is in the middle of a chain stays wherever the chain had taken them: the place a login puts them is the saved one.
 */
export function clear(player: any): void {
  const state = player?.cutscene as CutsceneState | undefined;
  if (state && state.phase !== "done") retire(player, state);
  forgetUser(player?.username);
  inside.delete(String(player?.id));
}

interface Ending { skipped: boolean; runEnd: boolean; home: boolean }

async function finish(player: any, state: CutsceneState, how: Ending): Promise<void> {
  if (state.phase === "done") return;
  retire(player, state);
  emit(Events.CUTSCENE_ENDED, { player, cutscene: state.name, skipped: how.skipped } satisfies CutsceneEndedEvent);
  await runEnd(player, state, how);
}

/** Moves a player; a move that fails is said, and the scene's end goes no further. */
async function go(player: any, map: string, x: number, y: number): Promise<boolean> {
  try {
    await bridge.teleport(player, map, x, y);
    return true;
  } catch (error) {
    log.warn(`[Cutscenes] ${player?.username} could not be moved to ${map} (${x}, ${y}): ${error}`);
    return false;
  }
}

/**
 * What follows a scene: the scene `end.next`, moving the player to its map first when that is another one (the chain
 * remembers where it began); else `end.teleport`; else, when a chain moved the player, home to where it began. A dead
 * player, a ghost or one changing node is left where they are.
 */
async function runEnd(player: any, state: CutsceneState, how: Ending): Promise<void> {
  if (player.isDead || player.isGhost || player.remote || inHandoff(player)) return;
  let origin = state.origin;
  if (how.runEnd) {
    if (state.end.next) {
      const chained = await chain(player, state, state.end.next);
      if (chained.started) return;
      origin = chained.origin;
    }
    const to = state.end.teleport;
    if (to) {
      await go(player, to.map, to.x, to.y);
      return;
    }
  }
  if (origin && how.home) await go(player, origin.map, origin.x, origin.y);
}

/** Where the player is, as a chain remembers it. */
function placeOf(player: any): Place {
  const at = player.location?.position ?? {};
  return { map: bareMap(player.location?.map), x: Math.round(Number(at.x) || 0), y: Math.round(Number(at.y) || 0), direction: String(at.direction || "down") };
}

/** Where a map starts its players: the spawn it names, else its middle. */
async function mapSpawn(map: string): Promise<{ x: number; y: number }> {
  try {
    const list = (await assetCache.get("mapProperties")) as any[] | null;
    const props = (list || []).find((m) => lower(bareMap(m?.name)) === lower(bareMap(map)));
    if (props?.spawn) return { x: Number(props.spawn.x) || 0, y: Number(props.spawn.y) || 0 };
    if (props) return { x: (Number(props.width) * Number(props.tileWidth)) / 2 || 0, y: (Number(props.height) * Number(props.tileHeight)) / 2 || 0 };
  } catch {
    // no map list: the corner
  }
  return { x: 0, y: 0 };
}

/**
 * Where a scene begins, for the player a chain moves to its map: its first camera key (an offset from the actor it
 * follows when it follows one), else the map's spawn.
 */
function startOf(scene: CutsceneDoc, spawn: { x: number; y: number }): { x: number; y: number } {
  let first: CameraKey | undefined;
  for (const track of scene.tracks) {
    if (track.kind !== "camera") continue;
    for (const key of track.items) if (!first || key.t < first.t) first = key;
  }
  if (first) {
    if (first.follow === null) return { x: first.x, y: first.y };
    const actor = scene.actors.find((a) => a.id === first!.follow);
    if (actor) return { x: actor.x + first.x, y: actor.y + first.y };
  }
  return spawn;
}

/** The scene after `state`'s: whether it began, and where the chain began (the player is taken home from there). */
async function chain(player: any, state: CutsceneState, nextName: string): Promise<{ started: boolean; origin: Place | null }> {
  let origin = state.origin;
  if (state.depth + 1 >= timing.maxChain) {
    log.warn(`[Cutscenes] The chain that ${state.name} belongs to has played ${timing.maxChain} scenes, so it stops there`);
    return { started: false, origin };
  }
  const next = await findScene(nextName);
  if (!next) {
    log.warn(`[Cutscenes] ${state.name} continues into ${nextName}, which is gone`);
    return { started: false, origin };
  }
  const key = keyOf(player);
  chaining.add(key);
  try {
    if (lower(bareMap(next.map)) !== lower(bareMap(player.location?.map))) {
      origin = origin ?? placeOf(player);
      const at = startOf(next, await mapSpawn(next.map));
      // The move hands them over when another node owns that ground, and the chain goes in what it carries.
      movingTo.set(key, { name: next.name, origin, depth: state.depth + 1 });
      if (!(await go(player, next.map, at.x, at.y))) return { started: false, origin };
      if (inHandoff(player)) return { started: true, origin };
    }
    const result = await begin(player, next.name, { chain: { origin, depth: state.depth + 1 } });
    if (!result.ok) log.warn(`[Cutscenes] ${state.name} could not go on to ${next.name} for ${player.username}: ${result.reason}`);
    return { started: result.ok, origin };
  } finally {
    chaining.delete(key);
    movingTo.delete(key);
  }
}

/** What a chain is taking the player to, by the player's key: what it hands to the next node when the move crosses to one. */
const movingTo = new Map<string, CarriedChain>();

/** The chain moving the player, as the handoff's state record carries it, or null when none is. */
export function carriedChain(player: any): CarriedChain | null {
  return movingTo.get(keyOf(player)) ?? null;
}

/**
 * A chain that brought the player here goes on: its scene begins as a login's does, once the client has had time to
 * load the map. A scene that cannot begin takes them home to where the chain began, as the end of a chain does.
 */
export function adoptChain(player: any, carried: CarriedChain): void {
  const user = lower(player?.username);
  const timer = setTimeout(() => {
    const now = playerCache.getByUsername(user);
    if (!now) return;
    void (async () => {
      const result = await begin(now, carried.name, { chain: { origin: carried.origin, depth: carried.depth } });
      if (result.ok) return;
      log.warn(`[Cutscenes] A chain could not go on to ${carried.name} for ${user}: ${result.reason}`);
      if (carried.origin) await go(now, carried.origin.map, carried.origin.x, carried.origin.y);
    })().catch((error) => log.warn(`[Cutscenes] A chain to ${carried.name} for ${user} failed: ${error}`));
  }, timing.loginDelayMs);
  (timer as any)?.unref?.();
}

// -------------------------------------------------------------------- views

/** The scenes each character has seen, by lower case username (lower case scene names), loaded when first needed. */
const seen = new Map<string, Set<string>>();
const loadingSeen = new Map<string, Promise<Set<string> | null>>();

/** The scenes a character has seen, or null when the table could not be read (a scene that plays once is then not played). */
async function seenBy(username: string): Promise<Set<string> | null> {
  const user = lower(username);
  if (!user) return null;
  const held = seen.get(user);
  if (held) return held;
  let pending = loadingSeen.get(user);
  if (!pending) {
    pending = (async () => {
      try {
        const rows = ((await query("SELECT cutscene FROM cutscene_views WHERE username = ?", [user])) || []) as any[];
        const set = new Set<string>(Array.from(rows, (row) => lower(row?.cutscene)));
        // A disconnect while the rows were read leaves nothing behind.
        if (loadingSeen.get(user) === pending) seen.set(user, set);
        return set;
      } catch (error) {
        log.warn(`[Cutscenes] What ${user} has seen could not be read, so the scenes that play once are not played: ${error}`);
        return null;
      } finally {
        loadingSeen.delete(user);
      }
    })();
    loadingSeen.set(user, pending);
  }
  return pending;
}

/** A scene with a once trigger began: the character has seen it. */
function markSeen(username: string, scene: string): void {
  const user = lower(username);
  if (!user) return;
  seen.get(user)?.add(lower(scene));
  void Promise.resolve(query(
    `INSERT ${sqlite() ? "OR IGNORE" : "IGNORE"} INTO cutscene_views (username, cutscene, seen_at) VALUES (?, ?, ?)`,
    [user, scene, Date.now()],
  )).catch((error: unknown) => log.warn(`[Cutscenes] ${user} having seen ${scene} could not be written: ${error}`));
}

function forgetUser(username: unknown): void {
  const user = lower(username);
  if (!user) return;
  seen.delete(user);
  loadingSeen.delete(user);
  pendingLogins.delete(user);
}

/** Clears a character's view of a scene, so its once triggers play for them again. False when there is no such scene. */
export async function resetViews(sceneName: string, username: string): Promise<boolean> {
  const scene = await findScene(sceneName);
  const user = lower(username);
  if (!scene || !user) return false;
  await query("DELETE FROM cutscene_views WHERE username = ? AND cutscene = ?", [user, scene.name]);
  seen.get(user)?.delete(lower(scene.name));
  return true;
}

// ----------------------------------------------------------------- triggers

interface IndexEntry { scene: string; map: string; trigger: Trigger }

/** The triggers of the saved scenes by kind (an area's by map, in `areas`). Nothing is searched on a path that has none. */
let byKind = new Map<TriggerKind, IndexEntry[]>();
let areas = new Map<string, IndexEntry[]>();

/** Indexes the triggers of these scenes. Called whenever the cached list changes. */
export function indexTriggers(list: ReadonlyArray<Pick<CutsceneDoc, "name" | "map" | "triggers">>): void {
  const kinds = new Map<TriggerKind, IndexEntry[]>();
  const rects = new Map<string, IndexEntry[]>();
  const add = <K>(into: Map<K, IndexEntry[]>, key: K, entry: IndexEntry) => {
    const bucket = into.get(key);
    if (bucket) bucket.push(entry);
    else into.set(key, [entry]);
  };
  // In the order of the scenes' names, so which of two scenes on one trigger plays does not depend on the order they were saved in.
  for (const scene of [...list].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const trigger of scene.triggers ?? []) {
      const entry: IndexEntry = { scene: scene.name, map: lower(bareMap(scene.map)), trigger };
      if (trigger.on === "area") add(rects, entry.map, entry);
      else add(kinds, trigger.on, entry);
    }
  }
  byKind = kinds;
  areas = rects;
}

/** Reads the cached scenes and indexes their triggers. */
export async function reindex(): Promise<void> {
  indexTriggers(await allScenes());
}

/**
 * Starts the scene of one trigger for a player if they qualify: their level, and a scene that plays once not having
 * been seen. A scene cannot begin while one runs (or while a chain is moving the player). True when it began.
 */
async function tryEntry(player: any, entry: IndexEntry): Promise<boolean> {
  if (!player || player.remote || live(player) || chaining.has(keyOf(player))) return false;
  if (entry.trigger.minLevel > (Number(player.stats?.level) || 0)) return false;
  if (entry.trigger.once) {
    const views = await seenBy(player.username);
    if (!views || views.has(lower(entry.scene))) return false;
  }
  return (await begin(player, entry.scene)).ok;
}

/** Offers a player the scenes of the triggers of `on` that match and are on the map; the first that begins is played. */
async function fire(player: any, on: TriggerKind, matches: (trigger: Trigger) => boolean, mapName?: string): Promise<boolean> {
  const entries = byKind.get(on);
  if (!entries || entries.length === 0) return false;
  const here = lower(bareMap(mapName ?? player?.location?.map));
  for (const entry of entries) {
    if (entry.map !== here || !matches(entry.trigger)) continue;
    if (await tryEntry(player, entry)) return true;
  }
  return false;
}

/** The player talked to an NPC: a scene tied to it plays instead of the talk. True when one began. */
export function onNpcInteract(player: any, npcId: number): Promise<boolean> {
  return fire(player, "npc", (t) => t.npcId === npcId);
}

/** The player entered a map (a warp, a teleport, the editor's go-to). */
export function onMapEnter(player: any, mapName: string): Promise<boolean> {
  return fire(player, "map", () => true, mapName);
}

/** A quest was accepted or turned in by an online player. */
export function onQuest(username: string, on: "quest_accept" | "quest_complete", questId: number): Promise<boolean> {
  if (!byKind.get(on)?.length) return Promise.resolve(false);
  return fire(playerCache.getByUsername(username), on, (t) => t.questId === Number(questId));
}

/** Logins that have been authenticated and whose player is not in the cache yet: they get their login scene when it is. */
const pendingLogins = new Set<string>();

function whenInWorld(player: any): void {
  const user = lower(player?.username);
  if (!user) return;
  // A player handed over from another node is not logging in: they were already in the world, and they walked into
  // the areas they stand in there, so standing in one here is not walking into it.
  if (player.wt?.data?.handoffLanding) {
    pendingLogins.delete(user);
    enteredAlready(player);
    return;
  }
  if (!pendingLogins.delete(user)) return;
  const timer = setTimeout(() => {
    const now = playerCache.getByUsername(user);
    if (now) void fire(now, "login", () => true).catch((error) => log.warn(`[Cutscenes] A login scene for ${user} failed: ${error}`));
  }, timing.loginDelayMs);
  (timer as any)?.unref?.();
}

/** Player id to the area triggers (scene and trigger id) they stood in at the last look: a scene begins as they enter one. */
let inside = new Map<string, Set<string>>();
let looking = false;

const within = (t: Trigger, at: { x?: unknown; y?: unknown }) => {
  const x = Number(at.x);
  const y = Number(at.y);
  return x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h;
};

function enteredAlready(player: any): void {
  const at = player.location?.position;
  const standing = at ? (areas.get(lower(bareMap(player.location?.map))) ?? []).filter((e) => within(e.trigger, at)) : [];
  if (standing.length > 0) inside.set(String(player.id), new Set(standing.map((e) => `${e.scene}|${e.trigger.id}`)));
}

/**
 * Looks at the players on the maps that have area triggers and starts the scene of one a player has just walked into.
 * Maps without area triggers are not looked at, and nothing is done when there are none at all. Run once a second, as
 * the quests' explore areas are (systems/quests/objectives.ts).
 */
export async function tickAreas(): Promise<void> {
  if (areas.size === 0) {
    if (inside.size > 0) inside = new Map();
    return;
  }
  if (looking) return;
  looking = true;
  try {
    const next = new Map<string, Set<string>>();
    for (const [map, entries] of areas) {
      for (const id of mapIndex.getPlayersOnMap(map)) {
        const player = playerCache.get(id);
        const at = player?.location?.position;
        if (!player || player.remote || !at) continue;
        const now = entries.filter((e) => within(e.trigger, at));
        if (now.length === 0) continue;
        const before = inside.get(String(id));
        next.set(String(id), new Set(now.map((e) => `${e.scene}|${e.trigger.id}`)));
        for (const entry of now) {
          if (before?.has(`${entry.scene}|${entry.trigger.id}`)) continue;
          if (await tryEntry(player, entry)) break;
        }
      }
    }
    inside = next;
  } finally {
    looking = false;
  }
}

// ---------------------------------------------------------------- commands

/**
 * /cutscene: `play <name> [player|map]`, `stop [player]`, `list`, `reset <name> <player>`. Returns what to tell the admin.
 * The same permission as the editor.
 */
export async function runCommand(admin: any, args: string[]): Promise<string[]> {
  if (!canUseEditor(admin)) return ["You don't have permission to use this command"];
  const usage = ["Use /cutscene play <name> [player|map], /cutscene stop [player], /cutscene list or /cutscene reset <name> <player>"];
  const sub = lower(args[0]);

  if (sub === "list") {
    const names = (await allScenes()).map((s) => s.name).sort((a, b) => a.localeCompare(b));
    if (names.length === 0) return ["There are no cutscenes"];
    const shown = names.join(", ");
    return [`Cutscenes (${names.length}): ${shown.length > 900 ? `${shown.slice(0, 900)}...` : shown}`];
  }

  if (sub === "play") {
    if (!args[1]) return usage;
    const scene = await findScene(args[1]);
    if (!scene) return [`There is no cutscene called ${args[1]}`];
    const target = args[2];
    if (target !== undefined && lower(target) === "map") {
      const here = bareMap(admin.location?.map);
      let started = 0;
      let refused = 0;
      for (const id of [...mapIndex.getPlayersOnMap(here)]) {
        const result = await begin(playerCache.get(id), scene.name);
        if (result.ok) started++;
        else refused++;
      }
      return [`Playing ${scene.name} to ${started} player${started === 1 ? "" : "s"} on ${here}${refused ? ` (${refused} could not watch it)` : ""}`];
    }
    const who = target === undefined ? admin : playerCache.getByUsername(target);
    if (!who) return [`${target} is not online on this server`];
    const result = await begin(who, scene.name, { force: true });
    if (!result.ok) return [`${scene.name} could not be played to ${who === admin ? "you" : who.username}: ${result.reason}`];
    return [`Playing ${scene.name} to ${who === admin ? "you" : who.username}`];
  }

  if (sub === "stop") {
    const who = args[1] === undefined ? admin : playerCache.getByUsername(args[1]);
    if (!who) return [`${args[1]} is not online on this server`];
    return [(await stop(who)) ? `Stopped the cutscene of ${who === admin ? "you" : who.username}` : `${who === admin ? "You are" : `${who.username} is`} not in a cutscene`];
  }

  if (sub === "reset") {
    if (!args[1] || !args[2]) return usage;
    if (!(await resetViews(args[1], args[2]))) return [`There is no cutscene called ${args[1]}`];
    return [`${args[2]} has not seen ${args[1]} now: it plays for them again`];
  }

  return usage;
}

// ---------------------------------------------------------------- wiring

let started = false;

/**
 * Starts the triggers and the clean-up: reads the scenes' triggers, listens to the events they follow and indexes them
 * again when the cached list changes. Called once at startup (socket/server.ts).
 */
export async function init(): Promise<void> {
  if (started) return;
  started = true;
  try {
    await reindex();
  } catch (error) {
    log.warn(`[Cutscenes] The triggers could not be indexed: ${error}`);
  }
  // This process's own writes of the list. A write by another node (a shared cache) is not heard, so it is read again on a timer too.
  assetCache.onChange?.("cutscenes", () => {
    reindex().catch((error) => log.warn(`[Cutscenes] The triggers could not be indexed: ${error}`));
  });

  const quiet = (what: string) => (error: unknown) => log.warn(`[Cutscenes] ${what} failed: ${error}`);
  listener.on(Events.PLAYER_AUTH_COMPLETE, ({ username }: { username?: string }) => {
    if (byKind.get("login")?.length && username) pendingLogins.add(lower(username));
  });
  playerCache.onAdd((_key, value) => whenInWorld(value));
  listener.on(Events.MAP_ENTER, ({ player, mapName }: { player?: any; mapName?: string }) => {
    if (byKind.get("map")?.length) onMapEnter(player, String(mapName ?? "")).catch(quiet("A map scene"));
  });
  listener.on(Events.QUEST_ACCEPTED, ({ username, questId }: { username?: string; questId?: number }) => {
    if (username) onQuest(username, "quest_accept", Number(questId)).catch(quiet("A quest scene"));
  });
  listener.on(Events.QUEST_COMPLETED, ({ username, questId }: { username?: string; questId?: number }) => {
    if (username) onQuest(username, "quest_complete", Number(questId)).catch(quiet("A quest scene"));
  });
  // A player who dies is not watching: their scene ends where they lie, with no end to run.
  listener.on(Events.PLAYER_DEATH, ({ player }: { player?: any }) => {
    if (live(player)) void stop(player).catch(quiet("Ending a scene at a death"));
  });
  listener.on(Events.PLAYER_DISCONNECT, ({ player }: { player?: any }) => clear(player));
  listener.on(Events.PLAYER_LOGOUT, ({ player }: { player?: any }) => clear(player));

  let ticks = 0;
  listener.on(Events.SERVER_TICK, () => {
    tickAreas().catch(quiet("The area scenes' look"));
    if (++ticks % 15 === 0) reindex().catch(quiet("Indexing the triggers"));
  });
}
