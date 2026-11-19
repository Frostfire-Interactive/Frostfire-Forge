import { beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { sqlWrapper } from "../controllers/sqlescape";
import { databaseModule, standInFor } from "./setup";

// Friends, mail, bans, reports and noclip with many characters per account (Task 7), on an in-memory SQLite database
// made by the engine's own SQLite setup. Every statement is turned into SQLite as the database worker turns it
// (sqlWrapper), so what is checked is what the tables hold.
//
// Two accounts: acct_bob plays Bob and Robert, acct_amy plays Amy. Cid is a third account's character.

let db = new Database(":memory:");

function run(sql: string, params: any[] = []): any {
  const text = sqlWrapper(sql, params, "sqlite" as any);
  if (/^\s*(SELECT|PRAGMA|WITH)/i.test(text)) return db.query(text).all();
  if (params.length === 0 && text.includes(";")) {
    db.exec(text);
    return { affectedRows: 0 };
  }
  const result = db.query(text).run();
  return { affectedRows: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
}

await standInFor("../controllers/sqldatabase", () => databaseModule({ default: async (sql: string, params: any[] = []) => run(sql, params) }));
// What is put in the asset cache is held: the game's modules fill it as they load (the social packets test loads them).
const assets = new Map<string, unknown>();
await standInFor("../services/assetCache", () => ({
  default: {
    get: async (key: string) => (assets.has(key) ? assets.get(key) : key === "items" ? [] : null),
    set: async (key: string, value: unknown) => void assets.set(key, value),
    add: async (key: string, value: unknown) => void assets.set(key, value),
    onChange: () => () => {},
  },
}));

const { setupDatabase } = await import("../utility/database_setup_sqlite");
const { clearCaches } = await import("../services/datacache");
const { default: friends } = await import("../systems/friends");
const { default: ignores } = await import("../systems/ignores");
const { default: mail } = await import("../systems/mail");
const { default: player } = await import("../systems/player");
const { default: reports } = await import("../systems/reports");
const { default: guilds } = await import("../systems/guild");
const { default: parties } = await import("../systems/parties");
const { default: currency } = await import("../systems/currency");
const { default: permissions } = await import("../systems/permissions");
const { default: mutes } = await import("../systems/mutes");
const moderation = await import("../systems/moderation");
const editor = await import("../systems/playereditor");

let blank: Uint8Array;
beforeAll(async () => {
  spyOn(console, "log").mockImplementation(() => {});
  await setupDatabase();
  blank = db.serialize();
}, 60000);

const one = (sql: string, ...params: any[]): any => db.query(sql).get(...params);
const all = (sql: string, ...params: any[]): any[] => db.query(sql).all(...params) as any[];

const ids: Record<string, number> = {};
const accounts: Record<string, number> = {};

function account(username: string): number {
  db.query("INSERT INTO accounts (email, username, password_hash, map, position) VALUES (?, ?, 'x', 'overworld', '0,0')").run(`${username}@example.com`, username);
  return (accounts[username] = Number(one("SELECT id FROM accounts WHERE username = ?", username).id));
}

function character(accountId: number, name: string, deleted = false): number {
  db.query("INSERT INTO characters (account_id, name, name_key, class_id, created_at, deleted_at) VALUES (?, ?, ?, NULL, 1, ?)")
    .run(accountId, name, name.toLowerCase(), deleted ? 5 : null);
  const id = Number(one("SELECT id FROM characters WHERE name_key = ?", name.toLowerCase()).id);
  db.query("INSERT INTO stats (character_id, level) VALUES (?, ?)").run(id, 3);
  return (ids[name] = id);
}

beforeEach(async () => {
  db = Database.deserialize(blank);
  await clearCaches();
  const bob = account("acct_bob");
  character(bob, "Bob");
  character(bob, "Robert");
  character(account("acct_amy"), "Amy");
  character(account("acct_cid"), "Cid");
  character(account("acct_gone"), "Ghost", true);
});

describe("friends are kept per character", () => {
  test("adding a friend stores the friend's character name in the owner's character_id row", async () => {
    expect(await friends.add("amy", "bob")).toEqual(["Bob"]);
    const rows = all("SELECT username, character_id, friend_id, friends FROM friendslist");
    expect(rows).toEqual([{ username: null, character_id: ids.Amy, friend_id: null, friends: "Bob" }]);
    // Robert, of the same account, has no friends: the list is the character's.
    expect(await friends.list("robert")).toEqual([]);
  });

  test("a friends list shows each friend's current character name", async () => {
    db.query("INSERT INTO friendslist (character_id, friends) VALUES (?, ?)").run(ids.Amy, "bob,CID,ghost,nobody");
    // As characters.name has them; a deleted character and a name that is no character's are not shown.
    expect(await friends.list("Amy")).toEqual(["Bob", "Cid"]);
    expect(await friends.remove("amy", "BOB")).toEqual(["Cid"]);
    expect(one("SELECT friends FROM friendslist WHERE character_id = ?", ids.Amy).friends).toBe("Cid");
  });

  test("ignores are the character's, by the ignored character's id", async () => {
    expect(await ignores.add("amy", "bob")).toBe("added");
    expect(all("SELECT username, character_id, ignored, ignored_id FROM ignores")).toEqual([
      { username: null, character_id: ids.Amy, ignored: "bob", ignored_id: ids.Bob },
    ]);
    expect(await ignores.isIgnoring("amy", "bob")).toBe(true);
    expect(await ignores.isIgnoring("amy", "robert")).toBe(false);
    await clearCaches();
    expect(await ignores.list("amy")).toEqual(["bob"]);
    expect(await ignores.remove("amy", "Bob")).toBe(true);
    expect(all("SELECT * FROM ignores")).toEqual([]);
  });
});

describe("mail goes to a character", () => {
  test("mail to Bob reaches Bob's character, not another character of Bob's account", async () => {
    await currency.set("amy", { copper: 0, silver: 10, gold: 0 });
    const sent = await mail.send({ username: "amy" }, { to: "bob", subject: "Hello", body: "Hi Bob", items: [], coins: {} });
    expect(sent).toEqual({ ok: true, message: "Mail sent to Bob.", recipient: "bob" });
    expect(all("SELECT recipient, sender, character_id, recipient_id, sender_id FROM mail")).toEqual([
      { recipient: "bob", sender: "amy", character_id: ids.Bob, recipient_id: ids.Bob, sender_id: ids.Amy },
    ]);
    await clearCaches();
    expect((await mail.inbox("bob")).map((m) => [m.sender, m.subject])).toEqual([["Amy", "Hello"]]);
    expect(await mail.inbox("robert")).toEqual([]);
    // Deleting it is done by its owner's id.
    const [only] = await mail.inbox("bob");
    expect((await mail.remove("robert", only.id)).ok).toBe(false);
    expect((await mail.remove("bob", only.id)).ok).toBe(true);
    expect(all("SELECT * FROM mail")).toEqual([]);
  });

  test("mail to the account's username finds no character", async () => {
    await currency.set("amy", { copper: 0, silver: 10, gold: 0 });
    const sent = await mail.send({ username: "amy" }, { to: "acct_bob", subject: "Hello", body: "", items: [], coins: {} });
    expect(sent).toEqual({ ok: false, message: "There is no character named acct_bob." });
  });
});

describe("bans, mutes, roles and permissions are the account's", () => {
  test("/ban Bob bans Bob's account", async () => {
    // As the command does: the target found by name, then banned.
    const [found] = (await player.findPlayerInDatabase("bob")) as any[];
    expect(found.username).toBe("Bob");
    await player.isBanned("robert");
    await player.ban(found.username, null);
    expect(one("SELECT banned FROM accounts WHERE id = ?", accounts.acct_bob).banned).toBe(1);
    expect(one("SELECT banned FROM accounts WHERE id = ?", accounts.acct_amy).banned).toBe(0);
    // The account's other character is banned with it, also where its row was held.
    expect(await player.isBanned("robert")).toEqual([{ banned: 1 }]);
    await player.unban("robert");
    expect(one("SELECT banned FROM accounts WHERE id = ?", accounts.acct_bob).banned).toBe(0);
  });

  test("a mute of Bob is a mute of the account, kept by its username", async () => {
    const admin = { username: "amy", permissions: ["admin.*"] };
    expect(await moderation.muteCommand(admin, ["bob", "1h"])).toBe("Muted Bob for 1h");
    expect(all("SELECT username FROM mutes")).toEqual([{ username: "acct_bob" }]);
    expect(await mutes.isMuted("robert")).toBe(true);
    expect(await moderation.unmuteCommand(admin, ["robert"])).toBe("Unmuted Robert");
    expect(await mutes.isMuted("bob")).toBe(false);
  });

  test("permissions given to Bob are the account's", async () => {
    await permissions.add("bob", "admin.kick");
    expect(all("SELECT username, permissions FROM permissions")).toEqual([{ username: "acct_bob", permissions: "admin.kick" }]);
    await clearCaches();
    expect(await permissions.get("robert")).toBe("admin.kick");
    expect(await permissions.get("amy")).toBe("");
  });

  test("a report on Bob records Bob's account", async () => {
    const filed = await reports.file({ reporter: "amy", target: "bob", category: "spam", lines: [], reporterAt: null, targetAt: null });
    expect(filed.ok).toBe(true);
    expect(all("SELECT reporter, target, character_id, reporter_id, target_id, target_account_id FROM reports")).toEqual([
      { reporter: "amy", target: "bob", character_id: ids.Amy, reporter_id: ids.Amy, target_id: ids.Bob, target_account_id: accounts.acct_bob },
    ]);
  });

  test("noclip on one character is off on the account's other", async () => {
    expect(await player.toggleNoclip("bob")).toBe(true);
    expect(one("SELECT noclip FROM characters WHERE id = ?", ids.Bob).noclip).toBe(1);
    expect(one("SELECT noclip FROM characters WHERE id = ?", ids.Robert).noclip).toBe(0);
    expect(await player.isNoclip("robert")).toBe(false);
  });
});

describe("parties and guilds are the character's", () => {
  test("a party and a guild set party_id and guild_id on the character, by id", async () => {
    expect(await parties.create("amy", "bob")).toEqual(["amy", "bob"]);
    const party = one("SELECT id, leader, leader_id, character_id FROM parties");
    expect(party).toMatchObject({ leader: "amy", leader_id: ids.Amy, character_id: ids.Amy });
    expect(all("SELECT name, party_id FROM characters WHERE party_id IS NOT NULL ORDER BY name")).toEqual([
      { name: "Amy", party_id: party.id },
      { name: "Bob", party_id: party.id },
    ]);
    expect(await player.getPartyIdByUsername("bob")).toBe(party.id);
    expect(await player.getPartyIdByUsername("robert")).toBeNull();

    expect(await guilds.create("bob", "Night Owls")).toEqual(["bob"]);
    const guild = one("SELECT id, leader, leader_id FROM guilds");
    expect(guild).toMatchObject({ leader: "bob", leader_id: ids.Bob });
    expect(all("SELECT character_id, rank_index FROM guild_members")).toEqual([{ character_id: ids.Bob, rank_index: 0 }]);
    expect(await guilds.add("amy", guild.id)).toEqual(["Bob", "Amy"]);
    expect(one("SELECT guild_id FROM characters WHERE id = ?", ids.Amy).guild_id).toBe(guild.id);
    expect(one("SELECT guild_id FROM characters WHERE id = ?", ids.Robert).guild_id).toBeNull();
    await clearCaches();
    expect(await guilds.getGuildMembers(guild.id)).toEqual(["Bob", "Amy"]);
    expect(await guilds.isInGuild("robert")).toBe(false);
    expect((await guilds.remove("amy")) as string[]).toEqual(["Bob"]);
    expect(one("SELECT guild_id FROM characters WHERE id = ?", ids.Amy).guild_id).toBeNull();
  });
});

describe("the player editor opens a character", () => {
  test("its account section lists the account's characters", async () => {
    const target = await editor.resolveTarget("robert");
    expect(target).toEqual({ username: "robert", userid: accounts.acct_bob });
    const snapshot = (await editor.buildSnapshot("robert")) as any;
    expect(snapshot.username).toBe("Robert");
    expect(snapshot.userid).toBe(accounts.acct_bob);
    expect(snapshot.account.characters).toEqual([
      { name: "Bob", classId: null, level: 3 },
      { name: "Robert", classId: null, level: 3 },
    ]);
    const found = await editor.search({ kind: "players", query: "ob" });
    expect(found.kind === "players" && found.players.map((p) => p.username)).toEqual(["bob", "robert"]);
  });
});

describe("what other players are shown", () => {
  test("no packet to another player contains accountUsername", async () => {
    await currency.set("amy", { copper: 0, silver: 10, gold: 0 });
    await currency.set("bob", { copper: 0, silver: 10, gold: 0 });
    // What the social handlers put in packets for Amy, who is not of Bob's account.
    const shown: unknown[] = [];
    shown.push(await friends.add("amy", "bob"), await friends.list("amy"));
    shown.push(await player.findByUsername("bob"), await player.findPlayerInDatabase("robert"));
    shown.push(await moderation.ignore({ username: "amy", permissions: [] }, "robert"));
    shown.push(await ignores.list("amy"));
    await mail.send({ username: "bob" }, { to: "amy", subject: "Hi", body: "", items: [], coins: {} });
    shown.push(await mail.inbox("amy"));
    shown.push(await parties.create("bob", "cid"), await parties.getAllParties());
    await guilds.create("bob", "Night Owls");
    const guildId = (await guilds.getGuildId("bob")) as number;
    await guilds.add("cid", guildId);
    shown.push(await guilds.packetsFor(guildId, ["cid"]).then((m) => [...m.values()]), await guilds.list());
    shown.push(await moderation.report({ username: "amy", permissions: [] }, "bob", "spam", null));
    const text = JSON.stringify(shown);
    expect(text).toContain("Bob");
    expect(text).not.toContain("acct_");
  });
});

describe("fix round 1", () => {
  // Zed's account has the username "zed", and its one character, Zed, was deleted: the name is now only the account's.
  function deletedZed(): void {
    character(account("zed"), "Zed", true);
  }
  function mailFrom(sender: string, to: string, at: number): number {
    db.query(
      "INSERT INTO mail (recipient, sender, subject, body, items, copper, silver, gold, sent_at, expires_at, is_read, returned, character_id, recipient_id, sender_id) VALUES (?, ?, 'Old', '', '[]', 5, 0, 0, 1, ?, 0, 0, ?, ?, NULL)"
    ).run(to, sender, at, ids[to.charAt(0).toUpperCase() + to.slice(1)], ids[to.charAt(0).toUpperCase() + to.slice(1)]);
    return Number(one("SELECT MAX(id) AS id FROM mail").id);
  }

  test("old mail from a deleted character named as its account is deleted, not sent back to the account", async () => {
    deletedZed();
    mailFrom("zed", "amy", 10);
    await mail.expire("amy", 100);
    expect(all("SELECT id FROM mail")).toEqual([]);
  });

  test("mail from a deleted character named as its account cannot be sent back", async () => {
    deletedZed();
    const id = mailFrom("zed", "amy", Date.now() + 1e9);
    expect(await mail.returnToSender("amy", id)).toEqual({ ok: false, message: "Zed no longer exists." });
    expect(all("SELECT recipient FROM mail")).toEqual([{ recipient: "amy" }]);
  });

  test("demoting one character takes the role from every cached character of the account", async () => {
    db.query("UPDATE accounts SET role = 1 WHERE id = ?").run(accounts.acct_bob);
    expect((await player.getAccount("bob"))?.role).toBe(1);
    expect((await player.getAccount("robert"))?.role).toBe(1);
    await player.toggleAdmin("bob");
    expect(one("SELECT role FROM accounts WHERE id = ?", accounts.acct_bob).role).toBe(0);
    expect((await player.getAccount("robert"))?.role).toBe(0);
  });

  test("the mail table made at start has the character keys the setup gives it", async () => {
    const { MAIL_TABLE } = await import("../systems/mail");
    const fresh = new Database(":memory:");
    fresh.exec("CREATE TABLE characters (id INTEGER PRIMARY KEY)");
    fresh.exec(MAIL_TABLE.sqlite);
    const columns = (fresh.query("PRAGMA table_info(mail)").all() as any[]).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["character_id", "sender_id", "recipient_id"]));
    // And the same columns as the setup's table, once its character keys are added.
    const setup = (db.query("PRAGMA table_info(mail)").all() as any[]).map((c) => c.name).sort();
    expect(columns.sort()).toEqual(setup);
  });

  test("an account with no character is no account name for a name that matches none", async () => {
    const { accountNameOf } = await import("../systems/characterids");
    account("lonely");
    expect(await accountNameOf("lonely")).toBeNull();
    expect(await accountNameOf("acct_bob")).toBeNull();
    expect(await accountNameOf("robert")).toBe("acct_bob");
    expect(await mutes.unmute("acct_bob")).toBe(false);
    expect(await permissions.get("acct_bob")).toBe("");
  });
});

