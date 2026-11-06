import { describe, expect, test } from "bun:test";
import { WEATHER_CYCLE_MS, settledPick } from "../systems/weathercycle";
import { receiverSource } from "./receiver-source";

// Cluster mode: a world split between nodes shows one weather on both sides of a border. A "random" world settles on
// the same weather on every node (systems/weathercycle.ts), at the same moment; a weather set by /weather or the weather
// editor on one node is told to the others (peer news "weather"), which show it to their players of that world.
// receiver.ts cannot be imported: these read its source.

const receiver = receiverSource();
const transpiler = new Bun.Transpiler({ loader: "ts" });

/** `source` from `start` to the first match of `until` after it. */
function cut(source: string, start: string, until: RegExp): string {
  const at = source.indexOf(start);
  if (at < 0) throw new Error(`Not found in the source: ${start}`);
  const rest = source.slice(at);
  const end = rest.search(until);
  if (end < 0) throw new Error(`No end found for: ${start}`);
  return rest.slice(0, end);
}
/** A top-level function of the receiver, header to closing brace. */
const fn = (header: string) => cut(receiver, header, /\n}\r?\n/) + "\n}";
const withNames = (names: string[], code: string): ((given: Record<string, any>) => any) =>
  new Function(`"use strict";\n${transpiler.transformSync(`function make({ ${names.join(", ")} }: any) { ${code} }`)}\nreturn make;`)();

const table = ["rain", "snow", "fog", "clear", "thunderstorm"].map((name) => ({ name, look: name }));
const assetCache = { get: async (key: string) => (key === "weather" ? table : null) };

/** Players of world "w" (and one of world "x"), and what each was sent. */
function playersOf() {
  const sent: Record<string, any[]> = { p1: [], p2: [], q1: [] };
  const players: Record<string, any> = {};
  for (const id of Object.keys(sent)) players[id] = { id, wt: { readyState: 1, id } };
  return {
    sent,
    mapIndex: { getPlayersOnMap: (map: string) => new Set(map === "w" ? ["p1", "p2"] : map === "x" ? ["q1"] : []) },
    playerCache: { get: (id: string) => players[id] },
    sendPacket: (wt: any, packet: any) => sent[wt.id].push(packet),
    packetManager: { changeWeather: (shown: any) => ({ changeWeather: shown }) },
  };
}

describe("a random world", () => {
  const resolve = withNames(
    ["getLiveWorlds", "resolvedWeatherCache", "assetCache", "settledPick", "weatherApi", "rowOf"],
    fn("async function resolveWorldWeather(") + "\nreturn resolveWorldWeather;",
  );

  test("settles on the weather of its stretch, as every other node does", async () => {
    const cache = new Map<string, any>();
    const resolveWorldWeather = resolve({
      getLiveWorlds: async () => [{ name: "w", weather: "random" }],
      resolvedWeatherCache: cache, assetCache, settledPick, weatherApi: { WEATHER_API: "weather_api" }, rowOf: () => null,
    });
    const resolved = await resolveWorldWeather("w.json");
    expect(resolved.weather).toBe(settledPick(table, "w")!.name);
    expect(cache.get("w")?.weather).toBe(resolved.weather);
  });

  test("settles again at the turn of each stretch, and its players here are shown the new weather", async () => {
    const timers: { run: () => Promise<void>; ms: number }[] = [];
    const cache = new Map<string, any>();
    const world = playersOf();
    const scheduleWeatherCycle = withNames(
      ["setTimeout", "WEATHER_CYCLE_SLACK_MS", "worldsCache", "settledPick", "nextCycleIn", "assetCache", "resolvedWeatherCache", "mapIndex", "playerCache", "sendPacket", "packetManager", "weatherShown"],
      fn("function scheduleWeatherCycle(") + "\nreturn scheduleWeatherCycle;",
    )({
      setTimeout: (run: () => Promise<void>, ms: number) => timers.push({ run, ms }),
      worldsCache: [{ name: "w", weather: "random" }, { name: "x", weather: "rain" }],
      WEATHER_CYCLE_SLACK_MS: 1000, settledPick, nextCycleIn: () => 5000, assetCache, resolvedWeatherCache: cache, ...world,
      weatherShown: async (weather: string) => ({ weather }),
    });
    scheduleWeatherCycle();
    expect(timers.length).toBe(1);
    // A little past the turn, so a timer a few ms early still picks from the new stretch.
    expect(timers[0].ms).toBeGreaterThan(5000);
    expect(timers[0].ms).toBeLessThan(5000 + 5000);
    await timers[0].run();
    const settled = settledPick(table, "w")!.name;
    expect(cache.get("w")?.weather).toBe(settled);
    expect(world.sent.p1).toEqual([{ changeWeather: { weather: settled } }]);
    expect(world.sent.p2).toEqual([{ changeWeather: { weather: settled } }]);
    expect(world.sent.q1).toEqual([]);
    // And the next turn is waited for.
    expect(timers.length).toBe(2);
  });
});

