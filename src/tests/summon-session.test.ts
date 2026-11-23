import { describe, expect, test } from "bun:test";
import {
  CAST_MS, PROMPT_MS, STONE_RANGE_PX, WAIT_MS, check, inRange, touch,
  type Member, type Session,
} from "../systems/summonsession";

const stone = { map: "town", name: "S", x: 100, y: 200 };
const party = ["ann", "bob", "cat"];
const now = 1_000_000;

function member(username: string, x: number, y: number, over: Partial<Member> = {}): Member {
  return { username, x, y, map: "town", party, dead: false, online: true, ...over };
}
const ann = (x = 100, y = 230) => member("ann", x, y);
const bob = (x = 100, y = 230) => member("bob", x, y);
const cat = () => member("cat", 500, 500);

function members(...list: Array<Member | undefined>): Map<string, Member | undefined> {
  return new Map(list.filter((m): m is Member => !!m).map((m) => [m.username, m]));
}
function waiting(): Session {
  return { stone, phase: "waiting", summoner: "ann", target: "cat", helper: null, until: now + WAIT_MS };
}
function casting(): Session {
  return { stone, phase: "casting", summoner: "ann", target: "cat", helper: "bob", until: now + CAST_MS };
}
const said = (step: { say: Array<{ to: string; text: string }> }, to: string) => step.say.filter((s) => s.to === to).map((s) => s.text);