// socket/server.ts starts the server when imported, and the receiver (which the handlers import) imports it: the
// handlers are run from their source, as cluster-playerhits-receiver.test.ts runs the receiver's, with the systems
// they use given in (the real ones, on the SQLite database above) and the receiver's sending helpers taken from its
// source too. What reaches each player's connection is what is checked.
describe("the social packets", () => {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const sourceOf = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  /** The text from `from` to the brace that closes the first block opened after it. */
  function block(source: string, from: string): string {
    const start = source.indexOf(from);
    if (start < 0) throw new Error(`Not found in the source: ${from}`);
    let depth = 0;
    // The block opens at the first brace that ends a line: a type in the signature has its braces inside one.
    for (let at = source.indexOf("{\n", start); at < source.length; at++) {
      if (source[at] === "{") depth++;
      else if (source[at] === "}" && --depth === 0) return source.slice(start, at + 1);
    }
    throw new Error(`Unclosed: ${from}`);
  }
  /** `code` compiled with every free name read from `given`; a name not given is a function that does nothing. */
  function compile(code: string, returned: string, given: Record<string, any>, names: string[]): any {
    const deps = new Proxy(given, { get: (target, key: string) => (key in target ? target[key] : async () => undefined) });
    const body = transpiler.transformSync(`export function make({ ${names.join(", ")} }: any) { ${code}\nreturn ${returned}; }`);
    return new Function(`"use strict";\n${body.replace(/^export /m, "")}\nreturn make;`)()(deps);
  }
  /** Every name a module imports (not its types). */
  const importedNames = (source: string): string[] => {
    const names = new Set<string>();
    for (const [, clause] of source.matchAll(/^import (?!type )([^"']+?) from ["'][^"']+["'];?$/gm)) {
      for (const part of clause.replace(/[{}]/g, ",").split(",")) {
        if (part.trim().startsWith("type ")) continue;
        const name = part.replace(/^\s*\* as\s+/, "").split(/\s+as\s+/).pop()!.trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
      }
    }
    return [...names];
  };

  test("no packet to another player names an account or the account's other characters", async () => {
    const { default: playerCache } = await import("../services/playermanager");
    const { packetManager } = await import("../socket/packet_manager");
    const deliver = await import("../cluster/deliver");
    const { invitations } = await import("../cluster/invitations");
    const contacts = await import("../socket/contacts");
    const { registerWhisperReach, whisperReach } = await import("../socket/stealthoffline");
    // The command handler registers it as it loads; it is not loaded here (it may be, by another test file).
    try { registerWhisperReach(deliver.delivery); } catch { /* registered already */ }
    const { audience } = await import("../systems/chatgate");
    const { default: trades, cannotTrade } = await import("../systems/trades");
    const { randomBytes } = await import("../modules/hash");
    const { Events } = await import("../systems/events");
    const { GuildPermission, refusalText } = await import("../systems/guildranks");
    const { listener } = await import("../modules/event_bus");
    const { default: log } = await import("../modules/logger");

    const receiver = sourceOf("../socket/receiver.ts");
    const sendPacket = (wt: any, packets: any[]) => packets.forEach((packet) => wt.send(packet));
    const shownName = (username: string) => username.charAt(0).toUpperCase() + username.slice(1);
    const entityById = (id: string) => playerCache.get(String(id));
    const base: Record<string, any> = {
      playerCache, packetManager, invitations, ignores, friends, guilds, parties, player, trades, moderation, log, Events,
      GuildPermission, refusalText, listener, randomBytes, entityById, sendPacket, shownName,
      deliverToPlayer: deliver.deliverToPlayer, runOnPlayer: deliver.runOnPlayer, isOnline: deliver.isOnline, delivery: deliver.delivery,
      greetContacts: contacts.greetContacts, sendFriends: contacts.sendFriends, clusterEnabled: () => false,
      subscriptionLocked: () => false, channelLineOk: () => true, chatLinksOf: async (message: string) => ({ message, links: [] }),
      chatAudience: audience, whisperReach, tradeRefusal: (asker: any, asked: any) => cannotTrade(asker, asked),
    };
    // The receiver's invitation senders and trade request, as written.
    const receiverCode = [
      block(receiver, "async function sendInvitation("),
      block(receiver, "export async function offerInvitation("),
      block(receiver, "export async function requestTrade("),
    ].join("\n").replace(/^export /gm, "");
    const fromReceiver = compile(receiverCode, "{ offerInvitation, sendInvitation, requestTrade }", base, Object.keys(base));
    Object.assign(base, fromReceiver);

    // The social handler, whole.
    const socialSource = sourceOf("../socket/handlers/social.ts");
    const socialNames = [...new Set([...importedNames(socialSource), ...Object.keys(base)])];
    const socialCode = socialSource.replace(/^import [^;]*;$/gm, "").replace(/^export /gm, "");
    const social = compile(socialCode, "handle", base, socialNames);
    // The whisper, from the command handler.
    const whisper = block(sourceOf("../socket/handlers/commands.ts"), 'case "WHISPER": {');
    const whisperNames = [...new Set([...Object.keys(base), "wt", "currentPlayer", "args"])];
    const whisperOf = (wt: any, currentPlayer: any, args: string[]) =>
      compile(`const run = async () => { switch ("WHISPER") { ${whisper} } };`, "run()", { ...base, wt, currentPlayer, args }, whisperNames);

    const decoder = new TextDecoder();
    const sent: Record<string, string[]> = {};
    const online = (id: string, username: string) => {
      sent[username] = [];
      const wt = { readyState: 1, data: { id }, send: (p: Uint8Array) => { sent[username].push(decoder.decode(p)); return true; }, sendBestEffort: () => {} };
      const p: any = {
        id, username, wt, isGuest: false, isAdmin: false, isStealth: false, invitations: [], friends: [], guild_id: null,
        location: { map: "overworld", position: { x: 0, y: 0, direction: "down" } }, stats: { level: 3 },
      };
      playerCache.add(id, p);
      return p;
    };
    const amy = online("pkt-amy", "Amy");
    const bob = online("pkt-bob", "Bob");
    const drive = (from: any, type: string, data: any) =>
      social({ server: null, wt: from.wt, message: "", parsedMessage: { type, data }, data, type, currentPlayer: from });
    try {
      await drive(amy, "ADD_FRIEND", { id: bob.id });
      await contacts.sendFriends("amy", await friends.add("amy", "bob"));
      await contacts.greetContacts(amy, ["bob"]);
      await whisperOf(amy.wt, amy, ["bob", "hello"]);
      await drive(amy, "INVITE_PARTY", { id: bob.id });
      await fromReceiver.requestTrade(amy.wt, amy, bob.id);
    } finally {
      playerCache.remove(amy.id);
      playerCache.remove(bob.id);
      trades.reset();
    }
    const toBob = sent.Bob.join("\n");
    const toAmy = sent.Amy.join("\n");
    // Each one reached Bob: the friend, party and trade invitations, the whisper and Amy coming online.
    expect(sent.Bob.filter((p) => p.includes('"type":"INVITATION"')).length).toBe(3);
    expect(toBob).toContain('"type":"WHISPER"');
    expect(toBob).toContain("Amy");
    expect(toAmy).toContain("Bob");
    for (const text of [toBob, toAmy]) {
      expect(text).not.toContain("acct_");
      expect(text.toLowerCase()).not.toContain("robert");
    }
  });
});
