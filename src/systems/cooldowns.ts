import cooldownManager from "../services/cooldownmanager";
import consumables from "./consumables";
import homes from "./homes";
import { dungeonCharacters } from "./dungeons/characterstate";
import { setWarpReadyIn } from "./warpcooldown";

export async function resetCooldowns(player: { username: string; spellCooldowns?: Record<string, number>; spellLockoutUntil?: number }): Promise<void> {
  const username = String(player.username).toLowerCase();
  // Kept under the name the player carries.
  cooldownManager.removePlayer(player.username);
  cooldownManager.removePlayer(username);
  player.spellCooldowns = {};
  player.spellLockoutUntil = 0;
  consumables.clearCooldown(username);
  setWarpReadyIn(username, 0);
  await homes.clearCooldown(username);
  await dungeonCharacters.reset(username);
}