describe("summon session", () => {
  test("the shared values", () => {
    expect([STONE_RANGE_PX, WAIT_MS, CAST_MS, PROMPT_MS]).toEqual([150, 30_000, 5_000, 60_000]);
  });

  test("touching from 151 px is refused; from 150 px with a party member targeted starts the 30 s cast", () => {
    const far = touch(null, ann(100, 351), stone, now, [ann(100, 351), bob(), cat()], "cat");
    expect(far.session).toBeNull();
    expect(said(far, "ann")).toEqual(["Move closer to the summoning stone."]);
    const near = touch(null, ann(100, 350), stone, now, [ann(100, 350), bob(), cat()], "cat");
    expect(near.session).toEqual({
      stone, phase: "waiting", summoner: "ann", target: "cat", helper: null, until: now + 30_000, spots: { ann: { x: 100, y: 350 } },
    });
    expect(near.effect).toBe("start-wait");
    expect(said(near, "ann")).toEqual(["Waiting for another party member to touch the stone."]);
  });

  test("a toucher with no party is told so", () => {
    const step = touch(null, member("ann", 100, 230, { party: null }), stone, now, undefined, "cat");
    expect(step.session).toBeNull();
    expect(said(step, "ann")).toEqual(["You must be in a party to use a summoning stone."]);
  });

  test("the target must be another party member who is not at the stone", () => {
    const mates = [ann(), bob(), cat()];
    const cases: Array<[string | null, string]> = [
      [null, "Target a party member to summon."],
      ["ann", "You cannot summon yourself."],
      ["dan", "Dan is not in your party."],
      ["bob", "Bob is already at the summoning stone."],
    ];
    for (const [target, text] of cases) {
      const step = touch(null, ann(), stone, now, mates, target);
      expect(step.session).toBeNull();
      expect(step.effect).toBeUndefined();
      expect(said(step, "ann")).toEqual([text]);
    }
  });

  test("a party member who is not on this node can be the target", () => {
    const step = touch(null, ann(), stone, now, [ann(), bob()], "cat");
    expect(step.session?.target).toBe("cat");
  });

  test("a second party member who is not the target starts the 5 s cast", () => {
    const step = touch(waiting(), bob(), stone, now);
    expect(step.session?.phase).toBe("casting");
    expect(step.session?.helper).toBe("bob");
    expect(step.session?.until).toBe(now + 5_000);
    expect(step.effect).toBe("start-cast");
  });

  test("the helper's spot is kept beside the summoner's", () => {
    const step = touch({ ...waiting(), spots: { ann: { x: 100, y: 230 } } }, bob(90, 220), stone, now);
    expect(step.session?.spots).toEqual({ ann: { x: 100, y: 230 }, bob: { x: 90, y: 220 } });
  });

  test("a step by the summoner while waiting cancels the summon", () => {
    const s = { ...waiting(), spots: { ann: { x: 100, y: 230 } } };
    expect(check(s, members(ann(100, 230), cat()), now + 1).session).toBe(s);
    const step = check(s, members(ann(101, 230), cat()), now + 1);
    expect(step.session).toBeNull();
    expect(step.effect).toBe("end");
    expect(said(step, "ann")).toEqual(["The summon was cancelled."]);
  });

  test("a toucher whose cast was broken (Esc, a stun) cancels the summon", () => {
    const wait = check(waiting(), members(member("ann", 100, 230, { cast: false }), cat()), now + 1);
    expect(wait.session).toBeNull();
    expect(said(wait, "ann")).toEqual(["The summon was cancelled."]);
    const cast = check(casting(), members(ann(), member("bob", 100, 230, { cast: false }), cat()), now + 1);
    expect(cast.effect).toBe("cancel-cast");
    expect(check(casting(), members(member("ann", 100, 230, { cast: true }), bob(), cat()), now + 1).effect).toBeUndefined();
  });

  test("a step by either toucher cancels the cast", () => {
    const s = { ...casting(), spots: { ann: { x: 100, y: 230 }, bob: { x: 100, y: 230 } } };
    expect(check(s, members(ann(), bob(), cat()), now + 1).session).toBe(s);
    for (const map of [members(ann(100, 231), bob(), cat()), members(ann(), bob(99, 230), cat())]) {
      const step = check(s, map, now + 1);
      expect(step.session).toBeNull();
      expect(step.effect).toBe("cancel-cast");
      expect(said(step, "ann")).toEqual(["The summon was cancelled."]);
      expect(said(step, "bob")).toEqual(["The summon was cancelled."]);
    }
  });

  test("the summoner touching again, a stranger, or the target cannot be the helper", () => {
    const again = touch(waiting(), ann(), stone, now);
    expect(again.session?.phase).toBe("waiting");
    expect(said(again, "ann")).toEqual(["Waiting for another party member to touch the stone."]);
    const stranger = touch(waiting(), member("dan", 100, 230, { party: ["dan"] }), stone, now);
    expect(stranger.session?.phase).toBe("waiting");
    expect(said(stranger, "dan")).toEqual(["Only a member of the summoner's party can help."]);
    const target = touch(waiting(), member("cat", 100, 230), stone, now);
    expect(target.session?.phase).toBe("waiting");
    expect(said(target, "cat")).toEqual(["You cannot help summon yourself."]);
  });

  test("the summoner walking away from the stone ends the wait", () => {
    const step = check(waiting(), members(ann(100, 351), cat()), now + 1);
    expect(step.session).toBeNull();
    expect(step.effect).toBe("end");
  });

  test("another party's touch on a busy stone is refused", () => {
    const step = touch(casting(), member("dan", 100, 230, { party: ["dan"] }), stone, now);
    expect(step.session?.phase).toBe("casting");
    expect(said(step, "dan")).toEqual(["This summoning stone is already in use."]);
  });

  test("the cast cancels when a toucher moves past 150 px, leaves the party, dies or is gone, or the target leaves the party", () => {
    const cases: Array<Map<string, Member | undefined>> = [
      members(ann(), bob(100, 351), cat()),
      members(ann(), member("bob", 100, 230, { party: ["bob", "cat"] }), cat()),
      members(ann(), member("bob", 100, 230, { dead: true }), cat()),
      members(ann(), member("bob", 100, 230, { online: false }), cat()),
      members(member("ann", 100, 230, { party: ["ann", "bob"] }), bob(), cat()),
    ];
    for (const map of cases) {
      const step = check(casting(), map, now + 1);
      expect(step.session).toBeNull();
      expect(step.effect).toBe("cancel-cast");
      expect(said(step, "ann")).toEqual(["The summon was cancelled."]);
      expect(said(step, "bob")).toEqual(["The summon was cancelled."]);
    }
  });

  test("Review Focus 4: a toucher missing from the members map (handed off) cancels the cast", () => {
    for (const map of [members(ann(), cat()), members(bob(), cat())]) {
      const step = check(casting(), map, now + 1);
      expect(step.session).toBeNull();
      expect(step.effect).toBe("cancel-cast");
      expect(said(step, "ann")).toEqual(["The summon was cancelled."]);
      expect(said(step, "bob")).toEqual(["The summon was cancelled."]);
    }
    const gone = new Map<string, Member | undefined>([["ann", ann()], ["bob", undefined], ["cat", cat()]]);
    expect(check(casting(), gone, now + 1).effect).toBe("cancel-cast");
  });

  test("waiting past its time lapses", () => {
    const s = waiting();
    const step = check(s, members(ann(), cat()), s.until + 1);
    expect(step.session).toBeNull();
    expect(step.effect).toBe("end");
    expect(said(step, "ann")).toEqual(["Nobody else touched the summoning stone in time."]);
  });

  test("a live waiting session is left alone", () => {
    const s = waiting();
    const step = check(s, members(ann(), cat()), now + 1);
    expect(step.session).toBe(s);
    expect(step.effect).toBeUndefined();
  });

  test("a finished cast moves to prompting for 60 s", () => {
    const s = casting();
    const step = check(s, members(ann(), bob(), cat()), s.until);
    expect(step.session?.phase).toBe("prompting");
    expect(step.session?.until).toBe(s.until + 60_000);
    expect(step.effect).toBe("offer-prompt");
  });

  test("inRange is the same map within 150 px", () => {
    expect(inRange({ map: "town", x: 100, y: 350 }, stone)).toBe(true);
    expect(inRange({ map: "town", x: 100, y: 351 }, stone)).toBe(false);
    expect(inRange({ map: "fields", x: 100, y: 200 }, stone)).toBe(false);
  });
});
