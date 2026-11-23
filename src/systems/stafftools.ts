import * as achievementEditor from "./achievements/editor";
import * as classEditor from "./classeditor";
import * as controlPanel from "./controlpanel";
import * as creatureEditor from "./creatures/editor";
import * as cutsceneEditor from "./cutscenes";
import * as dungeonEditor from "./dungeoneditor";
import * as gatheringEditor from "./gathering/editor";
import * as itemEditor from "./itemeditor";
import * as mailboxEditor from "./mailboxeditor";
import * as mountEditor from "./mounteditor";
import * as playerEditor from "./playereditor";
import * as questEditor from "./quests/editor";
import * as spellEditor from "./spelleditor";
import * as weatherEditor from "./weathereditor";

/** Whether the player holds one of these permissions, as copied at login: the map, particle, NPC and loot commands check only that. */
function holds(player: any, ...names: string[]): boolean {
  const held: string[] = Array.isArray(player?.permissions) ? player.permissions : [];
  return held.some((p) => names.includes(p));
}

/**
 * The tools whose chat command would open for this player, by the same checks the commands make (socket/handlers/commands.ts).
 * It decides nothing: the game's staff bar shows a button for each, and the command it sends is checked again.
 */
const TOOLS: Array<[string, (player: any) => boolean | Promise<boolean>]> = [
  ["control_panel", (p) => controlPanel.canUsePanel(p)],
  ["player_editor", (p) => playerEditor.canUseEditor(p)],
  ["tile_editor", (p) => holds(p, "tools.tile_editor", "tools.*")],
  ["dungeon_editor", (p) => dungeonEditor.canUseEditor(p)],
  ["weather_editor", (p) => weatherEditor.canUseEditor(p)],
  ["gathering_editor", (p) => gatheringEditor.canUseEditor(p)],
  ["mailbox_editor", (p) => mailboxEditor.canUseEditor(p)],
  ["npc_editor", (p) => holds(p, "tools.npc_editor", "tools.*")],
  ["creature_editor", (p) => creatureEditor.canUseEditor(p)],
  ["item_editor", (p) => itemEditor.canUseEditor(p)],
  ["loot_editor", (p) => holds(p, "admin.loot", "admin.*")],
  ["spell_editor", (p) => spellEditor.canUseEditor(p)],
  ["class_editor", (p) => classEditor.canUseEditor(p)],
  ["mount_editor", (p) => mountEditor.canUseEditor(p)],
  ["quest_editor", (p) => questEditor.canUseEditor(p)],
  ["achievement_editor", (p) => achievementEditor.canUseEditor(p)],
  ["particle_editor", (p) => holds(p, "tools.particle_editor", "tools.*")],
  ["cutscene_editor", (p) => cutsceneEditor.canUseEditor(p)],
];

/** The ids of the tools the player may open. None for a guest, whom the server takes no chat command from. Never throws. */
export async function staffToolsFor(player: any): Promise<string[]> {
  if (!player?.username || player.isGuest) return [];
  // Every tool asks for the admin role or a permission: a player with neither, as most are, is not asked of the database.
  if (!player.isAdmin && !(Array.isArray(player.permissions) && player.permissions.some(Boolean))) return [];
  const allowed = await Promise.all(TOOLS.map(async ([, may]) => {
    try {
      return !!(await may(player));
    } catch {
      return false;
    }
  }));
  return TOOLS.filter((_, i) => allowed[i]).map(([id]) => id);
}
