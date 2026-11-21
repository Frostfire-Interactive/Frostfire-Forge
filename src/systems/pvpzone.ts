type Point = { x: number; y: number };

/** Whether PvP is allowed for a character standing at a position (player.isInPvPZone on the spell's map). */
export type PvpAllowed = (position: Point) => Promise<boolean>;

/** The character box the zone is asked with; player.canAttack is called with the same. */
export const PVP_BODY = { width: 24, height: 40 };

export function pvpEnabled(): boolean {
  return process.env.PVP?.trim().toLowerCase() !== "false";
}

export async function targetedCastRefused(harmful: boolean, caster: Point, target: Point, allowed: PvpAllowed): Promise<boolean> {
  if (!harmful) return false;
  return !(await allowed(target)) || !(await allowed(caster));
}

export async function areaCastRefusal(caster: Point, aim: Point | null, allowed: PvpAllowed): Promise<"caster" | "aim" | null> {
  if (!(await allowed(caster))) return "caster";
  if (aim && !(await allowed(aim))) return "aim";
  return null;
}

export async function areaSpellHarms(caster: Point | undefined, victim: Point, allowed: PvpAllowed): Promise<boolean> {
  if (!pvpEnabled()) return false;
  if (caster && !(await allowed(caster))) return false;
  return allowed(victim);
}
