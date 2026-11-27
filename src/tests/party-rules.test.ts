import { describe, expect, test } from "bun:test";
import { afterLeaving, canInvite, capital, joinOutcome, newLeaderNotice, nonRaidCap, partyCap, RAID_CONVERT_MS } from "../systems/partyrules";

describe("party rules", () => {
  test("constants", () => {
    expect([nonRaidCap(), partyCap(), RAID_CONVERT_MS]).toEqual([5, 20, 60_000]);
  });
  test("joinOutcome", () => {
    expect(joinOutcome(4, false)).toBe("join");
    expect(joinOutcome(5, false)).toBe("convert");
    expect(joinOutcome(5, true)).toBe("join");
    expect(joinOutcome(19, true)).toBe("join");
    expect(joinOutcome(20, true)).toBe("full");
    expect(joinOutcome(20, false)).toBe("full");
  });
  test("a full party cannot invite anyone", () => {
    expect(canInvite(0)).toBe(true);
    expect(canInvite(5)).toBe(true);
    expect(canInvite(19)).toBe(true);
    expect(canInvite(20)).toBe(false);
    expect(canInvite(21)).toBe(false);
  });
  test("afterLeaving", () => {
    expect(afterLeaving(["ann", "bob", "cy"], "ann", "ann")).toEqual({ kind: "stay", leader: "bob", members: ["bob", "cy"] });
    expect(afterLeaving(["ann", "bob", "cy"], "ann", "bob")).toEqual({ kind: "stay", leader: "ann", members: ["ann", "cy"] });
    expect(afterLeaving(["ann", "bob"], "ann", "ann")).toEqual({ kind: "disband" });
    expect(afterLeaving(["ann", "bob", "cy"], "Ann", "ANN")).toEqual({ kind: "stay", leader: "bob", members: ["bob", "cy"] });
  });
  test("a name starts a sentence with a capital, and the new leader is named that way", () => {
    expect(capital("bob")).toBe("Bob");
    expect(capital("")).toBe("");
    expect(newLeaderNotice("bob")).toBe("Bob is now the party leader.");
  });
});
