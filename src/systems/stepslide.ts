// Where a step ends when it runs into a wall (socket/handlers/movement.ts takeStep).

export type StepCollision = { value?: boolean; reason?: string; [key: string]: unknown } | null | undefined;

/**
 * A diagonal step into a wall only loses the blocked axis: the player slides along the open one (e.g. moving upright
 * under a wall keeps going right) instead of stopping. Diagonal is read from the offset (stepX, stepY), not this
 * tick's move: above 30 Hz a slow step can move 0 px on one axis for a tick, and that tick's slide is then just no move.
 * A noclip player is never slid: they walk on through on both axes.
 * Returns where the step ends, what it runs into there, and which axis was dropped (it carries nothing on).
 */
export function slideStep(
  start: { x: number; y: number },
  target: { x: number; y: number },
  stepX: number,
  stepY: number,
  isNoclip: boolean,
  checkAt: (x: number, y: number) => StepCollision,
): { x: number; y: number; collision: StepCollision; dropped: "x" | "y" | null } {
  const collision = checkAt(target.x, target.y);
  if (isNoclip || collision?.reason !== "tile_collision" || Math.round(stepX) === 0 || Math.round(stepY) === 0) {
    return { x: target.x, y: target.y, collision, dropped: null };
  }
  for (const slide of [{ x: target.x, y: start.y }, { x: start.x, y: target.y }]) {
    const slideCollision = checkAt(slide.x, slide.y);
    if (slideCollision?.reason !== "tile_collision") {
      return { x: slide.x, y: slide.y, collision: slideCollision, dropped: slide.y === start.y ? "y" : "x" };
    }
  }
  return { x: target.x, y: target.y, collision, dropped: null };
}
