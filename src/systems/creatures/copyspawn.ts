import { bareName as bare } from "../dungeons/copykey";
import { scaledMaxHealth } from "../dungeons/rules";
import type { ModeMultiplier } from "../dungeons/types";
import { createAuras } from "./auras";
import { rng, type Rng } from "./constants";
import { computeMaxHealth, pickTemplateId, rollLevel } from "./spawner";
import { createCombatState } from "./threat";
import { AIState, type CreatureInstance, type CreatureSpawn, type CreatureSpawnPool, type CreatureTemplate } from "./types";

/** The template map's spawns as live creatures of one copy, scaled by the mode. Not tied to a spawn slot: they never respawn. */
export function copyInstances(
  spawns: CreatureSpawn[],
  templates: Map<number, CreatureTemplate>,
  template: string,
  key: string,
  mult: ModeMultiplier,
  nextId: () => number,
  opts: { pools?: Map<number, CreatureSpawnPool>; r?: Rng; now?: number } = {},
): CreatureInstance[] {
  const r = opts.r ?? rng;
  const now = opts.now ?? Date.now();
  const rareSeen = new Set<number>();
  const out: CreatureInstance[] = [];
  for (const spawn of spawns) {
    if (bare(spawn.map) !== bare(template)) continue;
    const pool = spawn.pool_id !== null ? opts.pools?.get(spawn.pool_id) : undefined;
    const t = templates.get(pickTemplateId(spawn, pool, pool ? rareSeen.has(pool.id) : false, r)) ?? templates.get(spawn.template_id);
    if (!t) continue;
    if (pool && t.id === pool.rare_template_id) rareSeen.add(pool.id);
    const level = rollLevel(t, r);
    const maxHealth = scaledMaxHealth(computeMaxHealth(t, level), mult.health);
    out.push({
      id: nextId(),
      templateId: t.id,
      spawnId: 0,
      copySpawnId: spawn.id,
      poolId: null,
      map: key,
      layerId: null,
      x: spawn.x,
      y: spawn.y,
      dir: spawn.direction,
      homeX: spawn.x,
      homeY: spawn.y,
      level,
      health: maxHealth,
      maxHealth,
      state: AIState.IDLE,
      spawnedAt: now,
      move: null,
      waitUntil: now + Math.floor(r() * 3000),
      patrolIndex: 0,
      patrolForward: true,
      sentX: spawn.x,
      sentY: spawn.y,
      sentDir: spawn.direction,
      sentMoving: false,
      combat: createCombatState(),
      auras: createAuras(),
      casting: null,
      abilityStates: new Map(),
      damageMult: mult.damage,
    });
  }
  return out;
}

/** A copy of the spell with its damage-over-time amounts multiplied; a spell's direct damage is scaled where it lands. */
export function scaleSpellDamage<T extends { effects?: Array<{ type: string; value: number }> }>(spell: T, mult: number): T {
  if (mult === 1 || !Array.isArray(spell.effects)) return spell;
  return {
    ...spell,
    effects: spell.effects.map((e) => (e?.type === "damage_over_time" ? { ...e, value: Math.round(Number(e.value) * mult * 100) / 100 } : e)),
  };
}

export function bossCount(instances: CreatureInstance[], templates: Map<number, CreatureTemplate>): number {
  let n = 0;
  for (const c of instances) if (templates.get(c.templateId)?.rank === "boss") n++;
  return n;
}
