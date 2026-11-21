import query from "../controllers/sqldatabase";
import { rowCache, turns } from "../services/datacache";
import { characterIdOf, needCharacterId } from "./characterids";
import { characterByName } from "./characterstore";
import player from "./player";

/** The most players one player ignores. */
export const IGNORE_LIMIT = 100;

/** What became of asking to ignore someone. "staff": the one asking is an admin. "admin": the one named is. */
export type IgnoreResult = "added" | "already" | "self" | "unknown" | "full" | "staff" | "admin";

const rows = rowCache<string[]>("ignores", async (username) => {
  const id = await characterIdOf(username);
  if (id === null) return [];
  return ((await query("SELECT ignored FROM ignores WHERE character_id = ? ORDER BY created_at", [id])) as { ignored: string }[] || []).map((row) => lower(row.ignored));
}, { perPlayer: true });

const oneAtATime = turns();

const lower = (username: string) => String(username ?? "").toLowerCase();

function change<T>(username: string, work: (held: string[]) => Promise<T>): Promise<T> {
  return oneAtATime(username, async () => {
    try {
      return await work((await rows.get(username)) ?? []);
    } catch (error) {
      await rows.drop(username);
      throw error;
    }
  });
}

const ignores = {
  /** The names a player ignores. */
  async list(username: string): Promise<string[]> {
    const name = lower(username);
    return name ? (await rows.get(name)) ?? [] : [];
  },
  /** Whether `other` is on a player's list. Whether that holds anything back is `blocks`. */
  async isIgnoring(username: string, other: string): Promise<boolean> {
    return (await ignores.list(username)).includes(lower(other));
  },
  async blocks(recipient: string, sender: string): Promise<boolean> {
    if (!(await ignores.isIgnoring(recipient, sender))) return false;
    return !(await player.isAdmin(sender)) && !(await player.isAdmin(recipient));
  },
  /** Of `recipients`, the ones `sender` is not held back from, as they were given. */
  async notIgnoring(sender: string, recipients: string[]): Promise<string[]> {
    const kept: string[] = [];
    for (const recipient of recipients) {
      if (!(await ignores.blocks(recipient, sender))) kept.push(recipient);
    }
    return kept;
  },
  /** Puts the character named `other` on a character's list. */
  async add(username: string, other: string, now = Date.now()): Promise<IgnoreResult> {
    const name = lower(username);
    const target = other ? await characterByName(other) : null;
    const ignored = lower(target?.name ?? "");
    if (!name || !ignored) return "unknown";
    if (ignored === name) return "self";
    // Admins have to reach every player, and to see what every player says.
    if (await player.isAdmin(name)) return "staff";
    if (await player.isAdmin(ignored)) return "admin";

    return change(name, async (held) => {
      if (held.includes(ignored)) return "already";
      if (held.length >= IGNORE_LIMIT) return "full";
      await query("INSERT INTO ignores (character_id, ignored, ignored_id, created_at) VALUES (?, ?, ?, ?)", [await needCharacterId(name), ignored, target!.id, now]);
      await rows.set(name, [...held, ignored]);
      return "added";
    });
  },
  /** Takes `other` off a player's list. False when they were not on it. */
  async remove(username: string, other: string): Promise<boolean> {
    const name = lower(username);
    const ignored = lower(other);
    if (!name || !ignored) return false;

    return change(name, async (held) => {
      if (!held.includes(ignored)) return false;
      await query("DELETE FROM ignores WHERE character_id = ? AND ignored = ?", [await needCharacterId(name), ignored]);
      await rows.set(name, held.filter((entry) => entry !== ignored));
      return true;
    });
  },
};

export default ignores;
