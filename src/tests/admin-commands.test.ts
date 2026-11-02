import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { databaseModule } from "./setup";
import { receiverSource } from "./receiver-source";

// ------------------------------------------------------------ fake database
// The accounts the commands look up, and the permissions table as the real
// permissions module reads and writes it.

type Row = Record<string, any>;
let accounts: Row[];
let held: Record<string, string>;
const PERMISSION_TYPES = ["admin.*", "admin.kick", "admin.ban", "admin.warp", "server.*", "permission.*"];

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, params: any[] = []) => {
    const text = sql.replace(/\s+/g, " ").trim();
    if (text.startsWith("SELECT permissions FROM permissions")) return params[0] in held ? [{ permissions: held[params[0]] }] : [];
    if (text.startsWith("INSERT INTO permissions")) held[params[0]] = params[1];
    if (text.startsWith("DELETE FROM permissions")) delete held[params[0]];
    if (text.startsWith("SELECT name FROM permission_types")) return PERMISSION_TYPES.map((name) => ({ name }));
    return [];
  },
}));

const { default: permissions, canGrant, outranks } = await import("../systems/permissions");
const { clearCaches } = await import("../services/datacache");
const { followServerOrder, restartState, shutdownEverywhere, startRestart, toggleRestart } = await import("../socket/serverorders");

// ------------------------------------------------------------------ harness
// The receiver cannot be imported (it starts the server), so a command is run
// from its source: the body of its case, with the names it uses handed in.

const source = receiverSource();
const commandsAt = source.indexOf('      case "COMMAND": {');
/** The body of one chat command's case, up to the next command. */
function commandBlock(name: string): string {
  const start = source.indexOf(`\n          case "${name}":`, commandsAt);
  if (start < 0) return "";
  const body = source.indexOf("{", start);
  const end = source.indexOf('\n          case "', body);
  return source.slice(start, end < 0 ? body + 4000 : end);
}

/** What a command's body may name: the receiver's own, each one a fake here. */
const NAMES = [
  "commandName", "currentPlayer", "wt", "args", "sendPacket", "packetManager", "player", "playerCache", "permissions", "log",
  "listener", "Events", "maps", "mapPropertiesCache", "transitionPlayerToMap", "spawnBatchQueue", "despawnBatchQueue",
  "gracefulShutdown", "drainQueries", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "Bun",
  "defaultMap", "resurrection", "resyncNpcChunks", "filterPlayersByMap", "spellEffects", "canGrant", "outranks",
  "runOnPlayer", "tryOnPlayer", "isOnline", "whetherOnline", "broadcastWorld", "panelHears", "clearShared", "heldInScene",
  "restartState", "toggleRestart", "shutdownEverywhere", "sendServerOrder",
  "resetCooldowns", "assetCache", "inventory", "getIconUrl", "settleStoreAttached", "settleForAdmin", "settlingNotice",
];
/** Functions beside the commands that they call, which use the same names. */
const HELPERS = ["serverOrderDeps", "respawnPlayer", "endCooldowns", "killRefusal", "giveItem", "notSent"];
/** The source of one of those functions, without its `export`. */
function helperSource(name: string): string {
  const start = source.search(new RegExp(`^(export )?(async )?function ${name}\\b`, "m"));
  if (start < 0) throw new Error(`The commands have no ${name}`);
  return source.slice(start, source.indexOf("\n}\n", start) + 3).replace(/^export /, "");
}
/** The receiver's module state, declared as it is there. */
const moduleState = [
  ...[...source.matchAll(/^let (\w+)[^\n]*;\r?$/gm)].map((match) => ({ name: match[1], line: match[0] })),
  // The revision counter, as the receiver exports it to the handler modules.
  { name: "(?:bumpStateRevision|stateRevision)", line: "let globalStateRevision = 0;\nconst bumpStateRevision = () => ++globalStateRevision;\nconst stateRevision = () => globalStateRevision;" },
];
const transpiler = new Bun.Transpiler({ loader: "ts" });

/** One command, ready to run. Its module state lasts as long as what is returned. */
function command(name: string): (names: Row) => Promise<void> {
  const block = commandBlock(name);
  if (!block) throw new Error(`The receiver has no ${name} command`);
  const helpers = HELPERS.map(helperSource).join("\n");
  const state = moduleState.filter((item) => new RegExp(`\\b${item.name}\\b`).test(`${block}\n${helpers}`)).map((item) => item.line).join("\n");
  const body = transpiler.transformSync(`${state}\nasync function run({ ${NAMES.join(", ")} }: any) {\n${helpers}\nswitch (commandName) {${block}\n} }`);
  return new Function(`"use strict";\n${body}\nreturn run;`)();
}

// ------------------------------------------------------------------ fixtures

let online: Record<string, any>;
let boss: any;
let mod: any;
let hero: any;
/** Every packet sent, with the connection it went to. */
let sent: Array<{ to: any; packets: any[] }>;
let emitted: any[][];
let closed: string[];
/** What the end of a shutdown did, in order. */
let ending: string[];
/** What the other nodes were told. */
let orders: any[];
/** Whether the clear guard (cluster/clearguard.ts) lets the clear run: false while another node of the region is alive. */
let clearAllowed: boolean;
let spawned: any[];
let timeouts: Array<{ run: () => any; ms: number; cleared: boolean }>;
let intervals: Array<{ run: () => any; ms: number; cleared: boolean }>;
let moved: any[][];
let transitions: any[][];
/** Rows the location update reports as changed. */
let locationRows: number;
/** Players online on another node of the cluster. */
let elsewhere: Set<string>;
/** The cluster store is out: a player on no connection here cannot be looked for. */
let storeOut: boolean;
/** Each action run on a player, and each world broadcast. */
let ran: any[][];
let broadcasts: any[][];
/** Each item added, what reached an admin on another node, and each death. */
let added: any[][];
let answers: string[][];
let deaths: any[][];

const accountOf = (username: string) => accounts.find((row) => row.username === String(username).toLowerCase());
/** The columns of an account a saved location is. */
const savedAt = (map: string, position: Row) => ({ map, position: `${Math.round(position.x)},${Math.round(position.y)}`, direction: position.direction });
/** What a connection was told, as the notifications it was sent. */
const told = (who: any) => sent.filter((entry) => entry.to === who.wt).flatMap((entry) => entry.packets).filter((packet) => packet.type === "NOTIFY").map((packet) => packet.data.message);

