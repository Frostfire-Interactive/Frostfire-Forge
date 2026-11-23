/** WoW (Classic) attack tables and mitigation. Pure functions, RNG injected. */
import type { Rng } from "./constants";

export type MeleeOutcome = "miss" | "dodge" | "parry" | "glancing" | "crit" | "crush" | "hit";

export interface AttackRoll {
  outcome: MeleeOutcome;
  /** Damage multiplier for the outcome (0 for avoided attacks). */
  multiplier: number;
}

/** Weapon/defense skill is 5 per level. */
const SKILL_PER_LEVEL = 5;

const clampPct = (v: number) => Math.max(0, Math.min(100, v));

export interface CreatureAttackTable {
  miss: number;
  dodge: number;
  parry: number;
  crit: number;
  crush: number;
}

export function creatureVsPlayerTable(creatureLevel: number, playerLevel: number, playerDodgePct: number, playerFacing: boolean): CreatureAttackTable {
  const d = creatureLevel - playerLevel;
  const skillDiff = d * SKILL_PER_LEVEL;
  return {
    miss: clampPct(5 - skillDiff * 0.04),
    dodge: playerFacing ? clampPct(playerDodgePct - skillDiff * 0.04) : 0,
    parry: 0,
    crit: clampPct(5 + skillDiff * 0.04),
    // Crushing blows need a 15+ skill advantage (3 levels): 2% per skill point - 15%.
    crush: skillDiff >= 15 ? clampPct(skillDiff * 2 - 15) : 0,
  };
}

export function rollCreatureVsPlayer(table: CreatureAttackTable, r: Rng): AttackRoll {
  const roll = r() * 100;
  let edge = table.miss;
  if (roll < edge) return { outcome: "miss", multiplier: 0 };
  if (roll < (edge += table.dodge)) return { outcome: "dodge", multiplier: 0 };
  if (roll < (edge += table.parry)) return { outcome: "parry", multiplier: 0 };
  if (roll < (edge += table.crit)) return { outcome: "crit", multiplier: 2 };
  if (roll < (edge += table.crush)) return { outcome: "crush", multiplier: 1.5 };
  return { outcome: "hit", multiplier: 1 };
}

/** Spell hit vs level difference: 96/95/94% at +0/+1/+2, then -11% per level. */
export function spellMissChance(casterLevel: number, targetLevel: number): number {
  const d = targetLevel - casterLevel;
  if (d <= 0) return 4;
  if (d <= 2) return 4 + d;
  return Math.min(99, 6 + (d - 2) * 11);
}

/** Players store armor as a direct percentage (engine convention), capped at 75%. */
export function playerArmorReduction(statArmor: number): number {
  return Math.min(75, Math.max(0, statArmor || 0)) / 100;
}
