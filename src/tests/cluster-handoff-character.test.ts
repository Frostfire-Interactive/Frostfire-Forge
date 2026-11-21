import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { databaseModule, standInFor } from "./setup";

let db = new Database(":memory:");
const run = (sql: string, params: any[] = []) => {
  if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return db.query(sql).all(...params);
  if (params.length === 0) {
    db.exec(sql);
    return { affectedRows: 1 };
  }
  const changes = db.query(sql).run(...params).changes;
  return { affectedRows: changes, count: changes };
};
await standInFor("../controllers/sqldatabase", () => databaseModule({ default: async (sql: string, params: any[] = []) => run(sql, params) }));

const { setupDatabase } = await import("../utility/database_setup_sqlite");
const { default: authentication } = await import("../socket/authentication");
const { PlayerHandoff, holdPlayerLock } = await import("../cluster/handoff");
const { LinkCalls } = await import("../cluster/linkcalls");
const { linkPair, settle } = await import("./cluster-fakelink");
const { LoginPrefetch, PREFETCH_PREFIX } = await import("../socket/loginprefetch");
const { MemoryStore } = await import("../cluster/memorystore");
const { PlayerLocks, characterLockKeys } = await import("../cluster/playerlock");
const { PlayerDirectory } = await import("../cluster/directory");
const { trackPresence } = await import("../cluster/presence");
const { adoptOwnerEpoch, claimOwnerEpoch, fencedSaves, storedOwnerEpoch } = await import("../cluster/ownerepoch");
const { default: log } = await import("../modules/logger");
const { default: player } = await import("../systems/player");
const { default: playerCache } = await import("../services/playermanager");
const { queueSpawnPlayerPacket } = await import("../socket/aoi");
const { packetManager } = await import("../socket/packet_manager");
const { playerGhostRecord } = await import("../cluster/kinds/players");

let blank: Uint8Array;
const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  spyOn(console, "log").mockImplementation(() => {});
  await setupDatabase();
  const columns = (db.query("PRAGMA table_info(accounts)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!columns.includes("email_verified")) db.exec("ALTER TABLE accounts ADD COLUMN email_verified INTEGER DEFAULT 1");
  if (!columns.includes("twofa_pending")) db.exec("ALTER TABLE accounts ADD COLUMN twofa_pending INTEGER DEFAULT 0");
  blank = db.serialize();
});

const one = (sql: string, ...params: any[]): any => db.query(sql).get(...params);
const fresh = () => { db = Database.deserialize(blank); };

function account(username: string): number {
  db.query("INSERT INTO accounts (email, username, password_hash, token, token_expires, email_verified, twofa_pending, map, position) VALUES (?, ?, 'x', ?, ?, 1, 0, 'overworld', '0,0')")
    .run(`${username}@example.com`, username, `t-${username}`, Date.now() + HOUR);
  return Number(one("SELECT id FROM accounts WHERE username = ?", username).id);
}

function character(accountId: number, name: string, map = "overworld"): number {
  db.query("INSERT INTO characters (account_id, name, name_key, class_id, map, position, direction, created_at, deleted_at) VALUES (?, ?, ?, NULL, ?, '5,6', 'left', 1, NULL)")
    .run(accountId, name, name.toLowerCase(), map);
  return Number(one("SELECT id FROM characters WHERE name_key = ?", name.toLowerCase()).id);
}

const activate = (accountId: number, characterId: number) => db.query("UPDATE accounts SET active_character_id = ? WHERE id = ?").run(characterId, accountId);