const onlineHere = (username: string) => Object.values(online).find((live) => live.username.toLowerCase() === username.toLowerCase());

function connect(id: string, username: string, over: Row = {}): any {
  const live: Row = {
    id, username, isAdmin: false, permissions: [] as string[],
    location: { map: "main", position: { x: 10, y: 20, direction: "down" } },
    ...over,
  };
  live.wt = { close: () => { closed.push(username); } };
  online[id] = live;
  return live;
}

/** As cluster/deliver.ts answers: the action runs on the node that holds the player, and a store that is out finds nobody elsewhere. */
async function tryOnPlayer(username: string, action: string, args?: unknown): Promise<"sent" | "offline" | "unreached"> {
  const here = onlineHere(username);
  if (!here && storeOut) return "unreached";
  ran.push([username, action, args]);
  if (here && action === "admin-kick") here.wt.close();
  return here || elsewhere.has(username.toLowerCase()) ? "sent" : "offline";
}

/** The names a command's body uses, standing for what the receiver has. */
function names(name: string, args: string[], over: Row = {}): Row {
  return {
    commandName: name,
    currentPlayer: boss,
    wt: boss.wt,
    args,
    sendPacket: (to: any, packets: any[]) => { sent.push({ to, packets }); },
    packetManager: {
      notify: (data: Row) => [{ type: "NOTIFY", data }],
      reconnect: () => [{ type: "RECONNECT", data: null }],
      cooldownsReset: () => [{ type: "COOLDOWNS_RESET", data: null }],
      addInventoryItem: (data: Row) => [{ type: "ADD_INVENTORY_ITEM", data }],
      moveXY: (data: Row) => [{ type: "MOVEXY", data }],
      playerGhost: (data: Row) => [{ type: "PLAYER_GHOST", data }],
      revive: (data: Row) => [{ type: "REVIVE", data }],
    },
    // As systems/player.ts answers: a name with no account is an empty list.
    player: {
      findPlayerInDatabase: async (username: string) => accounts.filter((row) => row.username === username.toLowerCase()).map((row) => ({ username: row.username, banned: row.banned })),
      isAdmin: async (username: string) => accountOf(username)?.role === 1,
      toggleAdmin: async (username: string) => {
        const row = accountOf(username);
        if (row) row.role = row.role ? 0 : 1;
        // As systems/player.ts does: a demoted admin's permissions go with the role.
        if (row && row.role === 0) await permissions.clear(row.username);
        return row?.role === 1;
      },
      unban: async (username: string) => {
        const row = accountOf(username);
        if (row) row.banned = 0;
      },
      // As systems/player.ts does: the account is banned and the connection given is closed.
      ban: async (username: string, wt: any) => {
        const row = accountOf(username);
        if (row) row.banned = 1;
        if (wt) wt.close();
      },
      // A location is saved as systems/player.ts saves it: for the session with that id, or for that username.
      // A username handed to the first is no session's id, and saves nothing.
      setLocation: async (...call: any[]) => {
        moved.push(call);
        const row = online[call[0]] ? accountOf(online[call[0]].username) : undefined;
        if (!row || !locationRows) return { affectedRows: 0 };
        Object.assign(row, savedAt(call[1], call[2]));
        return { affectedRows: locationRows };
      },
      setLocationByUsername: async (username: string, map: string, position: Row) => {
        const row = accountOf(username);
        if (row) Object.assign(row, savedAt(map, position));
        return { affectedRows: row ? 1 : 0 };
      },
      synchronizeStats: async () => null,
      setDeadState: async () => {},
      clear: async () => { ending.push("player.clear"); },
    },
    playerCache: {
      list: () => online,
      get: (id: string) => online[id],
      set: (id: string, value: any) => { online[id] = value; },
    },
    permissions,
    canGrant,
    outranks,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, success: () => {} },
    listener: { emit: (...event: any[]) => { emitted.push(event); } },
    Events: { GUILD_CHANGED: "onGuildChanged", PLAYER_DISCONNECT: "onPlayerDisconnect", PLAYER_RESPAWN: "onPlayerRespawn" },
    maps: [{ name: "main.json" }, { name: "cave.json" }],
    mapPropertiesCache: [{ name: "cave.json", width: 10, height: 20, tileWidth: 32, tileHeight: 32 }],
    transitionPlayerToMap: async (...call: any[]) => { transitions.push(call); },
    spawnBatchQueue: new Map(),
    despawnBatchQueue: new Map(),
    clearShared: async (clear: () => Promise<void>) => {
      if (!clearAllowed) return false;
      await clear();
      return true;
    },
    gracefulShutdown: async (reason: string) => { ending.push(`gracefulShutdown ${reason}`); },
    drainQueries: async () => { ending.push("drainQueries"); },
    setTimeout: (run: () => any, ms: number) => {
      const timer = { run, ms, cleared: false };
      timeouts.push(timer);
      return timer;
    },
    clearTimeout: (timer: any) => { if (timer) timer.cleared = true; },
    setInterval: (run: () => any, ms: number) => {
      const timer = { run, ms, cleared: false };
      intervals.push(timer);
      return timer;
    },
    clearInterval: (timer: any) => { if (timer) timer.cleared = true; },
    Bun: { spawn: (...call: any[]) => { spawned.push(call); } },
    // The map a respawn goes to.
    defaultMap: "cave",
    resurrection: { clearSickness: () => {} },
    resyncNpcChunks: async () => {},
    filterPlayersByMap: (map: string) => Object.values(online).filter((live) => live.location.map === map),
    spellEffects: { broadcastEffectsUpdate: () => {} },
    // As cluster/deliver.ts answers: a player here, or on another node, is online; the action runs on the node that holds them.
    isOnline: async (username: string) => !!onlineHere(username) || (!storeOut && elsewhere.has(username.toLowerCase())),
    whetherOnline: async (username: string) => (onlineHere(username) ? true : storeOut ? null : elsewhere.has(username.toLowerCase())),
    runOnPlayer: async (username: string, action: string, args?: unknown) => (await tryOnPlayer(username, action, args)) === "sent",
    tryOnPlayer,
    broadcastWorld: async (packets: any[]) => { broadcasts.push(packets); },
    panelHears: () => {},
    heldInScene: () => false,
    restartState,
    toggleRestart,
    shutdownEverywhere,
    sendServerOrder: async (order: any) => { orders.push(order); },
    resetCooldowns: async () => {},
    assetCache: { get: async () => [{ name: "Iron Ore", type: "material" }] },
    inventory: { add: async (...call: any[]) => { added.push(call); } },
    getIconUrl: () => null,
    settleStoreAttached: () => false,
    settleForAdmin: async () => null,
    settlingNotice: () => "",
    ...over,
  };
}

