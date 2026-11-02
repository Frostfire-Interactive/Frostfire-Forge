import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PlayerDirectory } from "../cluster/directory";
import { MemoryStore } from "../cluster/memorystore";
import playerCache from "../services/playermanager";
import { contactsLost, contactsOf, greetContacts, greetFrom, sendFriends, tellContactsOffline } from "../socket/contacts";

const cluster = await import("../cluster/index");

const decoder = new TextDecoder();

function online(username: string, extra: Record<string, any> = {}) {
  const box: any[] = [];
  const id = `contacts-${username}`;
  const player = { id, username, wt: { readyState: 1, send: (p: Uint8Array) => box.push(JSON.parse(decoder.decode(p))) }, ...extra };
  playerCache.add(id, player);
  return { player, box, statuses: () => box.filter((p) => p.type === "UPDATE_ONLINE_STATUS").map((p) => p.data) };
}

beforeEach(() => { playerCache.clear(); });

describe("who a player's contacts are", () => {
  test("friends, party and guild, in lower case, each once, never the player", () => {
    expect(contactsOf({ username: "Ann", friends: ["Bob", "cid"], party: ["ANN", "bob"], guild: ["Dee"] }).sort()).toEqual(["bob", "cid", "dee"]);
  });

  test("a list that is not there counts for nothing", () => {
    expect(contactsOf({ username: "Ann", friends: ["Bob"], party: null })).toEqual(["bob"]);
    expect(contactsOf({ username: "Ann" })).toEqual([]);
  });
});

describe("a greeting", () => {
  test("each side learns the other is online", async () => {
    const ann = online("Ann", { friends: ["Bob"] });
    const bob = online("Bob", { friends: ["Ann"] });
    await greetContacts(ann.player);
    expect(bob.statuses()).toEqual([{ online: true, username: "Ann" }]);
    expect(ann.statuses()).toEqual([{ online: true, username: "Bob" }]);
  });

  test("a contact who is not online is reported offline", async () => {
    const ann = online("Ann", { friends: ["Bob"], party: ["Cid"] });
    await greetContacts(ann.player);
    expect(ann.statuses().sort((a, b) => a.username.localeCompare(b.username))).toEqual([
      { online: false, username: "bob" },
      { online: false, username: "cid" },
    ]);
  });

  test("a stealthed player looks offline, and sees a stealthed contact as offline", async () => {
    const ann = online("Ann", { friends: ["Bob"], isStealth: true });
    const bob = online("Bob", { friends: ["Ann"] });
    await greetContacts(ann.player);
    expect(bob.statuses()).toEqual([{ online: false, username: "Ann" }]);

    ann.box.length = 0;
    bob.box.length = 0;
    await greetContacts(bob.player);
    expect(bob.statuses()).toEqual([{ online: false, username: "Ann" }]);
    expect(ann.statuses()).toEqual([{ online: true, username: "Bob" }]);
  });

  test("names can narrow it to new contacts, and never reach the player", async () => {
    const ann = online("Ann", { friends: ["Bob", "Cid"] });
    const bob = online("Bob");
    const cid = online("Cid");
    await greetContacts(ann.player, ["cid", "ANN"]);
    expect(bob.statuses()).toEqual([]);
    expect(cid.statuses()).toEqual([{ online: true, username: "Ann" }]);
    expect(ann.statuses()).toEqual([{ online: true, username: "Cid" }]);
  });

  test("greetFrom runs it where the player is, and says if they are online at all", async () => {
    const ann = online("Ann");
    const bob = online("Bob");
    expect(await greetFrom("Ann", ["bob"])).toBe(true);
    expect(bob.statuses()).toEqual([{ online: true, username: "Ann" }]);
    expect(await greetFrom("nobody", ["bob"])).toBe(false);
    expect(ann.statuses()).toEqual([{ online: true, username: "Bob" }]);
  });
});

test("leaving tells every contact who is online", async () => {
  const ann = online("Ann", { friends: ["Bob", "Gone"], guild: ["Cid"] });
  const bob = online("Bob");
  const cid = online("Cid");
  await tellContactsOffline(ann.player);
  expect(bob.statuses()).toEqual([{ online: false, username: "Ann" }]);
  expect(cid.statuses()).toEqual([{ online: false, username: "Ann" }]);
});

test("a friends list goes to the player and stays with them", async () => {
  const ann = online("Ann", { friends: [] });
  expect(await sendFriends("Ann", ["bob"])).toBe(true);
  expect(ann.box).toEqual([{ type: "UPDATE_FRIENDS", data: { friends: ["bob"] } }]);
  expect(playerCache.getByUsername("Ann").friends).toEqual(["bob"]);
  expect(await sendFriends("nobody", ["bob"])).toBe(false);
});

describe("a node that dies", () => {
  let directory: PlayerDirectory;
  let peer: PlayerDirectory;
  let spy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    const store = new MemoryStore();
    directory = new PlayerDirectory(store, "a");
    peer = new PlayerDirectory(store, "b");
    spy = spyOn(cluster, "clusterDirectory").mockReturnValue(directory as any);
  });
  afterEach(() => { spy.mockRestore(); });

  test("a contact whose entry is gone, or still the dead node's, is offline", async () => {
    const ann = online("Ann", { friends: ["Swept", "Stale"] });
    await peer.claim("Stale", "9", "main");
    await contactsLost("b", false);
    expect(ann.statuses().map((status) => status.username).sort()).toEqual(["stale", "swept"]);
    expect(ann.statuses().every((status) => !status.online)).toBe(true);
  });

  test("a contact on a third node, or on this one, stays online", async () => {
    const ann = online("Ann", { friends: ["Far", "Bob"] });
    online("Bob");
    await new PlayerDirectory(new MemoryStore(), "c").claim("Other", "9", "main");
    await directory.claim("Far", "9", "main");
    await contactsLost("b", false);
    expect(ann.statuses()).toEqual([]);
  });

  test("after a restart the entry is the new run's: only a contact with none is offline", async () => {
    const ann = online("Ann", { friends: ["Back", "Swept"] });
    await peer.claim("Back", "9", "main");
    await contactsLost("b", true);
    expect(ann.statuses()).toEqual([{ online: false, username: "swept" }]);
  });
});

test("with no cluster, a lost node changes nothing", async () => {
  const ann = online("Ann", { friends: ["Bob"] });
  await contactsLost("b", false);
  expect(ann.statuses()).toEqual([]);
});