/** Two handoff nodes over a fake link: `a` gives its players to `b`. */
function pair(saved: Array<{ token: string; who: any }>) {
  const { a: la, b: lb } = linkPair();
  const make = (name: string, link: any) => {
    const calls = new LinkCalls(1_000);
    calls.attach(link);
    const players = new Map<string, any>();
    const handoff = new PlayerHandoff();
    handoff.start({
      calls,
      ghosts: { handOver: () => {}, adoptMirror: () => true },
      self: name,
      ownerAt: () => "b",
      now: () => 1_000_000,
      player: (id) => players.get(id) ?? null,
      playerByUsername: (username) => [...players.values()].find((p) => p.username === username) ?? null,
      drain: async () => {},
      // The identity is the one server.ts sends (handoff.ts snapshotIdentity).
      snapshot: (p) => ({ ...snapshotIdentityOf(p), map: "main", x: 1, y: 0, direction: "down", creatureIds: [], playerIds: [], state: {} }),
      ghostRecord: (p) => ({ id: String(p.id) }),
      ticket: (_p, target) => ({ token: `switch-${target}-${Math.random().toString(16).slice(2)}`, timestamp: 1, expiresAt: 2, signature: "s", origin: "o", account: "lillious", nodeId: target }),
      node: (target) => ({ nodeId: target, publicHost: "h", port: 1, wtPort: 2, useSSL: true }),
      release: (p) => { players.delete(String(p.id)); },
      save: async () => {},
      sendSwitch: async (p, _node, ticket) => { p.ticket = ticket; },
      forward: () => {},
      saved: (token, who) => { saved.push({ token, who }); },
    });
    return { handoff, calls, players };
  };
  const a = make("a", la);
  const b = make("b", lb);
  return { a, b, stop: () => { a.handoff.stop(); b.handoff.stop(); a.calls.detach(); b.calls.detach(); } };
}

const { snapshotIdentity: snapshotIdentityOf } = await import("../cluster/handoff");