const run = (name: string, args: string[] = [], over: Row = {}) => command(name)(names(name, args, over));

/** The actions the commands leave on a player's node, registered as the module registers them, with the same fakes. */
function remoteActions(over: Row = {}): Record<string, (target: any, args?: any) => Promise<void>> {
  const start = source.indexOf("function adminAction(");
  const block = source.slice(start, source.indexOf("\n}));\n", source.indexOf('registerPlayerAction("cells-permissions"', start)) + 6);
  const helpers = HELPERS.map(helperSource).join("\n");
  const state = moduleState.filter((item) => new RegExp(`\\b${item.name}\\b`).test(`${block}\n${helpers}`)).map((item) => item.line).join("\n");
  const actions: Record<string, (target: any, args?: any) => Promise<void>> = {};
  const given: Row = {
    registerPlayerAction: (name: string, action: (target: any, args?: any) => Promise<void>) => { actions[name] = action; },
    guardedAction: (_name: string, action: unknown) => action,
    trackPacket: (_id: string, work: () => Promise<void>) => work(),
    remoteAdminOf: (args: any) => (typeof args?.by === "string" ? args.by : null),
    deliverToPlayer: async (username: string, packets: any[]) => { answers.push(...packets.map((packet) => [username, packet.data.message])); return true; },
    busyNote: (name: string) => [{ type: "NOTIFY", data: { message: `${name} is busy` } }],
    isHeld: () => false,
    heldNote: () => "held in a scene",
    handlePlayerDeath: async (...call: any[]) => { deaths.push(call); },
    ...over,
  };
  const body = transpiler.transformSync(`${state}\nfunction register({ ${[...NAMES, ...Object.keys(given)].join(", ")} }: any) {\n${helpers}\n${block}\n}`);
  new Function(`"use strict";\n${body}\nreturn register;`)()({ ...names("", []), ...given });
  return actions;
}

/** What the commands hand a server order, from the same source and the same fakes. */
function serverDeps(): any {
  const given = names("RESTART", []);
  const body = transpiler.transformSync(`function deps({ ${NAMES.join(", ")} }: any) {\n${helperSource("serverOrderDeps")}\nreturn serverOrderDeps(); }`);
  return new Function(`"use strict";\n${body}\nreturn deps;`)()(given);
}

let consoleLog: ReturnType<typeof spyOn>;
beforeAll(() => {
  // The permissions module writes what it changed to the log.
  consoleLog = spyOn(console, "log").mockImplementation(() => {});
});
beforeEach(async () => {
  await clearCaches();
  Object.assign(restartState, { scheduled: false, timers: [], shutdownStarted: false });
  orders = [];
  online = {};
  sent = [];
  emitted = [];
  closed = [];
  ending = [];
  clearAllowed = true;
  spawned = [];
  timeouts = [];
  intervals = [];
  moved = [];
  transitions = [];
  locationRows = 1;
  elsewhere = new Set();
  storeOut = false;
  ran = [];
  broadcasts = [];
  added = [];
  answers = [];
  deaths = [];
  accounts = [
    { username: "ac_boss", banned: 0, role: 1 },
    { username: "ac_mod", banned: 0, role: 1 },
    { username: "ac_hero", banned: 0, role: 0 },
    { username: "ac_exile", banned: 1, role: 0 },
  ];
  held = { ac_mod: "admin.kick,admin.ban,admin.warp" };
  boss = connect("9101", "ac_boss", { isAdmin: true, permissions: ["admin.*", "server.*", "permission.*"] });
  mod = connect("9102", "ac_mod", { isAdmin: true, permissions: ["admin.kick", "admin.ban", "admin.warp"] });
  hero = connect("9103", "ac_hero");
});
afterAll(() => {
  consoleLog.mockRestore();
});

// --------------------------------------------------------------------- tests

describe("/shutdown", () => {
  test("warns, disconnects everyone, and ends the process once they are gone", async () => {
    const done = run("SHUTDOWN");
    expect(told(hero)).toEqual(["⚠️ Server shutting down - please reconnect in a few minutes ⚠️"]);
    expect(timeouts.map((timer) => timer.ms)).toEqual([5000]);
    expect(closed).toEqual([]);
    timeouts[0].run();
    await done;
    expect(closed.sort()).toEqual(["ac_boss", "ac_hero", "ac_mod"]);

    // Somebody is still being disconnected: nothing ends yet.
    expect(intervals).toHaveLength(1);
    await intervals[0].run();
    expect(ending).toEqual([]);
    expect(intervals[0].cleared).toBe(false);

    // Everyone is out: clear what a session leaves behind, let the database
    // finish what the disconnects wrote, then stop the server.
    online = {};
    await intervals[0].run();
    expect(intervals[0].cleared).toBe(true);
    expect(ending).toEqual(["player.clear", "drainQueries", "gracefulShutdown /shutdown"]);
    expect(spawned).toEqual([]);
  });

  test("in a cluster with another node alive it ends this node without clearing the shared guests and parties", async () => {
    clearAllowed = false;
    const done = run("SHUTDOWN");
    timeouts[0].run();
    await done;
    online = {};
    await intervals[0].run();
    expect(ending).toEqual(["drainQueries", "gracefulShutdown /shutdown"]);
  });

  test("is refused without its permission, and nothing is started", async () => {
    boss.permissions = ["admin.*", "permission.*"];
    await run("SHUTDOWN");
    expect(told(boss)).toEqual(["You don't have permission to use this command"]);
    expect(told(hero)).toEqual([]);
    expect(timeouts).toEqual([]);
    expect(intervals).toEqual([]);
    expect(ending).toEqual([]);
  });
});

