import { expect, test } from "bun:test";
import { slideStep } from "../systems/stepslide";

// A wall along y < 0: a step that ends above the line runs into it.
const wall = (_x: number, y: number) => (y < 0 ? { value: true, reason: "tile_collision" } : { value: false });
const start = { x: 100, y: 0 };
const upright = { x: 106, y: -6 };

test("a diagonal step into a wall slides a player along it", () => {
  const step = slideStep(start, upright, 6, -6, false, wall);
  expect({ x: step.x, y: step.y, dropped: step.dropped }).toEqual({ x: 106, y: 0, dropped: "y" });
  expect(step.collision?.value).toBe(false);
});

test("a noclip player goes on through a wall on a diagonal", () => {
  const step = slideStep(start, upright, 6, -6, true, wall);
  expect({ x: step.x, y: step.y, dropped: step.dropped }).toEqual({ x: 106, y: -6, dropped: null });
});

test("a straight step into a wall is not slid", () => {
  const step = slideStep(start, { x: 100, y: -6 }, 0, -6, false, wall);
  expect({ x: step.x, y: step.y, dropped: step.dropped }).toEqual({ x: 100, y: -6, dropped: null });
  expect(step.collision?.value).toBe(true);
});
