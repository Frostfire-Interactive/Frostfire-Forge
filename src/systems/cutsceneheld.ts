/**
 * Whether a player is held in a cutscene, and which of their packets a held player is refused. This is a leaf on
 * purpose: the packet receiver and the damage paths (creatures, spells, tornadoes) ask it, and none of them should
 * pull the scene store and the player sessions in with it. The sessions themselves are systems/cutsceneplayer.ts.
 */

/**
 * The packets a client sends that act on the world: moving, fighting, using, taking, talking to an NPC, trading. A
 * held player is refused all of them; chat, PING and PONG, the editors, logout and the CUTSCENE_* packets still
 * flow. MOVEXY is not here: it is refused unless it is the stop ("abort"), see refusedWhileHeld.
 */
const REFUSED_WHILE_HELD: ReadonlySet<string> = new Set([
  "TELEPORTXY", "MOUNT", "ATTACK", "CAST_SPELL", "PROJECTILE", "HOTBAR", "CREATURE_ATTACK",
  "GATHER", "FISH_CAST", "FISH_REEL", "FISH_LAND",
  "NPC_INTERACT", "VENDOR_OPEN", "VENDOR_BUY", "VENDOR_SELL", "VENDOR_BUYBACK",
  "QUEST_SELECT", "QUEST_ACCEPT", "QUEST_DECLINE", "QUEST_ABANDON", "QUEST_TURN_IN",
  "TRADE_REQUEST", "TRADE_OFFER", "TRADE_ACCEPT",
  "USE_ITEM", "EQUIP_ITEM", "UNEQUIP_ITEM", "SET_HOME",
  "PICKUP_LOOT", "BATCH_PICKUP_LOOT", "OPEN_LOOT_CHEST", "TAKE_CHEST_ITEMS", "TAKE_ALL_CHEST_ITEMS",
  "CREATURE_LOOT", "CREATURE_LOOT_TAKE", "MAIL_OPEN",
]);

/**
 * Whether the player is held still and out of harm's way: their scene locks them and its clock has not run out. The
 * clock is compared by time, not by a timer firing: a lock must end by itself even if every timer failed.
 */
export function isHeld(player: any, now: number = Date.now()): boolean {
  const scene = player?.cutscene;
  if (!scene || scene.phase === "done" || !scene.lock) return false;
  return now < scene.clockEndsAt;
}

/** What the admin named `admin` is told when a command of theirs would act on a held player. */
export function heldNote(target: any, admin: string): string {
  const name = String(target.username);
  if (name.toLowerCase() === admin.toLowerCase()) return "You are in a cutscene; /cutscene stop ends it";
  return `${name.charAt(0).toUpperCase() + name.slice(1)} is in a cutscene; /cutscene stop ${name} ends it`;
}

/**
 * Whether a packet from this player is refused because they are held. Only a held player is ever refused; their stop
 * ("abort", sent when a key is let go) is let through so the walk it ends is ended.
 */
export function refusedWhileHeld(type: string, data: unknown, player: any): boolean {
  if (!isHeld(player)) return false;
  if (type === "MOVEXY") return String(data).toLowerCase() !== "abort";
  return REFUSED_WHILE_HELD.has(type);
}