describe("/restart", () => {
  test("counts down for 15 minutes, then disconnects everyone and ends the process", async () => {
    await run("RESTART");
    // A notice a minute, one a second for the last 30, and the restart itself.
    expect(timeouts).toHaveLength(15 + 30 + 1);
    const last = timeouts[timeouts.length - 1];
    expect(last.ms).toBe(15 * 60000);
    expect(Math.max(...timeouts.map((timer) => timer.ms))).toBe(last.ms);
    expect(closed).toEqual([]);
    expect(ending).toEqual([]);

    last.run();
    expect(closed.sort()).toEqual(["ac_boss", "ac_hero", "ac_mod"]);
    expect(intervals).toHaveLength(1);
    await intervals[0].run();
    expect(ending).toEqual([]);

    // The process ends here; whatever supervises it starts the server again.
    online = {};
    await intervals[0].run();
    expect(intervals[0].cleared).toBe(true);
    expect(ending).toEqual(["player.clear", "drainQueries", "gracefulShutdown /restart"]);
    expect(spawned).toEqual([]);
  });

  test("in a cluster with another node alive it ends this node without clearing the shared guests and parties", async () => {
    clearAllowed = false;
    await run("RESTART");
    timeouts[timeouts.length - 1].run();
    online = {};
    await intervals[0].run();
    expect(ending).toEqual(["drainQueries", "gracefulShutdown /restart"]);
  });

  test("both commands clear through the cluster guard, and never with player.clear directly", () => {
    const ending = helperSource("serverOrderDeps");
    expect(ending).toContain("clearShared(() => player.clear())");
    expect(ending.replace("clearShared(() => player.clear())", "")).not.toContain("player.clear(");
    for (const name of ["SHUTDOWN", "RESTART"]) expect(commandBlock(name)).not.toContain("player.clear(");
  });

  test("the other nodes are told to start, and to call it off", async () => {
    const before = Date.now();
    await run("RESTART");
    expect(orders).toHaveLength(1);
    expect(orders[0].what).toBe("restart");
    expect(orders[0].endsAt).toBeGreaterThanOrEqual(before + 15 * 60000);

    await run("RESTART");
    expect(orders[1]).toEqual({ what: "restart-off" });
  });

  test("a /shutdown tells the other nodes", async () => {
    const done = run("SHUTDOWN");
    expect(orders).toEqual([{ what: "shutdown" }]);
    timeouts[0].run();
    await done;
  });

  test("a node told by another counts down to the same moment", async () => {
    const deps = serverDeps();
    followServerOrder({ what: "restart", endsAt: Date.now() + 15 * 60000 }, deps);
    expect(restartState.scheduled).toBe(true);
    expect(orders).toEqual([]);

    const last = timeouts[timeouts.length - 1];
    expect(timeouts).toHaveLength(15 + 30 + 1);
    expect(last.ms).toBeGreaterThan(15 * 60000 - 1000);
    expect(last.ms).toBeLessThanOrEqual(15 * 60000);
    // The first notice is not lost to the time the order took to get here.
    expect(timeouts[0].ms).toBe(0);

    followServerOrder({ what: "restart-off" }, deps);
    expect(restartState.scheduled).toBe(false);
    expect(timeouts.every((timer) => timer.cleared)).toBe(true);
    expect(told(hero)).toEqual(["⚠️ Server restart has been aborted ⚠️"]);
    expect(orders).toEqual([]);
  });

  test("a node that starts part way through gives only the notices still to come", () => {
    startRestart(5 * 60000 + 10000, serverDeps());
    // Minutes 5 to 1, seconds 30 to 1, and the restart.
    expect(timeouts).toHaveLength(5 + 30 + 1);
    expect(Math.min(...timeouts.map((timer) => timer.ms))).toBe(10000);
    expect(timeouts[timeouts.length - 1].ms).toBe(5 * 60000 + 10000);
  });

  test("an order for a restart that has passed starts nothing", () => {
    followServerOrder({ what: "restart", endsAt: Date.now() - 1 }, serverDeps());
    expect(restartState.scheduled).toBe(false);
    expect(timeouts).toEqual([]);
  });
});

describe("/shutdown ordered from another node", () => {
  test("warns and ends this node, without telling anyone else", async () => {
    followServerOrder({ what: "shutdown" }, serverDeps());
    expect(told(hero)).toEqual(["⚠️ Server shutting down - please reconnect in a few minutes ⚠️"]);
    expect(orders).toEqual([]);
    timeouts[0].run();
    await Promise.resolve();
    await Promise.resolve();
    expect(closed.sort()).toEqual(["ac_boss", "ac_hero", "ac_mod"]);
    online = {};
    await intervals[0].run();
    expect(ending).toEqual(["player.clear", "drainQueries", "gracefulShutdown /shutdown"]);
  });

  test("a second order does nothing", async () => {
    followServerOrder({ what: "shutdown" }, serverDeps());
    followServerOrder({ what: "shutdown" }, serverDeps());
    expect(timeouts).toHaveLength(1);
  });
  test("asked again before then, the countdown is called off", async () => {
    const restart = command("RESTART");
    await restart(names("RESTART", []));
    const scheduled = [...timeouts];
    await restart(names("RESTART", []));
    expect(scheduled.every((timer) => timer.cleared)).toBe(true);
    expect(timeouts).toHaveLength(scheduled.length);
    expect(told(hero)).toEqual(["⚠️ Server restart has been aborted ⚠️"]);
    expect(ending).toEqual([]);
  });
});

