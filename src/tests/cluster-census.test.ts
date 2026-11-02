import { expect, spyOn, test } from "bun:test";
import { ClusterBus } from "../cluster/bus";
import { Census, ONLINE_SETTLE_MS, type PanelSource, SettledCount } from "../cluster/census";
import { MemoryStore } from "../cluster/memorystore";
import { type LoadReport, type NodeInfo, NodeRegistry } from "../cluster/nodes";

const TEST_BUS_KEY = "test-bus-key";

// Published messages arrive on the next immediate; five turns covers a message that triggers another.
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

const info = (nodeId: string, regionId: string): NodeInfo => ({
  nodeId,
  regionId,
  publicHost: `${nodeId}.example.com`,
  port: 3000,
  startedAt: 1,
} as NodeInfo);

const load = (nodeId: string, players: number): LoadReport => ({ nodeId, at: Date.now(), players, creatures: 0, blocks: {} });

function panelOf(rows: unknown[], status: unknown = { uptime: 5 }) {
  const heard: unknown[] = [];
  const asked = { times: 0 };
  const source: PanelSource = {
    answer: () => { asked.times++; return { rows, status }; },
    activity: (entry) => heard.push(entry),
  };
  return { source, heard, asked };
}

async function node(store: MemoryStore, nodeId: string, opts: { panel?: PanelSource; region?: string; freshMs?: number } = {}) {
  const region = opts.region ?? "eu";
  const registry = new NodeRegistry(store);
  await registry.announce(info(nodeId, region));
  await registry.beat(nodeId);
  const bus = new ClusterBus(store, nodeId, TEST_BUS_KEY);
  await bus.start();
  const census = new Census(registry, bus, nodeId, region, () => opts.panel ?? null, 40, opts.freshMs ?? 1_000);
  return { registry, census };
}

test("the count is the other nodes' players, of this region only", async () => {
  const store = new MemoryStore();
  const a = await node(store, "a");
  const b = await node(store, "b");
  const c = await node(store, "c");
  const far = await node(store, "far", { region: "us" });
  await a.registry.report(load("a", 100));
  await b.registry.report(load("b", 3));
  await c.registry.report(load("c", 4));
  await far.registry.report(load("far", 50));

  expect(a.census.othersOnline()).toBe(0);
  await a.census.read();
  expect(a.census.othersOnline()).toBe(7);
  expect(a.census.reports().map((report) => report.nodeId).sort()).toEqual(["b", "c"]);
});

test("a dead node's report stops counting", async () => {
  const store = new MemoryStore();
  const a = await node(store, "a");
  const b = await node(store, "b");
  await b.registry.report(load("b", 3));
  await a.census.read();
  expect(a.census.othersOnline()).toBe(3);

  await b.registry.retire("b");
  await a.census.read();
  expect(a.census.othersOnline()).toBe(0);
});

test("a read that fails keeps the last count", async () => {
  const store = new MemoryStore();
  const a = await node(store, "a");
  const b = await node(store, "b");
  await b.registry.report(load("b", 3));
  await a.census.read();

  const failing = spyOn(a.registry, "loads").mockRejectedValue(new Error("store down"));
  await a.census.read();
  expect(a.census.othersOnline()).toBe(3);
  failing.mockRestore();
});

test("the roster holds each node's own answer", async () => {
  const store = new MemoryStore();
  const a = await node(store, "a");
  const b = await node(store, "b", { panel: panelOf([{ username: "bea" }], { uptime: 9 }).source });
  await b.registry.report(load("b", 1));
  await a.census.read();

  const roster = await a.census.roster();
  expect(roster.length).toBe(1);
  expect(roster[0].nodeId).toBe("b");
  expect(roster[0].report?.players).toBe(1);
  expect(roster[0].answer).toEqual({ rows: [{ username: "bea" }], status: { uptime: 9 } });
});

