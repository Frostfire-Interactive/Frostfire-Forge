import { beforeEach, expect, test } from "bun:test";
import { ClusterBus } from "../cluster/bus";
import { Delivery, hearDeliveries } from "../cluster/deliver";
import { PlayerDirectory } from "../cluster/directory";
import { MemoryStore } from "../cluster/memorystore";

// The bus signs its envelopes (security review H1): every bus of a test shares this key.
const TEST_BUS_KEY = "test-bus-key";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
// Published messages arrive on the next immediate; five turns covers a message that triggers another.
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

function fakeConnection() {
  const sent: string[] = [];
  return { sent, wt: { readyState: 1, send: (p: Uint8Array) => sent.push(decode(p)), sendBestEffort: (p: Uint8Array) => sent.push(`~${decode(p)}`) } };
}

function players(entries: Record<string, any>) {
  return {
    get: (key: string) => entries[key],
    getByUsername: (name: string) => Object.values(entries).find((p) => p.username.toLowerCase() === name.toLowerCase()),
    list: () => entries,
  };
}

let store: MemoryStore;
beforeEach(() => { store = new MemoryStore(); });

async function node(id: string, entries: Record<string, any>) {
  const bus = new ClusterBus(store, id, TEST_BUS_KEY);
  await bus.start();
  const directory = new PlayerDirectory(store, id);
  const delivery = new Delivery(players(entries));
  delivery.attach(bus, directory);
  for (const [key, p] of Object.entries(entries)) await directory.claim(p.username, key, "main");
  return delivery;
}

test("without a cluster, delivery is local only", async () => {
  const hero = fakeConnection();
  const delivery = new Delivery(players({ "1": { username: "Hero", ...hero } }));
  expect(await delivery.deliverToPlayer("hero", [encode("hi")])).toBe(true);
  expect(await delivery.deliverToPlayer("nobody", [encode("hi")])).toBe(false);
  expect(hero.sent).toEqual(["hi"]);
});

test("a player on another node gets the packets", async () => {
  const hero = fakeConnection();
  const a = await node("a", {});
  await node("b", { "7": { username: "Hero", ...hero } });
  expect(await a.deliverToPlayer("hero", [encode("one"), encode("two")], { bestEffort: true })).toBe(true);
  await settle();
  expect(hero.sent).toEqual(["~one", "~two"]);
});

test("a world broadcast reaches players on every node once", async () => {
  const x = fakeConnection();
  const y = fakeConnection();
  const a = await node("a", { "1": { username: "X", ...x } });
  await node("b", { "2": { username: "Y", ...y } });
  await a.broadcastWorld([encode("news")]);
  await settle();
  expect(x.sent).toEqual(["news"]);
  expect(y.sent).toEqual(["news"]);
});

test("a world broadcast that cannot be published still reaches this node's players", async () => {
  const x = fakeConnection();
  const a = await node("a", { "1": { username: "X", ...x } });
  store.publish = async () => { throw new Error("redis is down"); };
  await a.broadcastWorld([encode("news")]);
  await settle();
  expect(x.sent).toEqual(["news"]);
});

test("an action runs where the player is", async () => {
  const ran: string[] = [];
  const a = await node("a", {});
  const b = await node("b", { "7": { username: "Hero", ...fakeConnection() } });
  for (const each of [a, b]) each.registerAction("greet", (player, args) => { ran.push(`${player.username}:${args.word}`); });
  expect(await a.runOnPlayer("hero", "greet", { word: "hi" })).toBe(true);
  await settle();
  expect(ran).toEqual(["Hero:hi"]);
  expect(await a.runOnPlayer("nobody", "greet", {})).toBe(false);
});

test("isOnline looks across nodes", async () => {
  const a = await node("a", {});
  await node("b", { "7": { username: "Hero", ...fakeConnection() } });
  expect(await a.isOnline("hero")).toBe(true);
  expect(await a.isOnline("nobody")).toBe(false);
});

// A store whose reads and publishes can be made to fail, as Redis does when it goes away.
class FlakyStore extends MemoryStore {
  failing = false;
  override async get(key: string) {
    if (this.failing) throw new Error("redis down");
    return super.get(key);
  }
  override async publish(channel: string, message: string) {
    if (this.failing) throw new Error("redis down");
    return super.publish(channel, message);
  }
}

async function nodeOn(flaky: FlakyStore, id: string, entries: Record<string, any>) {
  const bus = new ClusterBus(flaky, id, TEST_BUS_KEY);
  await bus.start();
  const directory = new PlayerDirectory(flaky, id);
  const delivery = new Delivery(players(entries));
  delivery.attach(bus, directory);
  for (const [key, p] of Object.entries(entries)) await directory.claim(p.username, key, "main");
  return delivery;
}

test("a failing lookup never throws out of delivery", async () => {
  const flaky = new FlakyStore();
  const a = await nodeOn(flaky, "a", {});
  flaky.failing = true;
  expect(await a.deliverToPlayer("hero", [encode("hi")])).toBe(false);
  expect(await a.runOnPlayer("hero", "greet", {})).toBe(false);
  expect(await a.isOnline("hero")).toBe(false);
  await a.runOnPlayerAt("b", "7", "greet", {});
});