describe("/permission", () => {
  test("granting is for admins only: add and set are refused for anyone else", async () => {
    held.ac_hero = "admin.kick";
    for (const args of [
      ["add", "ac_hero", "admin.ban"],
      ["set", "ac_hero", "admin.ban"],
      // Offline: read from the database.
      ["add", "ac_exile", "admin.ban"],
    ]) {
      sent = [];
      await run("PERMISSION", args);
      expect(told(boss)).toEqual(["You can only grant permissions to admin players"]);
    }
    expect(held).toEqual({ ac_mod: "admin.kick,admin.ban,admin.warp", ac_hero: "admin.kick" });
    expect(hero.permissions).toEqual([]);
  });

  test("a lower admin cannot change a higher admin's permissions", async () => {
    held.ac_boss = "admin.*,server.*,permission.*";
    mod.permissions = ["admin.permission", "permission.add", "permission.remove", "admin.kick"];
    for (const args of [["set", "ac_boss", "admin.kick"], ["remove", "ac_boss", "server.*"], ["clear", "ac_boss"]]) {
      sent = [];
      await run("PERMISSION", args, { currentPlayer: mod, wt: mod.wt });
      expect(told(mod)).toEqual(["You cannot change the permissions of someone who holds permissions you cannot grant"]);
    }
    expect(held.ac_boss).toBe("admin.*,server.*,permission.*");
  });

  test("permission.* does not give server.*", async () => {
    held.ac_mod = "admin.kick";
    hero.permissions = ["admin.permission", "permission.*"];
    await run("PERMISSION", ["add", "ac_mod", "server.*"], { currentPlayer: hero, wt: hero.wt });
    expect(told(hero)).toEqual(["You cannot grant the server.* permission"]);
    expect(held.ac_mod).toBe("admin.kick");
  });

  test("what a former admin still holds can be listed, removed and cleared", async () => {
    held.ac_hero = "admin.kick,admin.ban";
    hero.permissions = ["admin.kick", "admin.ban"];

    await run("PERMISSION", ["list", "ac_hero"]);
    expect(told(boss)).toEqual(["Permissions for Ac_hero: admin.kick, admin.ban"]);

    await run("PERMISSION", ["remove", "ac_hero", "admin.kick"]);
    expect(held.ac_hero).toBe("admin.ban");
    expect(hero.permissions).toEqual(["admin.ban"]);

    await run("PERMISSION", ["clear", "ac_hero"]);
    expect("ac_hero" in held).toBe(false);
    expect(hero.permissions).toEqual([]);
  });

  test("add takes a comma-separated list, and stores each name once", async () => {
    await run("PERMISSION", ["add", "ac_mod", "admin.kick,server.*"]);
    expect(held.ac_mod).toBe("admin.kick,admin.ban,admin.warp,server.*");
    expect(mod.permissions).toEqual(["admin.kick", "admin.ban", "admin.warp", "server.*"]);
  });

  test("an admin's are changed, in the database and on the player who is online", async () => {
    await run("PERMISSION", ["remove", "ac_mod", "admin.kick"]);
    expect(held.ac_mod).toBe("admin.ban,admin.warp");
    expect(mod.permissions).toEqual(["admin.ban", "admin.warp"]);
    expect(told(boss)).toEqual(["Permissions removed from Ac_mod"]);

    await run("PERMISSION", ["add", "ac_mod", "admin.kick"]);
    expect(held.ac_mod).toBe("admin.ban,admin.warp,admin.kick");
    expect(mod.permissions).toEqual(["admin.ban", "admin.warp", "admin.kick"]);
  });

  test("remove takes a comma-separated list, and removes each of them", async () => {
    await run("PERMISSION", ["remove", "ac_mod", "admin.kick,admin.ban"]);
    expect(held.ac_mod).toBe("admin.warp");
    expect(mod.permissions).toEqual(["admin.warp"]);

    // One that is not held does not stop the others.
    await run("PERMISSION", ["remove", "ac_mod", "admin.kick,", "admin.warp"]);
    expect(held.ac_mod).toBe("");
    expect(mod.permissions).toEqual([]);
  });

  test("the per-permission rules still decide who may ask", async () => {
    boss.permissions = ["admin.*"];
    await run("PERMISSION", ["remove", "ac_mod", "admin.kick"]);
    expect(told(boss)).toEqual(["Insufficient permissions for this operation"]);
    expect(held.ac_mod).toBe("admin.kick,admin.ban,admin.warp");
  });
});

describe("/warp", () => {
  test("moves the admin to the middle of the map, and says nothing to the guild or of a disconnect", async () => {
    await run("WARP", ["cave"]);
    expect(moved).toEqual([["9101", "cave", { x: 160, y: 320, direction: "down" }]]);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].slice(0, 4)).toEqual([boss, "cave", { x: 160, y: 320, direction: "down" }, boss.wt]);
    expect(told(boss)).toEqual([]);
    expect(emitted).toEqual([]);
  });

  test("a location that could not be saved is said, and is not an event either", async () => {
    locationRows = 0;
    await run("WARP", ["cave"]);
    expect(transitions).toEqual([]);
    expect(told(boss)).toEqual(["Failed to update location"]);
    expect(emitted).toEqual([]);
  });

  test("takes a map only: with a player named, nobody is moved and the admin is told", async () => {
    await run("WARP", ["cave", "ac_hero"]);
    expect(told(boss)).toEqual(["Warping another player is not supported. Usage: /warp <map>"]);
    expect(moved).toEqual([]);
    expect(transitions).toEqual([]);
    expect(emitted).toEqual([]);
  });
});

describe("/unban", () => {
  test("a name with no account is answered", async () => {
    await run("UNBAN", ["ac_nobody"]);
    expect(told(boss)).toEqual(["Player not found or is not online"]);
  });

  test("a banned player is unbanned", async () => {
    await run("UNBAN", ["AC_Exile"]);
    expect(accountOf("ac_exile")!.banned).toBe(0);
    expect(told(boss)).toEqual(["Unbanned ac_exile from the server"]);
  });
});

describe("/admin", () => {
  test("a name with no account is answered, and no role is changed", async () => {
    const before = JSON.stringify(accounts);
    await run("ADMIN", ["ac_nobody"]);
    expect(told(boss)).toEqual(["Player not found"]);
    expect(JSON.stringify(accounts)).toBe(before);
  });

  test("no name at all is answered", async () => {
    await run("SETADMIN", []);
    expect(told(boss)).toEqual(["Please provide a username or ID"]);
  });

  test("flips the role of a player who is online, and of one who is not", async () => {
    await run("ADMIN", ["ac_hero"]);
    expect(accountOf("ac_hero")!.role).toBe(1);
    expect(hero.isAdmin).toBe(true);
    expect(told(boss)).toEqual(["Ac_hero is now an admin"]);
    expect(sent.some((entry) => entry.to === hero.wt && entry.packets[0].type === "RECONNECT")).toBe(true);

    sent = [];
    await run("ADMIN", ["ac_exile"]);
    expect(accountOf("ac_exile")!.role).toBe(1);
    expect(told(boss)).toEqual(["Ac_exile is now an admin"]);
  });

  test("a demoted admin loses what they held, online and in the table", async () => {
    await run("ADMIN", ["ac_mod"]);
    expect(accountOf("ac_mod")!.role).toBe(0);
    expect("ac_mod" in held).toBe(false);
    expect(mod.permissions).toEqual([]);
  });

  test("a lower admin cannot demote a higher one", async () => {
    held.ac_boss = "server.*";
    mod.permissions = ["server.admin"];
    await run("ADMIN", ["ac_boss"], { currentPlayer: mod, wt: mod.wt });
    expect(told(mod)).toEqual(["You cannot change the admin status of someone who holds permissions you cannot grant"]);
    expect(accountOf("ac_boss")!.role).toBe(1);
  });
});

describe("/ban of an admin", () => {
  test("is refused when the admin is offline too", async () => {
    delete online["9101"];
    await run("BAN", ["ac_boss"], { currentPlayer: mod, wt: mod.wt });
    expect(told(mod)).toEqual(["You cannot ban other admins"]);
    expect(accountOf("ac_boss")!.banned).toBe(0);
  });
});

