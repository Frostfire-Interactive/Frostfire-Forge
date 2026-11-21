export const ATTACK_MEMORY_MS = 10_000;

/** victim id -> attacker id -> when the attack landed (performance.now() time). */
const attacks = new Map<string, Map<string, number>>();
/** When the attacks last had their expired entries swept out. */
let lastSweep = 0;

export function recordAttack(attackerId: string | number, victimId: string | number, now = performance.now()): void {
  const attacker = String(attackerId);
  const victim = String(victimId);
  if (attacker === victim) return;
  let byAttacker = attacks.get(victim);
  if (!byAttacker) attacks.set(victim, (byAttacker = new Map()));
  byAttacker.set(attacker, now);
  if (now - lastSweep > ATTACK_MEMORY_MS) sweep(now);
}

/** Drops what is remembered about attacks on a player, for when they leave the node. */
export function forgetVictim(victimId: string | number): void {
  attacks.delete(String(victimId));
}

/** True when `attackerId` attacked `victimId` within the memory. */
export function isRecentAttacker(victimId: string, attackerId: string, now = performance.now()): boolean {
  const byAttacker = attacks.get(String(victimId));
  const at = byAttacker?.get(String(attackerId));
  if (at === undefined) return false;
  if (now - at <= ATTACK_MEMORY_MS) return true;
  byAttacker!.delete(String(attackerId));
  if (byAttacker!.size === 0) attacks.delete(String(victimId));
  return false;
}

export function resetAttacks(): void {
  attacks.clear();
  lastSweep = 0;
}

function sweep(now: number): void {
  lastSweep = now;
  for (const [victim, byAttacker] of attacks) {
    for (const [attacker, at] of byAttacker) if (now - at > ATTACK_MEMORY_MS) byAttacker.delete(attacker);
    if (byAttacker.size === 0) attacks.delete(victim);
  }
}
