import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../cluster/memorystore";
import { CLAIM_TTL_MS, SummonClaims, stoneKey } from "../cluster/summonclaims";

for (const mode of ["without a store", "with a store"] as const) {
  describe(`SummonClaims ${mode}`, () => {
    const make = () => new SummonClaims(mode === "with a store" ? new MemoryStore() : null);

    test("one summon per stone", async () => {
      const claims = make();
      expect(await claims.claim("town/S", "cat", "ann")).toBe("ok");
      expect(await claims.claim("town/S", "dan", "eve")).toBe("stone");
      expect(await claims.targetBusy("dan")).toBe(false);
    });

    test("one summon per target", async () => {
      const claims = make();
      expect(await claims.claim("town/S", "cat", "ann")).toBe("ok");
      expect(await claims.claim("town/T", "Cat", "eve")).toBe("target");
      expect(await claims.claim("town/T", "dan", "eve")).toBe("ok");
      expect(await claims.targetBusy("CAT")).toBe(true);
    });

    test("release frees both; another claimer cannot release them", async () => {
      const claims = make();
      await claims.claim("town/S", "cat", "ann");
      await claims.release("town/S", "cat", "eve");
      expect(await claims.targetBusy("cat")).toBe(true);
      expect(await claims.claim("town/S", "dan", "eve")).toBe("stone");
      await claims.release("town/S", "cat", "ann");
      expect(await claims.targetBusy("cat")).toBe(false);
      expect(await claims.claim("town/S", "cat", "eve")).toBe("ok");
    });
  });
}

describe("SummonClaims clock", () => {
  test("claims expire after 130 s", async () => {
    let t = 1_000;
    const claims = new SummonClaims(null, () => t);
    expect(CLAIM_TTL_MS).toBe(130_000);
    expect(await claims.claim("town/S", "cat", "ann")).toBe("ok");
    t += 130_000;
    expect(await claims.claim("town/S", "dan", "eve")).toBe("stone");
    t += 1;
    expect(await claims.targetBusy("cat")).toBe(false);
    expect(await claims.claim("town/S", "cat", "ann")).toBe("ok");
  });

  test("a stone key is the bare map name and the stone's name", () => {
    expect(stoneKey("town.json", "S")).toBe("town/S");
  });
});