describe("a player on another node", () => {
  beforeEach(() => {
    accounts.push({ username: "ac_far", banned: 0, role: 0 }, { username: "ac_farboss", banned: 0, role: 1 });
    elsewhere.add("ac_far");
    elsewhere.add("ac_farboss");
  });

  test("/kick of a player here goes through the action, and of one elsewhere too", async () => {
    await run("KICK", ["ac_hero"]);
    expect(ran).toEqual([["ac_hero", "admin-kick", undefined]]);
    expect(closed).toEqual(["ac_hero"]);
    expect(told(boss)).toEqual(["Disconnected Ac_hero from the server"]);

    sent = [];
    ran = [];
    await run("KICK", ["ac_far"]);
    expect(ran).toEqual([["ac_far", "admin-kick", undefined]]);
    expect(told(boss)).toEqual(["Disconnected Ac_far from the server"]);
  });

  test("/kick still refuses an admin there, and a name that is online nowhere is not found", async () => {
    await run("KICK", ["ac_farboss"]);
    expect(told(boss)).toEqual(["You cannot disconnect other admins"]);
    sent = [];
    await run("KICK", ["ac_nobody"]);
    expect(told(boss)).toEqual(["Player not found or is not online"]);
    expect(ran).toEqual([]);
  });

  test("/ban bans the account and ends the session where it is: here by the connection, elsewhere by the action", async () => {
    await run("BAN", ["ac_hero"]);
    expect(accountOf("ac_hero")!.banned).toBe(1);
    expect(closed).toEqual(["ac_hero"]);
    expect(ran).toEqual([]);

    await run("BAN", ["ac_far"]);
    expect(accountOf("ac_far")!.banned).toBe(1);
    expect(ran).toEqual([["ac_far", "admin-kick", undefined]]);
    expect(told(boss)).toEqual(["Banned Ac_hero from the server", "Banned Ac_far from the server"]);
  });

  test("/ban of an offline account bans it and has nobody to disconnect", async () => {
    await run("BAN", ["ac_farboss"]);
    expect(told(boss)).toEqual(["You cannot ban other admins"]);
    sent = [];
    accounts.push({ username: "ac_gone", banned: 0, role: 0 });
    await run("BAN", ["ac_gone"]);
    expect(accountOf("ac_gone")!.banned).toBe(1);
    expect(ran).toEqual([["ac_gone", "admin-kick", undefined]]);
    expect(closed).toEqual([]);
  });

  test("/summon of a player on another node runs the summon there, with the admin's point", async () => {
    await run("SUMMON", ["ac_far"]);
    expect(ran).toEqual([["ac_far", "cells-summon", { by: "ac_boss", map: "main", x: 10, y: 20, why: "summon", admins: true }]]);
    // The target's node tells the admin how it went.
    expect(told(boss)).toEqual([]);
    expect(moved).toEqual([]);
    expect(transitions).toEqual([]);
  });

  test("/summon tells the target's node when the admin may not summon admins", async () => {
    const summoner = connect("9104", "ac_summoner", { isAdmin: true, permissions: ["admin.summon"] });
    await run("SUMMON", ["ac_farboss"], { currentPlayer: summoner, wt: summoner.wt });
    expect(ran).toEqual([["ac_farboss", "cells-summon", { by: "ac_summoner", map: "main", x: 10, y: 20, why: "summon", admins: false }]]);
  });

  test("/teleport and /goto to a player on another node ask that node for the player's point", async () => {
    for (const name of ["TELEPORT", "GOTO"]) {
      ran = [];
      await run(name, ["ac_far"]);
      // The admin's own held permission goes with it (admin.*, as /summon reads it): the target's node passes it on.
      expect(ran).toEqual([["ac_far", "cells-teleport-to", { by: "ac_boss", admins: true }]]);
      expect(told(boss)).toEqual([]);
    }
    expect(moved).toEqual([]);
    expect(transitions).toEqual([]);
  });

  test("/teleport tells the target's node when the admin may not summon admins", async () => {
    const visitor = connect("9105", "ac_visitor", { isAdmin: true, permissions: ["admin.summon"] });
    await run("TELEPORT", ["ac_far"], { currentPlayer: visitor, wt: visitor.wt });
    expect(ran).toEqual([["ac_far", "cells-teleport-to", { by: "ac_visitor", admins: false }]]);
  });

  test("/revive of a player on another node runs the revive there", async () => {
    await run("REVIVE", ["ac_far"]);
    expect(ran).toEqual([["ac_far", "cells-revive", { by: "ac_boss" }]]);
    expect(told(boss)).toEqual([]);
  });

  test("/summon, /teleport and /revive of a name online nowhere are not found", async () => {
    for (const name of ["SUMMON", "TELEPORT"]) {
      sent = [];
      await run(name, ["ac_nobody"]);
      expect(told(boss)).toEqual(["Player not found or is not online"]);
    }
    sent = [];
    await run("REVIVE", ["ac_nobody"]);
    expect(told(boss)).toEqual(["Player must be online to revive"]);
    expect(moved).toEqual([]);
    expect(transitions).toEqual([]);
  });

  test("an id that is not here is not looked for on another node", async () => {
    for (const name of ["SUMMON", "TELEPORT", "REVIVE"]) {
      sent = [];
      await run(name, ["424242"]);
      expect(told(boss)).toEqual([name === "REVIVE" ? "Player must be online to revive" : "Player not found or is not online"]);
    }
    expect(ran).toEqual([]);
  });

  test("a player here who is being handed off is not summoned or revived", async () => {
    hero.handoff = true;
    hero.isDead = true;
    await run("SUMMON", ["ac_hero"]);
    expect(told(boss)).toEqual(["Ac_hero is changing server node; try again"]);
    sent = [];
    await run("REVIVE", ["ac_hero"]);
    expect(told(boss)).toEqual(["Ac_hero is changing server node; try again"]);
    expect(hero.isDead).toBe(true);
    expect(moved).toEqual([]);
    expect(transitions).toEqual([]);
    expect(ran).toEqual([]);
  });

  test("/broadcast to all is one world broadcast; to a map it stays on this node", async () => {
    await run("BROADCAST", ["ALL", "Hello", "world"]);
    expect(broadcasts).toEqual([[{ type: "NOTIFY", data: { message: "Hello world" } }]]);
    expect(told(hero)).toEqual([]);
    await run("BROADCAST", ["MAP", "Near"]);
    expect(broadcasts.length).toBe(1);
    expect(told(hero)).toEqual(["Near"]);
  });
});

