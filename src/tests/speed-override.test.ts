import { expect, test } from "bun:test";
import { overriddenSpeed, MAX_SPEED_OVERRIDE } from "../systems/speedoverride";

test("no /speed leaves the speed as usual", () => {
  expect(overriddenSpeed({}, 6)).toBeNull();
  expect(overriddenSpeed({ speedOverride: undefined }, 6)).toBeNull();
  expect(overriddenSpeed({ speedOverride: 0 }, 6)).toBeNull();
});

test("/speed is a multiple of the base step, whatever else the player has", () => {
  expect(overriddenSpeed({ speedOverride: 2 }, 6)).toBe(12);
  expect(overriddenSpeed({ speedOverride: 0.5 }, 6)).toBe(3);
});

test("/speed is held under a tile a step, so a step cannot pass a wall", () => {
  expect(overriddenSpeed({ speedOverride: 100 }, 6)).toBe(6 * MAX_SPEED_OVERRIDE);
  expect(6 * MAX_SPEED_OVERRIDE).toBeLessThan(32);
});
