import log from "../modules/logger";
import { chooseNewer, type SavedSnapshot } from "./snapshots";

/** How long the reads may take before the login goes on from the row: a stalled store never holds a login. */
export const RECOVERY_READ_MS = 1_000;

export interface RecoveryDeps {
  stamp(username: string): Promise<{ ownerEpoch: number; savedAt: number } | null>;
  snapshot(username: string): Promise<SavedSnapshot | null>;
  /** Whether this node has the map (bare name). */
  knownMap(map: string): boolean;
  /** The bound on the snapshot read: RECOVERY_READ_MS unless a test sets it. */
  readMs?: number;
}

const clamp = (value: number, most: number) => Math.max(0, Math.min(value, most));
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** The snapshot read, or "late" when it takes longer than `ms`. A late answer is dropped (the race handles a late rejection). */
function bounded(read: Promise<SavedSnapshot | null>, ms: number): Promise<SavedSnapshot | null | "late"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ms);
    (timer as any)?.unref?.();
  });
  return Promise.race([read, late]).finally(() => clearTimeout(timer));
}

/** Plays the login from the snapshot when it is newer than the last save: sets location and stats. Answers the snapshot used, or null. Never throws. */
export async function recoverLogin(playerData: any, deps: RecoveryDeps): Promise<SavedSnapshot | null> {
  const username = typeof playerData?.username === "string" ? playerData.username : "";
  if (!username) return null;
  let stamp: { ownerEpoch: number; savedAt: number } | null;
  let read: SavedSnapshot | null | "late";
  try {
    [stamp, read] = await Promise.all([deps.stamp(username), bounded(deps.snapshot(username), deps.readMs ?? RECOVERY_READ_MS)]);
  } catch (error) {
    log.error(`Login of ${username}: the snapshot could not be read, so the saved row is used: ${error}`);
    return null;
  }
  if (read === "late") {
    log.warn(`Login of ${username}: the snapshot was not read within ${deps.readMs ?? RECOVERY_READ_MS} ms, so the saved row is used`);
    return null;
  }
  const chosen = chooseNewer(stamp, read);
  if (!chosen) return null;
  if (chosen.username !== username.toLowerCase()) return null;
  if (!deps.knownMap(chosen.map)) {
    log.warn(`Login of ${username}: the snapshot is on ${chosen.map}, which this node does not have, so the saved row is used`);
    return null;
  }
  const stats = chosen.stats;
  if (stats && (!positive(stats.max_health) || !positive(stats.max_stamina))) {
    log.warn(`Login of ${username}: the snapshot has a maximum of 0 or less, so it is not used and the saved row is`);
    return null;
  }
  playerData.location = { map: chosen.map, position: { x: chosen.x, y: chosen.y, direction: chosen.direction } };
  const row = playerData.stats;
  const rowMaxHealth = Number(row?.max_health);
  const rowMaxStamina = Number(row?.max_stamina);
  // A row with no stats (or no maximums) has NaN here and keeps what it has.
  if (stats && stats.health > 0 && positive(rowMaxHealth) && positive(rowMaxStamina)) {
    // The row's maximums stay: they are never older than the snapshot's.
    row.health = clamp(stats.health, Math.min(stats.max_health, rowMaxHealth));
    row.stamina = clamp(stats.stamina, Math.min(stats.max_stamina, rowMaxStamina));
  }
  log.info(`Login of ${username} plays from the snapshot of epoch ${chosen.epoch} at ${chosen.at}, newer than the last save at ${stamp!.savedAt}`);
  return chosen;
}
