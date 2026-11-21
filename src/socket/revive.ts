import log from "../modules/logger";

export interface ReviveDeps {
  clearSickness(target: any): void;
  synchronizeStats(username: string): Promise<any>;
  /** Writes the death state "alive" (player.setDeadState(username, 0, null)). */
  setDeadState(username: string): Promise<unknown>;
  /** playerCache.set(target.id, target). */
  keep(target: any): void;
  bumpStateRevision(): void;
  viewersOn(map: string): any[];
  send(viewer: any, packets: any[]): void;
  ghostPacket(target: any): any[];
  revivePacket(target: any): any[];
  /** Cluster mode: the same packets to the viewers of the target's mirrors on neighbouring nodes. */
  relay(target: any, packets: any[]): void;
  broadcastEffects(target: any): void;
  sendPartyStats(target: any): void;
  /** Emits PLAYER_REVIVED. */
  revived(target: any): void;
}

export type ReviveResult = "revived" | "not-dead";

export async function revivePlayer(target: any, deps: ReviveDeps, beforeRevived?: () => void): Promise<ReviveResult> {
  if (!target.isDead && !target.isGhost) return "not-dead";
  target.isDead = false;
  target.isGhost = false;
  target.corpse = null;
  target.reviveOffered = false;
  target.ghostTeleportPending = false;
  deps.clearSickness(target);
  const synced = await deps.synchronizeStats(target.username);
  if (synced) target.stats = synced;
  target.stats.health = target.stats.total_max_health;
  target.stats.stamina = target.stats.total_max_stamina;
  deps.keep(target);
  try {
    await deps.setDeadState(target.username);
  } catch (e: any) {
    log.error(`Failed to clear death state for ${target.username}: ${e?.message || e}`);
  }
  deps.bumpStateRevision();
  for (const viewer of deps.viewersOn(target.location.map)) {
    deps.send(viewer, deps.ghostPacket(target));
    deps.send(viewer, deps.revivePacket(target));
  }
  deps.relay(target, [...deps.ghostPacket(target), ...deps.revivePacket(target)]);
  deps.broadcastEffects(target);
  deps.sendPartyStats(target);
  beforeRevived?.();
  deps.revived(target);
  return "revived";
}
