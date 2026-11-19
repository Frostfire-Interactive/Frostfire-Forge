/**
 * Tables whose rows belong to one character (characters.id), not to the account.
 * Account tables keep `username`: accounts, permissions, mutes, whitelist, subscription_*.
 */
export const CHARACTER_TABLES: readonly string[] = [
  "inventory",
  "stats",
  "clientconfig",
  "quest_log",
  "quest_objective_progress",
  "friendslist",
  "ignores",
  "player_home",
  "currency",
  "guild_members",
  "cutscene_views",
  "collectables",
  "learned_spells",
  "equipment",
  "bags",
  "player_achievements",
  "parties",
  "mail",
  "trade_log",
  "reports",
];
