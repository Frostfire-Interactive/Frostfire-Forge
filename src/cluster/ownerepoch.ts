import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import type { PlayerDirectory } from "./directory";

const changed = (response: any) => !(response && typeof response === "object" && "affectedRows" in response && Number(response.affectedRows ?? response.count) === 0);

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
  kick(player: any, why: string): void;
}

export async function adoptOwnerEpoch(player: any, epoch: number, deps: OwnerEpochDeps): Promise<number | null> {
  const username = String(player?.username ?? "");
  const accountId = Number(player?.accountId);
  if (!username || player?.isGuest) return null;
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    log.error(`Owner epoch for ${username} not taken: the player carries no account id, so its saves are not fenced`);
    return null;
  }
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