describe("no name given", () => {
  // Each of these read args[0] without checking it was there, and threw.
  test("/kick and /ban ask for one", async () => {
    for (const name of ["KICK", "DISCONNECT", "BAN"]) {
      sent = [];
      await run(name, []);
      expect(told(boss)).toEqual(["Please provide a username or ID"]);
    }
    expect(closed).toEqual([]);
  });

  test("/respawn respawns the admin who asked", async () => {
    await run("RESPAWN", []);
    // Where they now stand is saved, not only shown.
    expect(accountOf("ac_boss")).toMatchObject({ map: "cave", position: "160,320", direction: "down" });
    expect(boss.location.position).toEqual({ x: 160, y: 320, direction: "down" });
    expect(told(boss)).toEqual(["Respawned Ac_boss"]);
    expect(emitted.map((event) => event[0])).toEqual(["onPlayerRespawn"]);
  });
});

describe("/respawn", () => {
  test("of another player who is online moves them and saves where they are, by name or by connection id", async () => {
    for (const identifier of ["AC_Hero", "9103"]) {
      delete accountOf("ac_hero")!.position;
      hero.location.position = { x: 10, y: 20, direction: "up" };
      sent = [];
      emitted = [];

      await run("RESPAWN", [identifier]);

      expect(accountOf("ac_hero")).toMatchObject({ map: "cave", position: "160,320", direction: "down" });
      expect(hero.location.position).toEqual({ x: 160, y: 320, direction: "down" });
      expect(told(boss)).toEqual(["Respawned Ac_hero"]);
      expect(emitted).toEqual([["onPlayerRespawn", { player: hero, mapName: "main", x: 160, y: 320 }]]);
    }
  });

  test("of a player who is offline saves it for their next login, and nobody is announced as respawned", async () => {
    await run("RESPAWN", ["ac_exile"]);

    expect(accountOf("ac_exile")).toMatchObject({ map: "cave", position: "160,320", direction: "down" });
    expect(told(boss)).toEqual(["Respawned Ac_exile"]);
    // There is no player in the world to respawn.
    expect(emitted).toEqual([]);
  });

  test("of a name with no account is answered, and nothing is saved", async () => {
    const before = JSON.stringify(accounts);
    await run("RESPAWN", ["ac_nobody"]);
    expect(told(boss)).toEqual(["Player not found"]);
    expect(JSON.stringify(accounts)).toBe(before);
    expect(emitted).toEqual([]);
  });

  test("is refused without its permission", async () => {
    boss.permissions = ["admin.kick"];
    await run("RESPAWN", ["ac_hero"]);
    expect(told(boss)).toEqual(["You don't have permission to use this command"]);
    expect(accountOf("ac_hero")!.position).toBeUndefined();
  });
});

describe("a player on another node", () => {
  beforeEach(() => {
    elsewhere.add("ac_far");
    accounts.push({ username: "ac_far", banned: 0, role: 1 });
  });

  test("/respawn runs on their node, and saves nothing here", async () => {
    await run("RESPAWN", ["ac_far"]);
    expect(ran).toEqual([["ac_far", "cells-respawn", { by: "ac_boss" }]]);
    expect(accountOf("ac_far")!.position).toBeUndefined();
    expect(told(boss)).toEqual([]);
  });

  test("/respawn of a player no node holds saves it for their next login", async () => {
    await run("RESPAWN", ["ac_exile"]);
    expect(ran).toEqual([["ac_exile", "cells-respawn", { by: "ac_boss" }]]);
    expect(accountOf("ac_exile")).toMatchObject({ map: "cave" });
  });

  test("/kill and /cooldowns run on their node, and need them online", async () => {
    for (const [name, action, refused] of [
      ["KILL", "cells-kill", "Player must be online to kill"],
      ["COOLDOWNS", "cells-cooldowns", "Player must be online to reset their cooldowns"],
    ]) {
      ran = [];
      sent = [];
      await run(name, ["ac_far"]);
      expect(ran).toEqual([["ac_far", action, { by: "ac_boss" }]]);
      expect(told(boss)).toEqual([]);

      await run(name, ["ac_exile"]);
      expect(told(boss)).toEqual([refused]);
    }
  });

  describe("while the cluster store is out", () => {
    const NOT_REACHED = "That player could not be reached, so nothing was done. They may be online on another server node.";
    beforeEach(() => {
      storeOut = true;
    });

    test("a command that needs the player online does not call them offline", async () => {
      for (const [name, commandArgs] of [["KILL", ["ac_far"]], ["COOLDOWNS", ["ac_far"]], ["REVIVE", ["ac_far"]], ["SUMMON", ["ac_far"]], ["TELEPORT", ["ac_far"]], ["KICK", ["ac_far"]]] as Array<[string, string[]]>) {
        sent = [];
        await run(name, commandArgs);
        expect([name, told(boss)]).toEqual([name, [NOT_REACHED]]);
      }
    });

    test("/respawn writes nothing to an account that may be online", async () => {
      await run("RESPAWN", ["ac_far"]);
      expect(accountOf("ac_far")!.map).toBeUndefined();
      expect(told(boss)).toEqual([NOT_REACHED]);
    });

    test("/give adds nothing to an account that may be online", async () => {
      await run("GIVE", ["ac_far", "Iron Ore", "3"]);
      expect(added).toEqual([]);
      expect(told(boss)).toEqual([NOT_REACHED]);
    });

    test("a player on this node is still acted on", async () => {
      await run("KICK", [hero.username]);
      expect(closed).toEqual([hero.username]);
      expect(told(boss)).not.toContain(NOT_REACHED);
    });
  });

  test("/kill and /cooldowns send no id: one is local to the node that gave it", async () => {
    await run("KILL", ["12345"]);
    await run("COOLDOWNS", ["12345"]);
    expect(ran).toEqual([]);
  });

  test("/give runs on their node, and adds nothing here", async () => {
    await run("GIVE", ["ac_far", "iron ore", "3"]);
    expect(ran).toEqual([["ac_far", "cells-give", { by: "ac_boss", item: "Iron Ore", quantity: 3 }]]);
    expect(added).toEqual([]);
    expect(told(boss)).toEqual([]);
  });

  test("/give to a player no node holds goes to their account", async () => {
    await run("GIVE", ["ac_exile", "Iron Ore", "3"]);
    expect(added).toEqual([["ac_exile", { name: "Iron Ore", quantity: 3 }]]);
    expect(told(boss)).toEqual(["Gave 3x Iron Ore to ac_exile"]);
  });

  test("/admin changes the account here and tells their node", async () => {
    await run("ADMIN", ["ac_far"]);
    expect(accountOf("ac_far")!.role).toBe(0);
    expect(ran).toEqual([["ac_far", "cells-role", { admin: false }]]);
    expect(told(boss)).toEqual(["Ac_far is now not an admin"]);
  });

  test("/permission changes the table here and tells their node, a look at it does not", async () => {
    await run("PERMISSION", ["add", "ac_far", "admin.kick"]);
    expect(held.ac_far).toBe("admin.kick");
    expect(ran).toEqual([["ac_far", "cells-permissions", undefined]]);

    ran = [];
    await run("PERMISSION", ["list", "ac_far"]);
    expect(ran).toEqual([]);
  });

  test("a player on this node is changed directly", async () => {
    await run("ADMIN", ["ac_hero"]);
    expect(ran).toEqual([]);
  });
});