test("a node that does not answer is left to its load report", async () => {
  const store = new MemoryStore();
  const a = await node(store, "a");
  const b = await node(store, "b", { panel: panelOf([{ username: "bea" }]).source });
  const c = await node(store, "c");
  await b.registry.report(load("b", 1));
  await c.registry.report(load("c", 6));
  await a.census.read();

  const roster = await a.census.roster();
  expect(roster.find((peer) => peer.nodeId === "b")?.answer?.rows).toEqual([{ username: "bea" }]);
  const silent = roster.find((peer) => peer.nodeId === "c");
  expect(silent?.answer).toBeNull();
  expect(silent?.report?.players).toBe(6);
});

test("panels open at once share one ask, and later ones the answers", async () => {
  const store = new MemoryStore();
  const a = await node(store, "a");
  const peer = panelOf([]);
  const b = await node(store, "b", { panel: peer.source });
  await b.registry.report(load("b", 0));
  await a.census.read();

  await Promise.all([a.census.roster(), a.census.roster(), a.census.roster()]);
  await a.census.roster();
  await settle();
  expect(peer.asked.times).toBe(1);
});

test("stale answers are asked for again", async () => {
  const store = new MemoryStore();
  const a = await node(store, "a", { freshMs: 0 });
  const peer = panelOf([]);
  const b = await node(store, "b", { panel: peer.source });
  await b.registry.report(load("b", 0));
  await a.census.read();

  await a.census.roster();
  await a.census.roster();
  expect(peer.asked.times).toBe(2);
});

test("with no other node, nobody is asked and the roster is empty", async () => {
  const a = await node(new MemoryStore(), "a");
  await a.census.read();
  expect(await a.census.roster()).toEqual([]);
});

test("an admin's action reaches the other nodes' panels, not this one's", async () => {
  const store = new MemoryStore();
  const mine = panelOf([]);
  const theirs = panelOf([]);
  const a = await node(store, "a", { panel: mine.source });
  await node(store, "b", { panel: theirs.source });

  a.census.shareActivity({ action: "player.kick" });
  await settle();
  expect(theirs.heard).toEqual([{ action: "player.kick" }]);
  expect(mine.heard).toEqual([]);
});

test("the first count goes out at once", () => {
  expect(new SettledCount().next(2, 1_000_000)).toBe(2);
});

test("a player crossing a border does not move the count players see", () => {
  const count = new SettledCount();
  const start = 1_000_000;
  count.next(2, start);
  // One node's connections change at once; the other's report catches up within the settle time.
  expect(count.next(3, start + 1_000)).toBeNull();
  expect(count.next(3, start + 2_000)).toBeNull();
  expect(count.next(2, start + 3_000)).toBeNull();
  // The clock restarted when the count matched again: the next crossing gets the whole settle time.
  expect(count.next(1, start + 4_000)).toBeNull();
  expect(count.next(1, start + 3_000 + ONLINE_SETTLE_MS - 1)).toBeNull();
  expect(count.next(2, start + 3_000 + ONLINE_SETTLE_MS)).toBeNull();
});

test("a real change goes out once it has held, and does not repeat", () => {
  const count = new SettledCount();
  const start = 1_000_000;
  count.next(2, start);
  expect(count.next(3, start + ONLINE_SETTLE_MS - 1)).toBeNull();
  expect(count.next(3, start + ONLINE_SETTLE_MS)).toBe(3);
  expect(count.next(3, start + ONLINE_SETTLE_MS * 2)).toBeNull();
  expect(count.next(1, start + ONLINE_SETTLE_MS * 3)).toBe(1);
});

test("a count that keeps changing still goes out, every settle time at most", () => {
  const count = new SettledCount();
  const start = 1_000_000;
  count.next(10, start);
  const sent: number[] = [];
  for (let i = 1; i <= 9; i++) {
    const out = count.next(10 + i, start + i * 1_000);
    if (out !== null) sent.push(out);
  }
  expect(sent).toEqual([14, 18]);
});