test("a player no node holds is told from one the cluster could not look for", async () => {
  const flaky = new FlakyStore();
  const a = await nodeOn(flaky, "a", {});
  await nodeOn(flaky, "b", { "7": { username: "Hero", ...fakeConnection() } });
  expect(await a.tryOnPlayer("hero", "greet", {})).toBe("sent");
  expect(await a.tryOnPlayer("nobody", "greet", {})).toBe("offline");
  expect(await a.whetherOnline("hero")).toBe(true);
  expect(await a.whetherOnline("nobody")).toBe(false);
  flaky.failing = true;
  expect(await a.tryOnPlayer("nobody", "greet", {})).toBe("unreached");
  expect(await a.whetherOnline("nobody")).toBeNull();
});

test("a failing publish is not taken for a player who is offline", async () => {
  const flaky = new FlakyStore();
  const a = await nodeOn(flaky, "a", {});
  await nodeOn(flaky, "b", { "7": { username: "Hero", ...fakeConnection() } });
  flaky.get = MemoryStore.prototype.get;
  flaky.failing = true;
  expect(await a.tryOnPlayer("hero", "greet", {})).toBe("unreached");
});

test("a failing publish never throws out of delivery", async () => {
  const flaky = new FlakyStore();
  const a = await nodeOn(flaky, "a", {});
  await nodeOn(flaky, "b", { "7": { username: "Hero", ...fakeConnection() } });
  // The lookup works; only the publish fails.
  flaky.get = MemoryStore.prototype.get;
  flaky.failing = true;
  expect(await a.deliverToPlayer("hero", [encode("hi")])).toBe(false);
  expect(await a.runOnPlayer("hero", "greet", {})).toBe(false);
  await a.runOnPlayerAt("b", "7", "greet", {});
  await a.broadcastWorld([encode("news")]);
});

test("a local player is still reached while the cluster is failing", async () => {
  const flaky = new FlakyStore();
  const hero = fakeConnection();
  const a = await nodeOn(flaky, "a", { "1": { username: "Hero", ...hero } });
  flaky.failing = true;
  expect(await a.deliverToPlayer("hero", [encode("hi")])).toBe(true);
  expect(await a.isOnline("hero")).toBe(true);
  expect(hero.sent).toEqual(["hi"]);
});

test("an asked action gives back what it gave, from the player's node", async () => {
  const a = await node("a", {});
  const b = await node("b", { "7": { username: "Hero", ...fakeConnection() } });
  b.registerAction("read", (player, args) => `${player.username}:${args.word}`);
  expect(await a.askPlayer("hero", "read", { word: "hi" }, 1_000)).toEqual({ status: "answered", value: "Hero:hi" });
});

test("an action asked of a player on this node runs here", async () => {
  const a = await node("a", { "1": { username: "Hero", ...fakeConnection() } });
  a.registerAction("read", (player) => player.username);
  expect(await a.askPlayer("hero", "read", {}, 1_000)).toEqual({ status: "answered", value: "Hero" });
});

test("nobody holding the player is an answer, with a cluster and without", async () => {
  const a = await node("a", {});
  expect(await a.askPlayer("nobody", "read", {}, 1_000)).toEqual({ status: "gone" });
  expect(await new Delivery(players({})).askPlayer("nobody", "read", {}, 1_000)).toEqual({ status: "gone" });
});

test("a node the directory still names says so when it no longer holds the player", async () => {
  const a = await node("a", {});
  await node("b", {});
  await new PlayerDirectory(store, "b").claim("Hero", "7", "main");
  expect(await a.askPlayer("hero", "read", {}, 1_000)).toEqual({ status: "gone" });
});

test("a question that cannot be sent has changed nothing", async () => {
  const flaky = new FlakyStore();
  const a = await nodeOn(flaky, "a", {});
  await nodeOn(flaky, "b", { "7": { username: "Hero", ...fakeConnection() } });
  flaky.failing = true;
  expect(await a.askPlayer("hero", "read", {}, 1_000)).toEqual({ status: "unreached" });
  // The lookup works; only the publish fails.
  flaky.get = MemoryStore.prototype.get;
  expect(await a.askPlayer("hero", "read", {}, 1_000)).toEqual({ status: "unreached" });
});

test("no answer in time may still have run, and so may an action that threw", async () => {
  const a = await node("a", {});
  const b = await node("b", { "7": { username: "Hero", ...fakeConnection() } });
  b.registerAction("slow", () => new Promise(() => {}));
  b.registerAction("broken", () => { throw new Error("no"); });
  expect(await a.askPlayer("hero", "slow", {}, 20)).toEqual({ status: "unsure" });
  expect(await a.askPlayer("hero", "broken", {}, 20)).toEqual({ status: "unsure" });
});

test("a node that passes a player on passes the question on too", async () => {
  const a = await node("a", {});
  const b = await node("b", {});
  const c = await node("c", { "7": { username: "Hero", ...fakeConnection() } });
  c.registerAction("read", (player) => player.username);
  a.setForwarder(() => "b");
  b.setForwarder(() => "c");
  expect(await a.askPlayer("Hero", "read", {}, 1_000)).toEqual({ status: "answered", value: "Hero" });
});

test("what reaches a connection through delivery is heard", async () => {
  const hero = fakeConnection();
  const heard: unknown[][] = [];
  hearDeliveries((wt, packets) => heard.push([wt, packets.length]));
  try {
    await new Delivery(players({ "1": { username: "Hero", ...hero } })).deliverToPlayer("hero", [encode("hi")]);
    expect(heard).toEqual([[hero.wt, 1]]);
  } finally {
    hearDeliveries(null);
  }
});
