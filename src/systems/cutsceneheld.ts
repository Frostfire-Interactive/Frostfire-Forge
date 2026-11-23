const REFUSED_WHILE_HELD: ReadonlySet<string> = new Set([
  "TELEPORTXY", "MOUNT", "ATTACK", "CAST_SPELL", "PROJECTILE", "HOTBAR",
  "GATHER", "FISH_CAST", "FISH_REEL", "FISH_LAND",
  "NPC_INTERACT", "VENDOR_OPEN", "VENDOR_BUY", "VENDOR_SELL", "VENDOR_BUYBACK",
  "QUEST_SELECT", "QUEST_ACCEPT", "QUEST_DECLINE", "QUEST_ABANDON", "QUEST_TURN_IN",
  "TRADE_REQUEST", "TRADE_OFFER", "TRADE_ACCEPT",
  "USE_ITEM", "EQUIP_ITEM", "UNEQUIP_ITEM", "SET_HOME",
  "PICKUP_LOOT", "BATCH_PICKUP_LOOT", "OPEN_LOOT_CHEST", "TAKE_CHEST_ITEMS", "TAKE_ALL_CHEST_ITEMS",
  "CREATURE_LOOT", "CREATURE_LOOT_TAKE", "MAIL_OPEN",
]);

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

export function refusedWhileHeld(type: string, data: unknown, player: any): boolean {
  if (!isHeld(player)) return false;
  if (type === "MOVEXY") return String(data).toLowerCase() !== "abort";
  return REFUSED_WHILE_HELD.has(type);
}
