import { expect, test, describe } from "bun:test";
import gameLoop from "../services/gameloop";

describe("gameLoop movement race contract", () => {
  test("registerMovingPlayer swaps the callback in place for an active mover", async () => {
    const id = "race-test-1";
    const calls: string[] = [];

    gameLoop.registerMovingPlayer(id, async () => { calls.push("first"); });
    expect(gameLoop.isPlayerMoving(id)).toBe(true);

    // Newer MOVEXY generation replaces the callback without dropping the player.
    gameLoop.registerMovingPlayer(id, async () => { calls.push("second"); });
    expect(gameLoop.isPlayerMoving(id)).toBe(true);

    gameLoop.unregisterMovingPlayer(id);
    expect(gameLoop.isPlayerMoving(id)).toBe(false);
    expect(calls).toEqual([]);
  });

  test("a stale callback that force-stops removes the player from the loop", () => {
    const id = "race-test-2";
    const capturedSeq = 5;
    let currentSeq = 5;

    // Simulate the receiver closure: run each tick, bail + unregister if stale.
    const movePlayer = () => {
      if (currentSeq !== capturedSeq) {
        gameLoop.unregisterMovingPlayer(id);
        return "stopped";
      }
      return "stepped";
    };

    gameLoop.registerMovingPlayer(id, async () => { movePlayer(); });
    expect(movePlayer()).toBe("stepped");

    currentSeq = 6;
    expect(movePlayer()).toBe("stopped");
    expect(gameLoop.isPlayerMoving(id)).toBe(false);

    // Cleanup in case the assertion above ever regresses.
    gameLoop.unregisterMovingPlayer(id);
  });
});
