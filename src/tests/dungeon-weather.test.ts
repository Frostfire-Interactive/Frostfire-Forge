import { describe, expect, test } from "bun:test";
import { MapIndex } from "../services/mapindex";
import { receiverSource } from "./receiver-source";

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
const fn = (header: string) => cut(receiver, header, /\n}\r?\n/) + "\n}";
const withNames = (names: string[], code: string): ((given: Record<string, any>) => any) =>
  new Function(`"use strict";\n${transpiler.transformSync(`function make({ ${names.join(", ")} }: any) { ${code} }`)}\nreturn make;`)();

/** Players on the crypt, in two copies of it, and on maps of other worlds. */
function index(): MapIndex {
  const maps = new MapIndex();
  maps.addPlayer("p1", "crypt.json");
  maps.addPlayer("p2", "crypt~a");
  maps.addPlayer("p3", "crypt~b.json");
  maps.addPlayer("q1", "cryptic");
  maps.addPlayer("q2", "town~crypt");
  return maps;
}

describe("a world's players", () => {
  test("are on its map and in every dungeon copy of it, and no other world's", () => {
    const maps = index();
    expect(maps.mapsInWorld("crypt").sort()).toEqual(["crypt", "crypt~a", "crypt~b"]);
    expect(maps.mapsInWorld("crypt.json").sort()).toEqual(["crypt", "crypt~a", "crypt~b"]);
    expect(maps.playersInWorld("crypt").sort()).toEqual(["p1", "p2", "p3"]);
    expect(maps.playersInWorld("town")).toEqual(["q2"]);
    expect(maps.playersInWorld("nowhere")).toEqual([]);
  });

  test("leave it when they leave the copy", () => {
    const maps = index();
    maps.movePlayer("p2", "crypt~a", "town");
    maps.removePlayer("p3");
    expect(maps.mapsInWorld("crypt")).toEqual(["crypt"]);
    expect(maps.playersInWorld("crypt")).toEqual(["p1"]);
  });
});

describe("a dungeon level's weather is its map's world weather", () => {
  test("a weather shown for the world is shown in its copies too", async () => {
    const showWeatherHere = withNames(
      ["resolvedWeatherCache", "weatherShown", "mapIndex", "playerCache", "sendPacket", "packetManager"],
      fn("async function showWeatherHere(") + "\nreturn showWeatherHere;",
    );
    const sent: string[] = [];
    const run = showWeatherHere({
      resolvedWeatherCache: new Map(),
      weatherShown: async (weather: string) => ({ weather }),
      mapIndex: index(),
      playerCache: { get: (id: string) => ({ id, wt: { readyState: 1, id } }) },
      sendPacket: (wt: any) => sent.push(wt.id),
      packetManager: { changeWeather: (shown: any) => shown },
    });
    await run("crypt", "rain", null);
    expect(sent.sort()).toEqual(["p1", "p2", "p3"]);
  });

  test("a copy's map is sent as a map with weather, so the client draws it and its day and night", () => {
    expect(fn("export function constructMapMetadata(")).toContain("hasWeather: !!worldsArr.find((w) => w.name === templateOf(normalizedName)),");
  });

  test("going into a copy shows its world's weather", () => {
    const arrival = cut(receiver, "setImmediate(async () => {", /syncNpcChunks/);
    expect(arrival).toContain("const weatherWorld = templateOf(newMapName);");
    expect(arrival).toContain("(await getLiveWorlds()).some((w) => w.name === weatherWorld)");
    expect(arrival).toContain("resolveWorldWeather(weatherWorld)");
  });

  test("logging in, or arriving from another node, inside a copy shows its world's weather", () => {
    expect(receiver).toContain("const weatherWorld = worldData.find((w) => w.name === templateOf(spawnLocation.map));");
    expect(receiver).toContain("const resolved = await resolveWorldWeather(weatherWorld.name);");
  });

  test("/weather in a copy sets its world's weather and shows it to the world and every copy", () => {
    const command = cut(receiver, `case "WEATHER": {`, /\n {10}case "GIVE": \{/);
    expect(command).toContain("const currentMapName = templateOf(currentPlayer.location.map);");
    expect(command).toContain("mapIndex.playersInWorld(currentMapName)");
    expect(command).not.toContain("getPlayersOnMap(");
  });

  test("the random cycle and lightning reach the copies too", () => {
    expect(fn("function scheduleWeatherCycle(")).toContain("mapIndex.playersInWorld(world.name)");
    expect(fn("function scheduleLightning(")).toContain("mapIndex.mapsInWorld(world.name)");
  });
});
