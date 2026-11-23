import { describe, expect, test } from "bun:test";
import { pickFromPartyFrame, pickPartyMember, pickPlayerAt, pickPlayerNamed } from "../systems/playerpick";

const at = (id: string, x: number, y: number) => ({ id, location: { position: { x, y } } });
const pick = (players: ReturnType<typeof at>[], x: number, y: number, range = 35, viewer = "me") =>
  pickPlayerAt(players, x, y, range, viewer)?.id ?? null;

describe("picking a player with a click", () => {
  test("of two overlapping players, the one further south is picked, whichever comes first", () => {
    const north = at("north", 100, 100);
    const south = at("south", 104, 110);
    // The click is on both bodies and nearer the northern player's anchor.
    expect(pick([north, south], 101, 102)).toBe("south");
    expect(pick([south, north], 101, 102)).toBe("south");
  });

  test("a click on the head that shows above the player in front picks the one behind", () => {
    const north = at("north", 100, 100);
    const south = at("south", 100, 112);
    // y 84 is inside the northern body (82..121) and above the southern one (94..133).
    expect(pick([north, south], 100, 84)).toBe("north");
  });

  test("players standing side by side are picked by the body clicked, not by who is further south", () => {
    const left = at("left", 100, 100);
    const right = at("right", 130, 104);
    expect(pick([left, right], 100, 100)).toBe("left");
    expect(pick([left, right], 130, 100)).toBe("right");
  });

  test("on the very same line the viewer's own player is on top, else the nearer one", () => {
    const me = at("me", 100, 100);
    const other = at("other", 104, 100);
    const third = at("third", 96, 100);
    expect(pick([other, me], 103, 100)).toBe("me");
    expect(pick([me, other], 103, 100)).toBe("me");
    expect(pick([third, other], 103, 100)).toBe("other");
    expect(pick([other, third], 97, 100)).toBe("third");
  });

  test("the viewer's own player is covered by one standing further south", () => {
    expect(pick([at("me", 100, 100), at("other", 100, 103)], 100, 100)).toBe("other");
  });

  test("a click that misses every body picks the nearest player in range", () => {
    const a = at("a", 100, 100);
    const b = at("b", 150, 100);
    expect(pick([a, b], 122, 130)).toBe("a");
    expect(pick([a, b], 130, 130)).toBe("b");
  });

  test("nobody in range gives nothing, and a touch reaches further than a cursor", () => {
    const a = at("a", 100, 100);
    expect(pick([a], 140, 100)).toBe(null);
    expect(pick([a], 140, 100, 49)).toBe("a");
    expect(pick([], 100, 100)).toBe(null);
  });
});

describe("picking a player by name (a party frame clicked)", () => {
  const named = (id: string, username: string) => ({ id, username, location: { position: { x: 0, y: 0 } } });
  test("the player of that name is picked, without regard to case", () => {
    const a = named("a", "Alice"), b = named("b", "bob");
    expect(pickPlayerNamed([a, b], "BOB", "me")?.id).toBe("b");
    expect(pickPlayerNamed([a, b], "alice", "me")?.id).toBe("a");
  });
  test("nobody of that name, a blank name, or the viewer themself picks nobody", () => {
    const me = named("me", "Me"), a = named("a", "Alice");
    expect(pickPlayerNamed([me, a], "carol", "me")).toBeNull();
    expect(pickPlayerNamed([me, a], "", "me")).toBeNull();
    expect(pickPlayerNamed([me, a], "me", "me")).toBeNull();
  });
});

describe("picking a party member by name, from anywhere", () => {
  const ann = { id: "a", username: "Ann", location: { map: "far", position: { x: 9000, y: 9000 } } };
  const cat = { id: "c", username: "cat", location: { map: "far", position: { x: 0, y: 0 } } };

  test("a member of the viewer's party is picked on any map, in any case", () => {
    expect(pickPartyMember([ann, cat], "ANN", { id: "me", party: ["bob", "ann"] })?.id).toBe("a");
  });

  test("anyone outside the party, the viewer, or a viewer with no party is not", () => {
    expect(pickPartyMember([ann, cat], "cat", { id: "me", party: ["ann"] })).toBeNull();
    expect(pickPartyMember([ann], "ann", { id: "me", party: null })).toBeNull();
    expect(pickPartyMember([ann], "ann", { id: "a", party: ["ann"] })).toBeNull();
  });
});

describe("a party frame clicked", () => {
  const me = { id: "me", username: "Me", party: ["me", "ann"] };
  const ann = { id: "a", username: "Ann", party: ["me", "ann"] };
  const bob = { id: "b", username: "bob", party: null };

  test("the viewer's own frame selects the viewer", () => {
    expect(pickFromPartyFrame([me, ann], [me, ann], "ME", me)?.id).toBe("me");
  });

  test("a member shown here, or a party member anywhere, is picked; anyone else is not", () => {
    expect(pickFromPartyFrame([bob], [me, ann, bob], "bob", me)?.id).toBe("b");
    expect(pickFromPartyFrame([], [me, ann], "ann", me)?.id).toBe("a");
    expect(pickFromPartyFrame([], [me, bob], "bob", me)).toBeNull();
  });
});
