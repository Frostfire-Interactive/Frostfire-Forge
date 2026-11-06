import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { followListsSavedElsewhere } from "../socket/authentication_pool";

// The login workers build a player's spell book, inventory and mounts from their own copy of those lists
// (socket/authentication_pool.ts). In a cluster an editor's save on another node writes the shared list, this node is
// told (services/assetCache.ts changedElsewhere), and its workers are handed the new list as after a save here.

function fakeCache() {
  const listeners = new Map<string, (elsewhere: boolean) => void>();
  return {
    onChange: (key: string, listener: (elsewhere: boolean) => void) => void listeners.set(key, listener),
    write: (key: string, elsewhere: boolean) => listeners.get(key)?.(elsewhere),
  };
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

test("a list saved on another node is handed to the workers here; one saved here is not handed twice", async () => {
  const cache = fakeCache();
  const handed: string[] = [];
  followListsSavedElsewhere(cache, { spells: async () => void handed.push("spells"), items: async () => void handed.push("items") });
  cache.write("spells", false);
  cache.write("items", true);
  cache.write("spells", true);
  cache.write("weather", true);
  await settle();
  expect(handed).toEqual(["items", "spells"]);
});

test("a hand-on that fails does not throw into the cache's write", async () => {
  const cache = fakeCache();
  followListsSavedElsewhere(cache, { items: async () => { throw new Error("no worker"); } });
  expect(() => cache.write("items", true)).not.toThrow();
  await settle();
});

test("the pool follows the spells, items and mounts its workers hold", () => {
  const pool = readFileSync(new URL("../socket/authentication_pool.ts", import.meta.url), "utf8");
  expect(pool).toContain("followListsSavedElsewhere(assetCache, { spells: refreshAuthSpells, items: refreshAuthItems, mounts: refreshAuthMounts });");
});
