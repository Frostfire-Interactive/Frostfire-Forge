import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { summonSpot, targetProblem } from "../socket/summonstones";

// The summoning stone runtime (socket/summonstones.ts) and its answer in INVITATION_RESPONSE (handlers/social.ts).

const social = readFileSync(join(import.meta.dir, "..", "socket", "handlers", "social.ts"), "utf8");

/** The `case "INVITATION_RESPONSE"` body, up to the next case label. */
function invitationResponse(): string {
    const start = social.indexOf('case "INVITATION_RESPONSE": {');
    expect(start).toBeGreaterThan(-1);
    const next = social.slice(start + 30).search(/\n\s*case "/);
    return social.slice(start, next < 0 ? undefined : start + 30 + next);
}

describe("summonSpot and targetProblem", () => {
    test("the summon spot is just below the foot, facing down", () => {
        expect(summonSpot({ map: "town", x: 100, y: 200 })).toEqual({ map: "town", x: 100, y: 208, direction: "down" });
    });
    test("a dead or ghost target is refused", () => {
        expect(targetProblem({ username: "cat", isGhost: true, location: { map: "town" } }, false)).toBe("Cat is dead.");
        expect(targetProblem({ username: "cat", isDead: true, location: { map: "town" } }, false)).toBe("Cat is dead.");
    });
    test("a target in a dungeon copy is refused", () => {
        expect(targetProblem({ username: "cat", location: { map: "crypt~3" } }, false)).toBe("Cat is inside a dungeon.");
        expect(targetProblem({ username: "cat", location: { map: "town" } }, true)).toBe("Cat is inside a dungeon.");
    });
    test("a target who is not online is refused by name; a fit one is not", () => {
        expect(targetProblem(null, false, "cat")).toBe("Cat is not online.");
        expect(targetProblem({ username: "cat", location: { map: "town" } }, false)).toBeNull();
    });
});

describe("answering the offer", () => {
    test("Review Focus 3: accepting re-checks the target", () => {
        const body = invitationResponse();
        const start = body.indexOf('action.toUpperCase() === "SUMMON_STONE"');
        expect(start).toBeGreaterThan(-1);
        const branch = body.slice(start, body.indexOf("const inviterGone"));
        const move = branch.indexOf("summonMove(");
        expect(move).toBeGreaterThan(-1);
        expect(branch.indexOf("targetProblem(")).toBeGreaterThan(-1);
        expect(branch.indexOf("targetProblem(")).toBeLessThan(move);
        expect(branch.indexOf("heldInScene(")).toBeGreaterThan(-1);
        expect(branch.indexOf("heldInScene(")).toBeLessThan(move);
        expect(branch).toContain("release(");
    });
    test("a target held in a cutscene is refused: the summoner is told, the target sees no admin command", () => {
        const body = invitationResponse();
        const branch = body.slice(body.indexOf('action.toUpperCase() === "SUMMON_STONE"'), body.indexOf("const inviterGone"));
        expect(branch).toContain("is in a cutscene.");
        expect(branch).not.toContain("heldNote");
        expect(branch).not.toContain("/cutscene");
    });
    test("the SUMMON_STONE branch runs before the inviter-online check", () => {
        const body = invitationResponse();
        expect(body.indexOf('"SUMMON_STONE"')).toBeGreaterThan(-1);
        expect(body.indexOf('"SUMMON_STONE"')).toBeLessThan(body.indexOf("user not found or has disconnected"));
        expect(body.indexOf('"SUMMON_STONE"')).toBeLessThan(body.indexOf("isOnline(invite.originatorName)"));
    });
});

describe("routing", () => {
    test("a touch reaches the stone code, with the party's live members and the target", () => {
        const stones = readFileSync(join(import.meta.dir, "..", "socket", "summonstones.ts"), "utf8");
        expect(social).toContain("touchStone(currentPlayer, data)");
        expect(social).not.toContain("SUMMON_STONE_PICK");
        expect(stones).toContain("touch(was, me, stone, Date.now(), matesOf(p), lower(data?.target) || null)");
    });
});
