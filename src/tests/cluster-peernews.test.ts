import { expect, test } from "bun:test";
import { ClusterBus } from "../cluster/bus";
import { MemoryStore } from "../cluster/memorystore";
import { PeerNews } from "../cluster/peernews";

// The bus signs its envelopes (security review H1): every bus of a test shares this key.
const TEST_BUS_KEY = "test-bus-key";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Nodes n0, n1, ... on one store, each in the region given, each with its own news. */
async function nodes(regions: string[]) {
  const store = new MemoryStore();
  const made: { id: string; bus: ClusterBus; news: PeerNews }[] = [];
  for (const [i, region] of regions.entries()) {
    const id = `n${i}`;
    const bus = new ClusterBus(store, id, TEST_BUS_KEY);
    const news = new PeerNews();
    news.attach(bus, id, region);
    await bus.start();
    made.push({ id, bus, news });
  }
  return made;
}

test("news reaches the region's other nodes, not the node it happened on", async () => {
  const all = await nodes(["r", "r", "r"]);
  const got: string[] = [];
  for (const node of all) node.news.on("weather", (data, from) => { got.push(`${node.id}:${data.world}:${from}`); });
  expect(await all[0].news.tell("weather", { world: "overworld" })).toBe(true);
  await settle();
  expect(got.sort()).toEqual(["n1:overworld:n0", "n2:overworld:n0"]);
});

test("news from another region is not carried out", async () => {
  const [a, b] = await nodes(["r", "s"]);
  const got: string[] = [];
  b.news.on("weather", () => { got.push("b"); });
  await a.news.tell("weather", {});
  await settle();
  expect(got).toEqual([]);
});

test("a handler that fails does not stop the next news, and news no one handles is dropped", async () => {
  const [a, b] = await nodes(["r", "r"]);
  const got: string[] = [];
  b.news.on("bad", () => { throw new Error("boom"); });
  b.news.on("good", (data) => { got.push(data.n); });
  await a.news.tell("bad", {});
  await a.news.tell("nobody", {});
  await a.news.tell("good", { n: "1" });
  await settle();
  expect(got).toEqual(["1"]);
});

test("a handler taken off carries out nothing", async () => {
  const [a, b] = await nodes(["r", "r"]);
  const got: string[] = [];
  b.news.on("weather", () => { got.push("b"); });
  b.news.on("weather", null);
  await a.news.tell("weather", {});
  await settle();
  expect(got).toEqual([]);
});

test("outside cluster mode, or once detached, nothing is told", async () => {
  expect(await new PeerNews().tell("weather", {})).toBe(false);
  const [a, b] = await nodes(["r", "r"]);
  const got: string[] = [];
  b.news.on("weather", () => { got.push("b"); });
  a.news.detach();
  expect(await a.news.tell("weather", {})).toBe(false);
  await settle();
  expect(got).toEqual([]);
});
