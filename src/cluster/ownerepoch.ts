import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import type { PlayerDirectory } from "./directory";

// One writer per player (spec §7). The directory epoch a node claimed a player under is also the player's owner
// epoch in the database: the claim raises accounts.owner_epoch to it (never lowers it), and every save of the player
// in cluster mode is `... WHERE id = ? AND owner_epoch = ?` on the account (player.saveFenced). The epoch is the
// account's, by its id: one account plays one character at a time, so a login of any of its characters fences the
// saves of the others. A node that lost the player
// (a handoff, a newer login, its blocks given away while it stalled) holds an older epoch, so its saves change
// nothing. This replaces the session-stolen check for players whose epoch is held.
//
// The directory's counters live in Redis. A Redis that lost them hands out low epochs again, below what the database
// holds: a claim refused that way is lifted (the counter is raised past the stored epoch) when the directory still
// names this node and this session for the player. A claim refused for any other reason means another node owns the
// player now: this session ends.

const changed = (response: any) => !(response && typeof response === "object" && "affectedRows" in response && Number(response.affectedRows ?? response.count) === 0);

/**
 * Raises account `accountId`'s owner epoch to `epoch`: "raised", or "same" when it holds that epoch already, or
 * "refused" when it holds a higher one (or the account is gone).
 */
async function raiseOwnerEpoch(accountId: number, epoch: number): Promise<"raised" | "same" | "refused"> {
  const response = await query("UPDATE accounts SET owner_epoch = ? WHERE id = ? AND owner_epoch < ?", [epoch, accountId, epoch]);
  if (changed(response)) return "raised";
  return (await storedOwnerEpoch(accountId)) === epoch ? "same" : "refused";
}

/** Raises account `accountId`'s owner epoch to `epoch`. False when it holds a higher one (or the account is gone). */
export async function claimOwnerEpoch(accountId: number, epoch: number): Promise<boolean> {
  // The same epoch claimed again (a re-run of the same claim) changes no row, and is still this claim's.
  return (await raiseOwnerEpoch(accountId, epoch)) !== "refused";
}

/** Account `accountId`'s owner epoch; null for no account. */
export async function storedOwnerEpoch(accountId: number): Promise<number | null> {
  const rows = (await query("SELECT owner_epoch, saved_at FROM accounts WHERE id = ?", [accountId])) as any[];
  return rows?.[0] ? Number(rows[0].owner_epoch) || 0 : null;
}

export interface OwnerEpochDeps {
  directory: Pick<PlayerDirectory, "get" | "lift" | "release" | "nodeId">;
  /**
   * Ends this player's session here: closes only `player`'s own connection and cleans up that row, as the SAVE loop's
   * owner-epoch refusal does. Never player.kick by username: that logs out whichever session the name has here now,
   * which may be a newer one.
   */
  kick(player: any, why: string): void;
}

/**
 * Takes the owner epoch for a player who just logged in here under directory epoch `epoch`. Sets player.ownerEpoch
 * and answers it (a lifted epoch is higher than the one given); null when it was not taken, and the player is kicked.
 * A guest has no rows to fence: null, and nothing is asked.
 */
export async function adoptOwnerEpoch(player: any, epoch: number, deps: OwnerEpochDeps): Promise<number | null> {
  const username = String(player?.username ?? "");
  const accountId = Number(player?.accountId);
  if (!username || player?.isGuest) return null;
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    log.error(`Owner epoch for ${username} not taken: the player carries no account id, so its saves are not fenced`);
    return null;
  }
  // The directory counts each character's epochs on its own, and the epoch is the account's: "same" may be another
  // character's claim of that number, never this one's, so it is lifted below like a refusal.
  if ((await raiseOwnerEpoch(accountId, epoch)) === "raised") {
    player.ownerEpoch = epoch;
    return epoch;
  }
  const entry = await deps.directory.get(username);
  const ours = !!entry && entry.nodeId === deps.directory.nodeId && entry.epoch === epoch && entry.playerId === String(player.id);
  if (ours) {
    const floor = (await storedOwnerEpoch(accountId)) ?? 0;
    const lifted = await deps.directory.lift(username, floor, entry!);
    if (lifted !== null && lifted > floor && (await raiseOwnerEpoch(accountId, lifted)) === "raised") {
      log.info(`Owner epoch of ${username} lifted from ${epoch} to ${lifted}: the directory counter was behind the account's (another of its characters, or a Redis that lost its counters)`);
      player.ownerEpoch = lifted;
      return lifted;
    }
    // The entry was lifted but the database went higher meanwhile: the lifted entry names this node, and presence
    // releases only the claimed epoch, so it is released here before the kick.
    if (lifted !== null) {
      await deps.directory.release(username, lifted)
        .catch((error) => log.error(`Directory release of ${username} at lifted epoch ${lifted} failed: ${error}`));
    }
  }
  log.warn(`Owner epoch ${epoch} of ${username} was refused: another node owns the player, so this session ends`);
  deps.kick(player, "owner");
  return null;
}

/** A cluster save of this player goes through player.saveFenced: its owner epoch is held. */
export function fencedSaves(player: any): boolean {
  return typeof player?.ownerEpoch === "number" && player.ownerEpoch > 0;
}
