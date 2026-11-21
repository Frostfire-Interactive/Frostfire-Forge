import { expect, test } from "bun:test";
import assetCache, { changedElsewhere, onWrite } from "../services/assetCache";

test("a write here is heard by key, and a clear as every key", async () => {
  const heard: (string | null)[] = [];
  const stop = onWrite((key) => heard.push(key));
  try {
    await assetCache.set("elsewhere-a", [1]);
    await assetCache.remove("elsewhere-a");
    expect(heard).toEqual(["elsewhere-a", "elsewhere-a"]);
  } finally {
    stop();
  }
  await assetCache.set("elsewhere-a", [2]);
  expect(heard.length).toBe(2);
});

test("a write made elsewhere reaches the key's listeners here, and is not heard as a write made here", () => {
  let a = 0;
  let b = 0;
  assetCache.onChange("elsewhere-b", () => a++);
  assetCache.onChange("elsewhere-c", () => b++);
  const written: (string | null)[] = [];
  const stop = onWrite((key) => written.push(key));
  try {
    changedElsewhere("elsewhere-b");
    expect([a, b]).toEqual([1, 0]);
    changedElsewhere(null);
    expect([a, b]).toEqual([2, 1]);
    // Heard here as another node's write: it is not told on again.
    expect(written).toEqual([]);
  } finally {
    stop();
  }
});

test("a listener that throws keeps neither the write nor the next listener from going on", async () => {
  let after = 0;
  const stop = onWrite(() => { throw new Error("no"); });
  const stopAfter = onWrite(() => after++);
  try {
    await assetCache.set("elsewhere-d", [1]);
    expect(after).toBe(1);
    expect(await assetCache.get("elsewhere-d")).toEqual([1]);
  } finally {
    stop();
    stopAfter();
  }
});
