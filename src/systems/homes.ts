import query from "../controllers/sqldatabase";
import { rowCache, turns } from "../services/datacache";
import { readNpcList } from "./npcStreaming";
import { characterIdOf, needCharacterId } from "./characterids";

/** How long (ms) the home item is cast for. Any damage, and any step, breaks the cast. */
export const HOME_CAST_MS = 10_000;
/** How long (ms) after going home a player can go home again. */
export const HOME_COOLDOWN_MS = 3_600_000;
/** How far (px) a player may stand from an innkeeper and still make the inn their home. The reach of talking to an NPC. */
export const INN_RANGE = 120;

/** A player's home as it is kept: the innkeeper, where they stood from it, and when they last went home (ms; 0: never). */
export interface Home {
  npc_id: number | null;
  offset_x: number;
  offset_y: number;
  used_at: number;
}

/** Where a player arrives, and the name of the inn. */
export interface Arrival {
  map: string;
  x: number;
  y: number;
  inn: string | null;
}

/** What the home rules read of a player. */
export interface Guest {
  username: string;
  isDead?: boolean;
  isGhost?: boolean;
  location?: { map?: string; position?: unknown };
}

const NO_HOME: Home = { npc_id: null, offset_x: 0, offset_y: 0, used_at: 0 };

/** A number as the database handed it back: a BIGINT column comes as text. */
const whole = (value: unknown) => (Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0);

// Each player's home, held under the character's name and kept by its id. One without a row has none, and has never gone home.
const rows = rowCache<Home>("player_home", async (username) => {
  const characterId = await characterIdOf(String(username));
  if (characterId === null) return { ...NO_HOME };
  const [row] = (await query("SELECT npc_id, offset_x, offset_y, used_at FROM player_home WHERE character_id = ?", [characterId])) as any[];
  if (!row) return { ...NO_HOME };
  return {
    npc_id: row.npc_id === null || row.npc_id === undefined ? null : whole(row.npc_id),
    offset_x: whole(row.offset_x),
    offset_y: whole(row.offset_y),
    used_at: whole(row.used_at),
  };
}, { perPlayer: true });

// One write of a player's home at a time: each puts columns on the row held.
const oneAtATime = turns();

/** A statement that changes a player's row, given its values for the character's id. One that throws may still have been applied, so the row held is forgotten. */
async function write(username: string, sql: string, values: (characterId: number) => unknown[], columns: Partial<Home>): Promise<void> {
  await oneAtATime(username, async () => {
    // Read before the write, so the columns go onto a row that is held.
    const before = await homes.of(username);
    try {
      await query(sql, values(await needCharacterId(username)) as any[]);
    } catch (error) {
      await rows.drop(username);
      throw error;
    }
    await rows.set(username, { ...before, ...columns });
  });
}

/** A map's name, with or without the ending its file has. */
const mapName = (map: unknown) => String(map ?? "").replaceAll(".json", "");

/** Where a player stands. A position is kept as an object, or as "x,y". */
function placeOf(player: Guest): { map: string; x: number; y: number } {
  const position = player.location?.position as any;
  const [x, y] = typeof position === "string" ? position.split(",").map(Number) : [Number(position?.x), Number(position?.y)];
  return { map: mapName(player.location?.map), x, y };
}

/** Whether players can make an NPC's inn their home. A hidden NPC is not there to ask. */
export function isInnkeeper(npc: Pick<Npc, "innkeeper" | "hidden"> | null | undefined): boolean {
  return !!npc && !!npc.innkeeper && !npc.hidden;
}

/** Why a player cannot make an NPC's inn their home now, in words for the player. Null when they can. */
export function cannotSetHome(player: Guest, npc: Npc | null | undefined): string | null {
  if (!isInnkeeper(npc)) return "They are not an innkeeper.";
  if (player.isDead || player.isGhost) return "You cannot do that while dead.";
  const here = placeOf(player);
  // Not within reach, which is also what a position that cannot be read comes to.
  const near = Math.hypot(here.x - Number(npc!.position?.x), here.y - Number(npc!.position?.y)) <= INN_RANGE;
  if (here.map !== mapName(npc!.map) || !near) return "You are too far from the innkeeper.";
  return null;
}

const homes = {
  /** A player's home as it is kept. A copy: changing it changes nothing. */
  async of(username: string): Promise<Home> {
    return (await rows.get(username)) ?? { ...NO_HOME };
  },
  async set(player: Guest, npc: Pick<Npc, "id" | "position">): Promise<void> {
    const username = String(player.username).toLowerCase();
    const here = placeOf(player);
    const npc_id = Number(npc.id);
    const offset_x = Math.round(here.x - Number(npc.position?.x)) || 0;
    const offset_y = Math.round(here.y - Number(npc.position?.y)) || 0;
    await write(
      username,
      "INSERT INTO player_home (character_id, npc_id, offset_x, offset_y) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE npc_id = ?, offset_x = ?, offset_y = ?",
      (characterId) => [characterId, npc_id, offset_x, offset_y, npc_id, offset_x, offset_y],
      { npc_id, offset_x, offset_y },
    );
  },
  /** Where a player's home is now. Nothing when they have none, or its innkeeper is gone: the world's spawn is their home then. */
  async where(username: string): Promise<Arrival | null> {
    const home = await homes.of(username);
    if (home.npc_id === null) return null;
    const npc = (await readNpcList()).find((held) => Number(held.id) === home.npc_id);
    if (!npc || !isInnkeeper(npc)) return null;
    return { map: mapName(npc.map), x: Number(npc.position?.x) + home.offset_x, y: Number(npc.position?.y) + home.offset_y, inn: npc.name || null };
  },
  /** How long (ms) until a player can go home again. */
  async cooldownLeft(username: string, now: number = Date.now()): Promise<number> {
    const used = (await homes.of(username)).used_at;
    return used > 0 ? Math.max(0, used + HOME_COOLDOWN_MS - now) : 0;
  },
  /** A player goes home: the hour starts, and where they arrive is answered (see `where`). Throws, with no hour started, when it could not be written. */
  async arrive(username: string, now: number = Date.now()): Promise<Arrival | null> {
    const name = String(username).toLowerCase();
    await write(name, "INSERT INTO player_home (character_id, used_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE used_at = ?", (characterId) => [characterId, now, now], { used_at: now });
    return homes.where(name);
  },
  /** Ends a player's hour at once: an admin reset it. Their home stays. Nothing is written for a player who is not waiting. */
  async clearCooldown(username: string): Promise<void> {
    const name = String(username).toLowerCase();
    if ((await homes.of(name)).used_at === 0) return;
    await write(name, "INSERT INTO player_home (character_id, used_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE used_at = ?", (characterId) => [characterId, 0, 0], { used_at: 0 });
  },
  /** An innkeeper was deleted: nobody's home is there any more, nor at an NPC made later under its id. */
  async innGone(npcId: unknown): Promise<void> {
    const id = Number(npcId);
    if (!Number.isInteger(id)) return;
    try {
      await query("UPDATE player_home SET npc_id = NULL WHERE npc_id = ?", [id]);
    } finally {
      // The statement does not say whose rows it changed.
      await rows.clear();
    }
  },
};

export default homes;