describe("cluster handoff by character id", () => {
  test("handoff carries characterId and node B loads that character", async () => {
    fresh();
    const acc = account("lillious");
    const older = character(acc, "Older");
    const frosty = character(acc, "Frosty", "cave");
    activate(acc, frosty);
    db.query("INSERT INTO stats (username, character_id, health, max_health, level) VALUES ('frosty', ?, 33, 100, 7)").run(frosty);
    db.query("INSERT INTO stats (username, character_id, health, max_health, level) VALUES ('older', ?, 90, 100, 2)").run(older);

    const saved: Array<{ token: string; who: any }> = [];
    const { a, b, stop } = pair(saved);
    try {
      const p: any = { id: "7", username: "Frosty", characterId: frosty, accountId: acc, accountUsername: "lillious" };
      a.players.set("7", p);
      expect(await a.handoff.handOff(p, "b")).toBe("switched");
      await settle();
      const token = p.ticket.token;
      // Node B knows which character arrives before the client's AUTH, from the snapshot alone.
      expect(b.handoff.arrivingCharacter(token)).toEqual({ characterId: frosty, accountId: acc });
      // The prefetch is started with the character's ids, not its name.
      expect(saved).toEqual([{ token, who: { username: "Frosty", characterId: frosty, accountId: acc } }]);

      // The read ahead is posted to the pool by character id, and the worker loads that character's rows.
      const jobs: any[] = [];
      const prefetch = new LoginPrefetch((job) => jobs.push(job));
      prefetch.start(token, saved[0].who);
      expect(jobs).toEqual([{ token: PREFETCH_PREFIX + token, id: PREFETCH_PREFIX + token, prefetch: frosty, accountId: acc }]);
      const read = await authentication.prefetch(frosty, acc);
      expect((read.data as any).characterId).toBe(frosty);
      expect((read.data as any).stats.level).toBe(7);
      prefetch.answer({ ...read, prefetch: true, id: jobs[0].id });
      const taken = prefetch.take(token)!;
      expect(taken.characterId).toBe(frosty);
      expect(((await taken.data) as any).username).toBe("Frosty");
      // A read for the character of another account loads nothing.
      expect((await authentication.prefetch(frosty, acc + 99)).data).toBeNull();

      // The arrival is taken only for the character it carries.
      expect(b.handoff.takeArrival(token, "Frosty", "7", older)).toBeNull();
      const arrival = b.handoff.takeArrival(token, "Frosty", "7", frosty);
      expect(arrival?.snapshot.characterId).toBe(frosty);
      expect(arrival?.snapshot.accountId).toBe(acc);
    } finally {
      stop();
    }
  });

  test("node B ignores a changed active_character_id mid-session", async () => {
    fresh();
    const acc = account("lillious");
    const frosty = character(acc, "Frosty", "cave");
    const older = character(acc, "Older");
    activate(acc, frosty);
    // While Frosty walks across the border, the account's active character is changed (the Gateway's character page).
    activate(acc, older);
    // Node B's AUTH carries the character of the arrival: it plays Frosty, not the active one.
    const result = await authentication.process("t-lillious", "901", undefined, frosty);
    expect(result.error).toBeNull();
    expect((result.data as any).characterId).toBe(frosty);
    expect((result.data as any).username).toBe("Frosty");
    // The rows read ahead were Frosty's: the AUTH reads nothing again.
    expect(await authentication.process("t-lillious", "902", frosty, frosty)).toMatchObject({ prefetched: true, data: null, error: null });
    // A character of another account is never played under this account's token.
    const other = account("other");
    const theirs = character(other, "Theirs");
    expect(await authentication.process("t-lillious", "903", undefined, theirs)).toMatchObject({ characterRequired: true, data: null });
    // Without a handoff the login is the account's active character, as before.
    expect(((await authentication.process("t-lillious", "904")).data as any).characterId).toBe(older);

    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const session = read("../socket/handlers/session.ts");
    expect(session).toContain("const arriving = playerHandoff.arrivingCharacter(String(wt.data?.ticketToken ?? \"\"));");
    expect(session).toContain("authWorker.postMessage({ token, id: wt.data.id, known: prefetched?.characterId, characterId: arriving?.characterId });");
    const worker = read("../socket/authentication.ts");
    expect(worker).toContain("const result = await authentication.process(data.token, data.id, data.known, data.characterId);");
    expect(worker).toContain("? await authentication.prefetch(data.prefetch, Number(data.accountId))");
    const receiver = read("../socket/receiver.ts");
    expect(receiver).toContain("playerHandoff.takeArrival(String(wt.data?.ticketToken ?? \"\"), playerData.username, String(wt.data.id), playerData.characterId)");
    const server = read("../socket/server.ts");
    expect(server).toContain("...snapshotIdentity(p),");
    expect(server).toContain("saved: (token, who) => loginPrefetch.start(token, who),");
  });

  test("locks for two characters of one account do not block each other", async () => {
    const store = new MemoryStore();
    const locks = new PlayerLocks(store, "n1");
    const first = await holdPlayerLock(locks, 41);
    const second = await holdPlayerLock(locks, 42);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(await store.get("cells:plock:char:41")).not.toBeNull();
    // The same character is one writer at a time.
    expect(await holdPlayerLock(locks, 41)).toBeNull();
    await first!();
    await second!();
    // A batch names its players: it takes the same keys as the handoff, by the characters' ids.
    const ids = new Map([["frosty", 41], ["older", 42]]);
    expect(await characterLockKeys(["Older", "Frosty", "nobody"], async (name) => ids.get(name.toLowerCase()) ?? null))
      .toEqual(["char:42", "char:41", "name:nobody"]);
    const index = readFileSync(new URL("../cluster/index.ts", import.meta.url), "utf8");
    expect(index).toContain("locks.withLocks(await characterLockKeys(names, characterIdOf), work, { isLocal: localLockKey })");
    expect(index).toContain("playerHandoff.setLock((characterId) => holdPlayerLock(locks, characterId))");
  });

  test("the owner epoch and the save stamp are the account's, by id", async () => {
    fresh();
    const acc = account("lillious");
    character(acc, "Frosty");
    expect(await claimOwnerEpoch(acc, 4)).toBe(true);
    expect(await claimOwnerEpoch(acc, 3)).toBe(false);
    expect(await storedOwnerEpoch(acc)).toBe(4);
    db.query("UPDATE accounts SET saved_at = 77 WHERE id = ?").run(acc);
    expect(await player.saveStamp(acc)).toEqual({ ownerEpoch: 4, savedAt: 77 });
    expect(await storedOwnerEpoch(acc + 99)).toBeNull();
  });

  test("a login of the account on another node displaces its other character there", async () => {
    const store = new MemoryStore();
    const onA = new PlayerDirectory(store, "a");
    const onB = new PlayerDirectory(store, "b");
    // Older plays on node a.
    await onA.claim("older", "11", "main");
    const displaced: Array<{ node: string; id: string; name: string; accountId: unknown }> = [];
    const stop = trackPresence(onB, (previous, username, value) => { displaced.push({ node: previous.nodeId, id: previous.playerId, name: username, accountId: value?.accountId }); }, {
      siblings: async (value) => (value.accountId === 5 ? ["Older", "Frosty"] : []),
    });
    try {
      playerCache.add("12", { id: "12", username: "Frosty", characterId: 2, accountId: 5, location: { map: "main" } } as any);
      for (let i = 0; i < 20 && displaced.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
      expect(displaced).toEqual([{ node: "a", id: "11", name: "Older", accountId: 5 }]);
    } finally {
      playerCache.remove("12");
      stop();
    }
    // The node of the old session checks the account before it closes anyone (a freed name may be another's now).
    const receiver = readFileSync(new URL("../socket/receiver.ts", import.meta.url), "utf8");
    expect(receiver).toContain("if (args?.accountId !== undefined && Number(p.accountId) !== Number(args.accountId)) return;");
  });

  test("no client-bound packet from an arrival carries the account username", async () => {
    const saved: Array<{ token: string; who: any }> = [];
    const { a, b, stop } = pair(saved);
    try {
      const p: any = { id: "7", username: "Frosty", characterId: 41, accountId: 5, accountUsername: "secretacct" };
      a.players.set("7", p);
      expect(await a.handoff.handOff(p, "b")).toBe("switched");
      await settle();
      const arrival = b.handoff.takeArrival(p.ticket.token, "Frosty", "7", 41)!;
      // Between nodes the snapshot carries it (the links are trusted).
      expect(arrival.snapshot.accountUsername).toBe("secretacct");
      // Node B's player, as the login builds it from the arrival and the rows, with the account's name held.
      const arrived: any = {
        id: arrival.snapshot.id, userid: 5, username: arrival.snapshot.username, characterId: 41, accountId: 5, accountUsername: "secretacct",
        location: { map: `${arrival.snapshot.map}.json`, position: { x: arrival.snapshot.x, y: arrival.snapshot.y, direction: arrival.snapshot.direction } },
        stats: { health: 1 }, isAdmin: false,
      };
      const frames = [
        ...packetManager.spawnPlayer({ ...queueSpawnPlayerPacket(arrived), location: { map: "main", x: 1, y: 0, direction: "down" } }),
        ...packetManager.loadPlayers({ players: [queueSpawnPlayerPacket(arrived)], snapshotRevision: 1 }),
      ];
      const text = frames.map((frame) => new TextDecoder().decode(frame)).join("\n") + JSON.stringify(playerGhostRecord(arrived));
      expect(text).toContain("Frosty");
      expect(text).not.toContain("secretacct");
      expect(text).not.toContain("accountUsername");
    } finally {
      stop();
    }
  });
});

describe("the account's owner epoch fences its other character", () => {
  const here = { map: "overworld", position: { x: 1, y: 2, direction: "down" } } as any;
  const stats = { health: 9, max_health: 100, stamina: 5, max_stamina: 10 } as any;
  const noKick = () => { throw new Error("no kick"); };

  /** Character Older plays on node a under directory epoch 5, which the account's owner epoch holds. */
  async function olderOnA() {
    fresh();
    const acc = account("lillious");
    const older = character(acc, "Older");
    const frosty = character(acc, "Frosty");
    db.query("INSERT INTO stats (username, character_id, health, max_health) VALUES ('older', ?, 50, 100)").run(older);
    db.query("INSERT INTO stats (username, character_id, health, max_health) VALUES ('frosty', ?, 50, 100)").run(frosty);
    const store = new MemoryStore();
    const onA = new PlayerDirectory(store, "a");
    const onB = new PlayerDirectory(store, "b");
    await store.set("cells:direpoch:older", "4");
    const { entry } = await onA.claim("Older", "11", "overworld");
    expect(entry.epoch).toBe(5);
    const olderPlayer: any = { id: "11", username: "Older", characterId: older, accountId: acc };
    expect(await adoptOwnerEpoch(olderPlayer, entry.epoch, { directory: onA, kick: noKick })).toBe(5);
    expect(await player.saveFenced(olderPlayer, 5, stats, here)).toBe("saved");
    return { acc, older, frosty, store, onB, olderPlayer };
  }

  test("a sibling's claim of the same epoch number is lifted past it, never shared", async () => {
    const { acc, frosty, store, onB, olderPlayer } = await olderOnA();
    // Frosty's own counter reaches 5 too: the stored epoch equals the claim, but the claim is not Frosty's.
    await store.set("cells:direpoch:frosty", "4");
    const { entry } = await onB.claim("Frosty", "12", "overworld");
    expect(entry.epoch).toBe(5);
    const frostyPlayer: any = { id: "12", username: "Frosty", characterId: frosty, accountId: acc };
    const info = spyOn(log, "info").mockImplementation(() => {});
    try {
      const epoch = await adoptOwnerEpoch(frostyPlayer, entry.epoch, { directory: onB, kick: noKick });
      expect(epoch).toBeGreaterThan(5);
      expect(frostyPlayer.ownerEpoch).toBe(epoch);
      expect(await storedOwnerEpoch(acc)).toBe(epoch);
    } finally {
      info.mockRestore();
    }
    // Older's next save under its epoch changes nothing; Frosty's lands.
    expect(await player.saveFenced(olderPlayer, 5, stats, here)).toBe("fenced");
    expect(await player.saveFenced(frostyPlayer, frostyPlayer.ownerEpoch, stats, here)).toBe("saved");
  });

  test("a character switch lifts the account's epoch, said at info, with no kick, and fences the old character", async () => {
    const { acc, frosty, onB, olderPlayer } = await olderOnA();
    // Frosty's counter starts at 1, below the account's 5: the switch is refused at first and lifted.
    const { entry } = await onB.claim("Frosty", "12", "overworld");
    expect(entry.epoch).toBe(1);
    const frostyPlayer: any = { id: "12", username: "Frosty", characterId: frosty, accountId: acc };
    const info = spyOn(log, "info").mockImplementation(() => {});
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    const kicked: string[] = [];
    try {
      const epoch = await adoptOwnerEpoch(frostyPlayer, entry.epoch, { directory: onB, kick: (_p, why) => kicked.push(why) });
      expect(epoch).toBeGreaterThan(5);
      expect(kicked).toEqual([]);
      expect(info.mock.calls.some(([line]) => String(line).includes("Owner epoch of Frosty lifted from 1"))).toBe(true);
      expect(warn).not.toHaveBeenCalled();
      expect((await onB.get("frosty"))?.epoch).toBe(epoch!);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
    expect(await player.saveFenced(olderPlayer, 5, stats, here)).toBe("fenced");
  });

  test("a player with no account id is left unfenced, with an error said", async () => {
    fresh();
    const acc = account("lillious");
    character(acc, "Frosty");
    const store = new MemoryStore();
    const directory = new PlayerDirectory(store, "a");
    const { entry } = await directory.claim("Frosty", "12", "overworld");
    const frostyPlayer: any = { id: "12", username: "Frosty" };
    const error = spyOn(log, "error").mockImplementation(() => {});
    try {
      expect(await adoptOwnerEpoch(frostyPlayer, entry.epoch, { directory, kick: noKick })).toBeNull();
      expect(error.mock.calls.some(([line]) => String(line).includes("Owner epoch for Frosty not taken: the player carries no account id"))).toBe(true);
    } finally {
      error.mockRestore();
    }
    expect(frostyPlayer.ownerEpoch).toBeUndefined();
    expect(fencedSaves(frostyPlayer)).toBe(false);
    expect(await storedOwnerEpoch(acc)).toBe(0);
  });
});

describe("every login carries the account id its saves are fenced on", () => {
  test("a login by token, a handoff's pinned login and a read ahead all give the account id; the one cache add keeps it", async () => {
    fresh();
    const acc = account("lillious");
    const frosty = character(acc, "Frosty");
    const older = character(acc, "Older");
    activate(acc, older);
    // A login by token (the active character), a handoff's AUTH (pinned) and the read ahead (by id).
    const byToken = (await authentication.process("t-lillious", "701")).data as any;
    const pinned = (await authentication.process("t-lillious", "702", undefined, frosty)).data as any;
    const ahead = (await authentication.prefetch(frosty, acc)).data as any;
    for (const [rows, id] of [[byToken, older], [pinned, frosty], [ahead, frosty]] as const) {
      expect(rows.accountId).toBe(acc);
      expect(rows.characterId).toBe(id);
    }
    const receiver = readFileSync(new URL("../socket/receiver.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    // completeLogin is the one place a player enters the cache, for every kind of login, and it copies the account id.
    expect(receiver.match(/playerCache\.add\(/g)).toHaveLength(1);
    expect(receiver).toContain("playerCache.add(wt.data.id, {\n      username: playerData.username,\n      characterId: playerData.characterId,\n      accountId: playerData.accountId,");
    // A read ahead that failed is done again by the AUTH, still pinned to the character the handoff brings.
    expect(receiver).toContain("authWorker.postMessage({ token, id: sessionId, characterId: arriving?.characterId });");
  });
});
