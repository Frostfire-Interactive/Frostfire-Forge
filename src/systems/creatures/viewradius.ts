/** px past the view's corners creatures are already sent: they have arrived and faded in before they come on screen. */
export const VIEW_MARGIN_PX = 256;
/** The biggest view creatures are sent for: a bigger screen sees no more of them than a 1920x1080 one. */
export const MAX_VIEW = { w: 1920, h: 1080 };
export const MAX_CREATURE_RADIUS_PX = Math.ceil(Math.hypot(MAX_VIEW.w / 2, MAX_VIEW.h / 2)) + VIEW_MARGIN_PX;

/** The radius creatures are sent within for a view of w x h world pixels around the player (VIEW_SIZE), never under
 *  `base`; null when the view is not two positive numbers. */
export function creatureRadiusFor(view: unknown, base: number): number | null {
  const w = (view as any)?.w, h = (view as any)?.h;
  if (typeof w !== "number" || typeof h !== "number" || !(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  const reach = Math.ceil(Math.hypot(w / 2, h / 2)) + VIEW_MARGIN_PX;
  return Math.min(MAX_CREATURE_RADIUS_PX, Math.max(base, reach));
}
