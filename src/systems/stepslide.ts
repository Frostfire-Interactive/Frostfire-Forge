// Where a step ends when it runs into a wall (socket/handlers/movement.ts takeStep).

export type StepCollision = { value?: boolean; reason?: string; [key: string]: unknown } | null | undefined;

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
