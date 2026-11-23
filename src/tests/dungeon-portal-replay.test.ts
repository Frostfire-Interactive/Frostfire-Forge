import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Wiring only: movement.ts, receiver.ts and socket/dungeons.ts import receiver.ts, which tests cannot load.
// The crossing itself is tested in dungeon-glue.test.ts (portalCrossing).
const read = (...p: string[]) => readFileSync(join(import.meta.dir, "..", "socket", ...p), "utf8").replaceAll("\r", "");
const movement = read("handlers", "movement.ts");
const receiver = read("receiver.ts");
const dungeons = read("dungeons.ts");

const fnOf = (source: string, head: string) => {
  const start = source.indexOf(head);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("\n}\n", start));
};

describe("replayed steps and dungeon portals", () => {
  test("a replay keeps the points it walked through, from where it starts", () => {
    const fn = fnOf(movement, "export async function replayGapSteps(");
    const start = fn.indexOf("const path = [{ x: currentPlayer.location.position.x, y: currentPlayer.location.position.y }];");
    expect(start).toBeGreaterThan(fn.indexOf("if (from) {"));
    const step = fn.indexOf("takeStep(currentPlayer, direction, offset.dx, offset.dy);");
    expect(fn.indexOf("path.push({ x: currentPlayer.location.position.x, y: currentPlayer.location.position.y });")).toBeGreaterThan(step);
    expect(fn).toContain("return { moved, path };");
  });

  test("the walk's portal check is made on the replayed points: the first step in is taken as a step of the walk", () => {
    const fn = fnOf(dungeons, "export async function dungeonPortalWalk(");
    expect(fn).toContain("portalCrossing(portalsOn(");
    expect(fn).toContain("dungeonPortalStep(p, crossing.before, crossing.after)");
  });

  test("a MOVEXY's catch-up takes a portal it walked into, and goes no further", () => {
    const replay = movement.indexOf("const replay = await replayGapSteps(currentPlayer, Array(missed).fill(resumeCatchUp.walk));");
    expect(replay).toBeGreaterThan(-1);
    const next = movement.slice(replay, movement.indexOf("\n        }\n", replay));
    expect(next).toContain("if (await dungeonPortalWalk(currentPlayer, replay.path)) return;");
  });

  test("an arrival's replay takes a portal once the client is told where it stands, and the walk is not resumed then", () => {
    const replay = receiver.indexOf("replay = await movement.replayGapSteps(_pcache, gapPlan.steps);");
    expect(replay).toBeGreaterThan(-1);
    const done = receiver.indexOf("packetManager.handoffDone(", replay);
    const portal = receiver.indexOf("if (replay && await dungeonPortalWalk(_pcache, replay.path)) walk = null;", replay);
    const resume = receiver.indexOf("resumedWalk = resumeArrivalWalk(wt, walk);", replay);
    expect(portal).toBeGreaterThan(done);
    expect(resume).toBeGreaterThan(portal);
  });

  test("a late gap report's replay takes a portal after its answer, and neither resumes nor stops the walk then", () => {
    const fn = fnOf(receiver, "export async function applyLateGap(");
    const replay = fn.indexOf("replay = await (await import(\"./handlers/movement\")).replayGapSteps(p, plan.steps, applied.from);");
    expect(replay).toBeGreaterThan(-1);
    const answer = fn.indexOf("packetManager.handoffGapDone(", replay);
    const portal = fn.indexOf("if (replay && await dungeonPortalWalk(p, replay.path)) return;", replay);
    const resume = fn.indexOf("resumed = resumeArrivalWalk(wt, walk);", replay);
    expect(portal).toBeGreaterThan(answer);
    expect(resume).toBeGreaterThan(portal);
  });
});

describe("other dungeon wiring", () => {
  test("sending a player out of a copy saves the spot outside first (leaveCopy)", () => {
    const fn = fnOf(dungeons, "export async function sendToPortal(");
    expect(fn).toContain("leaveCopy({");
    expect(fn).toContain("arriveAt: (p, map, at) => player.arriveAt(p.id, map, at)");
  });

  test("the editor guard reads the map the packet names as well as where the player stands", () => {
    expect(read("handlers", "editors.ts")).toContain("if (currentPlayer && editorRefusedInCopy(type, currentPlayer.location?.map, data)) {");
  });
});