describe("a weather set or shown on another node", () => {
  const handler = cut(receiver, `onPeerNews("weather",`, /\n}\);\r?\n/) + "\n});";
  const install = withNames(
    ["onPeerNews", "worldsCache", "resolvedWeatherCache", "assetCache", "rowOf", "resolveWorldWeather", "showWeatherHere"],
    handler,
  );
  function heard(worlds: any[], cache: Map<string, any>) {
    let news: (data: any) => Promise<void> = async () => {};
    const shown: any[] = [];
    install({
      onPeerNews: (name: string, run: any) => { if (name === "weather") news = run; },
      worldsCache: worlds, resolvedWeatherCache: cache, assetCache,
      rowOf: (all: any[], name: string) => all.find((w) => w.name === name) ?? null,
      resolveWorldWeather: async (world: string) => cache.get(world) ?? { weather: worlds.find((w) => w.name === world)?.weather, weatherData: null },
      showWeatherHere: async (world: string, weather: string) => { shown.push({ world, weather }); },
    });
    return { news: (data: any) => news(data), shown };
  }

  test("set: this node's world takes it, forgets what it had settled on, and shows its players here", async () => {
    const worlds = [{ name: "w", weather: "random" }];
    const cache = new Map<string, any>([["w", { weather: "fog", weatherData: null }]]);
    const { news, shown } = heard(worlds, cache);
    await news({ world: "w", set: "snow" });
    expect(worlds[0].weather).toBe("snow");
    expect(cache.has("w")).toBe(false);
    expect(shown).toEqual([{ world: "w", weather: "snow" }]);
  });

  test("shown: a random world here settles on it too, with its row as this node reads it", async () => {
    const cache = new Map<string, any>([["w", { weather: "fog", weatherData: null }]]);
    const { news, shown } = heard([{ name: "w", weather: "random" }], cache);
    await news({ world: "w", shown: "rain" });
    expect(cache.get("w")).toEqual({ weather: "rain", weatherData: table[0] });
    expect(shown).toEqual([{ world: "w", weather: "rain" }]);
  });

  test("shown: a world that never settled is only shown what it is set to", async () => {
    const cache = new Map<string, any>();
    const { news, shown } = heard([{ name: "w", weather: "snow" }], cache);
    await news({ world: "w", shown: "snow" });
    expect(cache.has("w")).toBe(false);
    expect(shown).toEqual([{ world: "w", weather: "snow" }]);
  });

  test("news without a world does nothing", async () => {
    const { news, shown } = heard([{ name: "w", weather: "snow" }], new Map());
    await news({ set: "rain" });
    expect(shown).toEqual([]);
  });
});

describe("what tells the other nodes", () => {
  const bridge = cut(receiver, "const weatherBridge", /\n};\r?\n/);

  test("the weather editor's set and show", () => {
    expect(bridge).toContain(`tellPeers("weather", { world: worldName, set: weatherName })`);
    expect(bridge).toContain(`tellPeers("weather", { world: worldName, shown: weatherName })`);
  });

  test("not a reading of the real weather: every node reads its own", () => {
    const api = cut(receiver, "void weatherApi.startWeatherApi(", /\n}, \(utcOffset\)/);
    expect(api).toContain("showWeatherHere(world.name, weatherApi.WEATHER_API, row)");
    expect(api).not.toContain("weatherBridge.show(");
  });

  test("/weather, whose random settles on the stretch's weather as everywhere else", () => {
    const command = cut(receiver, `case "WEATHER": {`, /\n {10}case "GIVE": \{/);
    expect(command).toContain(`tellPeers("weather", { world: currentMapName, set: weatherName })`);
    expect(command).toContain("settledPick(");
    expect(command).not.toContain("randomPick(");
  });

  test("the cycle is no longer a fixed half hour from when the node started", () => {
    expect(fn("function scheduleWeatherCycle(")).not.toContain("30 * 60 * 1000");
    expect(WEATHER_CYCLE_MS).toBe(30 * 60 * 1000);
  });
});
