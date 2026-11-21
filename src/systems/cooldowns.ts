import cooldownManager from "../services/cooldownmanager";
import consumables from "./consumables";
import homes from "./homes";

export async function resetCooldowns(player: { username: string; spellCooldowns?: Record<string, number>; spellLockoutUntil?: number }): Promise<void> {
  const username = String(player.username).toLowerCase();
  // Kept under the name the player carries.
  cooldownManager.removePlayer(player.username);
  cooldownManager.removePlayer(username);
  player.spellCooldowns = {};
  player.spellLockoutUntil = 0;
  consumables.clearCooldown(username);
  await homes.clearCooldown(username);
}