describe("the commands a player's node runs", () => {
  test("a respawn answers the admin by name", async () => {
    await remoteActions()["cells-respawn"](hero, { by: "ac_far" });
    expect(hero.location.position).toEqual({ x: 160, y: 320, direction: "down" });
    expect(answers).toEqual([["ac_far", "Respawned Ac_hero"]]);
    expect(emitted).toEqual([["onPlayerRespawn", { player: hero, mapName: "main", x: 160, y: 320 }]]);
  });

  test("a kill goes through the death flow, by a stand-in for the admin", async () => {
    await remoteActions()["cells-kill"](hero, { by: "ac_far" });
    expect(deaths).toEqual([[hero, { id: "ac_far", username: "ac_far", remote: true }, { damage: 0, isCrit: false }]]);
    expect(answers).toEqual([["ac_far", "Killed Ac_hero"]]);
  });

  test("a kill is refused for an admin and for the dead", async () => {
    const actions = remoteActions();
    await actions["cells-kill"](mod, { by: "ac_far" });
    await actions["cells-kill"]({ ...hero, isDead: true }, { by: "ac_far" });
    expect(deaths).toEqual([]);
    expect(answers).toEqual([["ac_far", "You cannot kill other admins"], ["ac_far", "Ac_hero is already dead"]]);
  });

  test("cooldowns are reset, and the player's client told", async () => {
    await remoteActions()["cells-cooldowns"](hero, { by: "ac_far" });
    expect(answers).toEqual([["ac_far", "Reset the cooldowns of Ac_hero"]]);
    expect(sent.some((entry) => entry.to === hero.wt && entry.packets[0].type === "COOLDOWNS_RESET")).toBe(true);
  });

  test("a gift reaches the bags and the live copy", async () => {
    hero.inventory = [{ name: "Iron Ore", quantity: 1 }];
    await remoteActions()["cells-give"](hero, { by: "ac_far", item: "Iron Ore", quantity: 2 });
    expect(added).toEqual([["ac_hero", { name: "Iron Ore", quantity: 2 }]]);
    expect(hero.inventory).toEqual([{ name: "Iron Ore", quantity: 3 }]);
    expect(answers).toEqual([["ac_far", "Gave 2x Iron Ore to ac_hero"]]);
  });

  test("a gift of an item this node does not know, or of no number, is dropped", async () => {
    const actions = remoteActions();
    await actions["cells-give"](hero, { by: "ac_far", item: "Nothing", quantity: 2 });
    await actions["cells-give"](hero, { by: "ac_far", item: "Iron Ore", quantity: "2" });
    expect(added).toEqual([]);
  });

  test("a command with no admin is dropped, and nothing runs", async () => {
    const actions = remoteActions();
    for (const name of ["cells-respawn", "cells-kill", "cells-cooldowns", "cells-give"]) await actions[name](hero, {});
    expect(answers).toEqual([]);
    expect(deaths).toEqual([]);
    expect(hero.location.position).toEqual({ x: 10, y: 20, direction: "down" });
  });

  test("a player who is changing node is left alone, and the admin told to try again", async () => {
    const actions = remoteActions();
    hero.handoff = true;
    for (const name of ["cells-respawn", "cells-kill", "cells-cooldowns", "cells-give"]) await actions[name](hero, { by: "ac_far", item: "Iron Ore", quantity: 1 });
    expect(answers).toEqual(Array(4).fill(["ac_far", "ac_hero is busy"]));
    expect(deaths).toEqual([]);
    expect(added).toEqual([]);
  });

  test("a player held in a scene is not respawned or killed", async () => {
    const actions = remoteActions({ isHeld: () => true });
    await actions["cells-respawn"](hero, { by: "ac_far" });
    await actions["cells-kill"](hero, { by: "ac_far" });
    expect(answers).toEqual([["ac_far", "held in a scene"], ["ac_far", "held in a scene"]]);
    expect(deaths).toEqual([]);
    expect(hero.location.position).toEqual({ x: 10, y: 20, direction: "down" });
  });

  test("a role change reaches the live copy, and the client reconnects", async () => {
    mod.permissions = ["admin.kick"];
    await remoteActions()["cells-role"](mod, { admin: false });
    expect(mod).toMatchObject({ isAdmin: false, permissions: [] });
    expect(sent.some((entry) => entry.to === mod.wt && entry.packets[0].type === "RECONNECT")).toBe(true);
  });

  test("a role change that brings no role is dropped", async () => {
    await remoteActions()["cells-role"](mod, { admin: "no" });
    expect(mod.isAdmin).toBe(true);
  });

  test("permissions are read from the table, as the admin's node left it", async () => {
    held.ac_hero = "admin.kick";
    await remoteActions()["cells-permissions"](hero);
    expect(hero.permissions).toEqual(["admin.kick"]);
  });

  test("a change for a player who is changing node follows them, as the database already holds it", async () => {
    const actions = remoteActions();
    hero.handoff = true;
    await actions["cells-role"](hero, { admin: true });
    await actions["cells-permissions"](hero);
    expect(hero.isAdmin).toBe(false);
    expect(timeouts.map((timer) => timer.ms)).toEqual([1000, 1000]);

    for (const timer of timeouts) timer.run();
    await Bun.sleep(0);
    expect(ran).toEqual([["ac_hero", "cells-role", { admin: true }], ["ac_hero", "cells-permissions", undefined]]);
  });
});
