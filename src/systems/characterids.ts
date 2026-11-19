import query from "../controllers/sqldatabase";
import playerCache from "../services/playermanager";
import { nameKey } from "./characterstore";

// The characters.id of a character, by its name. A character's rows (inventory, stats, quests and the rest) are kept
// by that id; the systems that hold them know a player by name (their copies of the rows, and their turns, are kept
// under it), so each statement they send is given the id this answers for the name.
//
// Nothing is kept here between asks. A player online carries its own id, which is the answer while it is online; for
// any other name the database is asked each time. A name can pass to another character (a deleted character's name
// is freed), so an id kept for a name could be a character that is gone, and its rows another's.

/** Whether `id` is a characters.id as given (a whole number above 0). */
const isId = (id: unknown): id is number => Number.isInteger(Number(id)) && Number(id) > 0;

/**
 * The id of the character named `name`: the player online under that name, else the database (a character that is
 * not deleted). Null when there is no such character.
 */
export async function characterIdOf(name: string | null | undefined): Promise<number | null> {
  if (!name) return null;
  const key = nameKey(name);
  const online = (playerCache as any)?.getByUsername?.(key);
  if (online && isId(online.characterId)) return Number(online.characterId);
  const rows = (await query("SELECT id FROM characters WHERE name_key = ? AND deleted_at IS NULL LIMIT 1", [key])) as any[];
  const id = Array.isArray(rows) ? rows[0]?.id : undefined;
  return isId(id) ? Number(id) : null;
}

/**
 * The username of the account the character named `name` belongs to, lower case: what the account's own tables
 * (permissions, mutes) are kept by. The player online under that name first, then the database. Null for a name that
 * is no character's (not deleted): a name is never taken as an account's own username, since a freed name can be
 * given to a character of another account. Never shown to players.
 */
export async function accountNameOf(name: string | null | undefined): Promise<string | null> {
  if (!name) return null;
  const key = nameKey(name);
  const online = (playerCache as any)?.getByUsername?.(key);
  if (online?.accountUsername) return String(online.accountUsername).toLowerCase();
  const rows = (await query(
    "SELECT a.username FROM characters c JOIN accounts a ON a.id = c.account_id WHERE c.name_key = ? AND c.deleted_at IS NULL LIMIT 1",
    [key]
  )) as any[];
  const found = Array.isArray(rows) ? rows[0]?.username : undefined;
  return found ? String(found).toLowerCase() : null;
}

/** The names of every character (not deleted) of the account the character named `name` belongs to, itself among them. */
export async function siblingNamesOf(name: string | null | undefined): Promise<string[]> {
  if (!name) return [];
  const rows = (await query(
    "SELECT o.name FROM characters c JOIN characters o ON o.account_id = c.account_id WHERE c.name_key = ? AND c.deleted_at IS NULL AND o.deleted_at IS NULL ORDER BY o.id",
    [nameKey(name)]
  )) as any[];
  const names = Array.isArray(rows) ? rows.map((row) => String(row.name)) : [];
  return names.length ? names : [String(name)];
}

/**
 * The names characters (not deleted) go by now, for `names` as they were kept (any case): by each name's lower case.
 * A name that is no character's has no entry.
 */
export async function currentNames(names: string[]): Promise<Map<string, string>> {
  const keys = [...new Set(names.map((name) => nameKey(String(name ?? "").trim())).filter(Boolean))];
  const found = new Map<string, string>();
  if (!keys.length) return found;
  const rows = (await query(
    `SELECT name_key, name FROM characters WHERE deleted_at IS NULL AND name_key IN (${keys.map(() => "?").join(", ")})`,
    keys
  )) as any[];
  for (const row of Array.isArray(rows) ? rows : []) found.set(String(row.name_key), String(row.name));
  return found;
}

/** An error a write throws for a name that is no character's: nothing is written for it. */
export class NoSuchCharacter extends Error {
  constructor(name: string) {
    super(`There is no character named ${name}`);
    this.name = "NoSuchCharacter";
  }
}

/** characterIdOf for a write: a name that is no character's throws NoSuchCharacter. */
export async function needCharacterId(name: string | null | undefined): Promise<number> {
  const id = await characterIdOf(name);
  if (id === null) throw new NoSuchCharacter(String(name ?? ""));
  return id;
}

/** The names of every character (not deleted) of account `accountId`. None for an id that is no account's. */
export async function accountCharacterNames(accountId: number): Promise<string[]> {
  if (!isId(accountId)) return [];
  const rows = (await query("SELECT name FROM characters WHERE account_id = ? AND deleted_at IS NULL ORDER BY id", [Number(accountId)])) as any[];
  return Array.isArray(rows) ? rows.map((row) => String(row.name)) : [];
}
