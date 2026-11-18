import { beforeEach, expect, test } from "bun:test";
import { ClusterBus } from "../cluster/bus";
import { Delivery } from "../cluster/deliver";
import { PlayerDirectory } from "../cluster/directory";
import { MemoryStore } from "../cluster/memorystore";
import { WHISPER_REACH, hiddenCount, registerWhisperReach, whisperReach } from "../socket/stealthoffline";

// USER REQUEST 2026-11-14: a stealthed admin looks offline to players: not in the realm count, not whisperable.

const TEST_BUS_KEY = "test-bus-key";

function players(entries: Record<string, any>) {
  return {
    get: (key: string) => entries[key],
    getByUsername: (name: string) => Object.values(entries).find((p) => p.username.toLowerCase() === name.toLowerCase()),
    list: () => entries,
  };
}

const player = (username: string, fields: Record<string, any> = {}) => ({ username, ...fields, wt: { readyState: 1, send() {}, sendBestEffort() {} } });
const someone = { username: "someone", isAdmin: false };
const admin = { username: "boss", isAdmin: true };

let store: MemoryStore;
beforeEach(() => { store = new MemoryStore(); });

async function node(id: string, entries: Record<string, any>, register = registerWhisperReach) {
  const bus = new ClusterBus(store, id, TEST_BUS_KEY);
  await bus.start();
  const directory = new PlayerDirectory(store, id);
  const delivery = new Delivery(players(entries));
  delivery.attach(bus, directory);
  for (const [key, p] of Object.entries(entries)) await directory.claim(p.username, key, "main");
  register(delivery);
  return delivery;
}

function single(entries: Record<string, any>) {
  const delivery = new Delivery(players(entries));
  registerWhisperReach(delivery);
  return delivery;
}

test("a player whispering a stealthed admin finds them offline", async () => {
  const delivery = single({ "1": player("Ghost", { isAdmin: true, isStealth: true }) });
  expect(await whisperReach(delivery, someone, "ghost")).toBe("offline");
});

test("an admin can still whisper a stealthed admin", async () => {
  const delivery = single({ "1": player("Ghost", { isAdmin: true, isStealth: true }) });
  expect(await whisperReach(delivery, admin, "ghost")).toBe("reachable");
});

test("a player out of stealth is whispered as before", async () => {
  const delivery = single({ "1": player("Hero") });
  expect(await whisperReach(delivery, someone, "hero")).toBe("reachable");
});

test("nobody by that name is offline", async () => {
  expect(await whisperReach(single({}), someone, "nobody")).toBe("offline");
  expect(await whisperReach(single({}), admin, "nobody")).toBe("offline");
});

test("on another node, a stealthed admin is offline to a player and reachable to an admin", async () => {
  const a = await node("a", {});
  await node("b", { "7": player("Ghost", { isAdmin: true, isStealth: true }), "8": player("Hero") });
  expect(await whisperReach(a, someone, "ghost")).toBe("offline");
  expect(await whisperReach(a, admin, "ghost")).toBe("reachable");
  expect(await whisperReach(a, someone, "hero")).toBe("reachable");
  expect(await whisperReach(a, someone, "nobody")).toBe("offline");
});

test("a node that does not answer in time leaves the target unreached", async () => {
  const a = await node("a", {});
  await node("b", { "7": player("Ghost") }, (d) => d.registerAction(WHISPER_REACH, () => new Promise(() => {})));
  expect(await whisperReach(a, someone, "ghost", 50)).toBe("unreached");
});

test("the realm count leaves out stealthed players", () => {
  const list = [player("a"), player("b", { isAdmin: true, isStealth: true }), player("c", { isAdmin: true }), null];
  expect(hiddenCount(list)).toBe(1);
  expect(hiddenCount([])).toBe(0);
});
