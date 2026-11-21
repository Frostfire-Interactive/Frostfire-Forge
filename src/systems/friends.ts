import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import { rowCache, turns } from "../services/datacache";
import { characterIdOf, currentNames, needCharacterId } from "./characterids";
import { characterByName, nameKey } from "./characterstore";

/** A row of the friendslist table: `friends` is the comma-separated list of the friends' character names. */
type FriendsRow = { friends: string };

const rows = rowCache<FriendsRow[]>("friends", async (name) => {
  const id = await characterIdOf(name);
  if (id === null) return [];
  const found = ((await query("SELECT friends FROM friendslist WHERE character_id = ?", [id])) as FriendsRow[]) || [];
  if (!found.length) return found;
  const names = stored(found);
  const current = await currentNames(names);
  const shown: string[] = [];
  for (const kept of names) {
    const now = current.get(nameKey(kept));
    if (now && !shown.includes(now)) shown.push(now);
  }
  return [{ friends: shown.join(",") }];
}, { perPlayer: true });

const oneAtATime = turns();

function write(name: string, sql: string, values: (id: number) => unknown[], left: (held: FriendsRow[]) => FriendsRow[]): Promise<any> {
  return oneAtATime(name, async () => {
    const held = (await rows.get(name)) ?? [];
    try {
      const result = await query(sql, values(await needCharacterId(name)));
      await rows.set(name, left(held));
      return result;
    } catch (error) {
      await rows.drop(name);
      throw error;
    }
  });
}

/** The names the row holds, as kept. */
function stored(held: FriendsRow[] | null): string[] {
  if (!held?.length || !held[0].friends) return [];
  return held[0].friends.split(",").map((friend) => friend.trim()).filter((friend) => friend !== "");
}

const friends = {
  async list(username: string): Promise<string[]> {
    if (!username) return [];
    try {
      return stored(await rows.get(username));
    } catch (error) {
      log.error(`Error listing friends for ${username}: ${error}`);
      return [];
    }
  },
  /** Adds the character named `friend_username` to a character's friends. */
  async add(username: string, friend_username: string): Promise<string[]> {
    if (!username || !friend_username) return [];

    try {
      const friend = await characterByName(friend_username);
      if (!friend) return await this.list(username);
      const currentFriends = await this.list(username);
      if (currentFriends.some((name) => nameKey(name) === nameKey(friend.name))) return currentFriends;

      currentFriends.push(friend.name);
      const friendsString = currentFriends.join(",");

      const result = await write(
        username,
        "INSERT INTO friendslist (character_id, friends) VALUES (?, ?) ON DUPLICATE KEY UPDATE friends = ?",
        (id) => [id, friendsString, friendsString],
        () => [{ friends: friendsString }]
      );

      if (!((result?.affectedRows ?? result?.count) > 0)) log.error(`Failed to add friend for ${username}`);
      return currentFriends;
    } catch (error) {
      log.error(`Error adding friend for ${username}: ${error}`);
      return await this.list(username);
    }
  },
  /** Takes the character named `friend_username` (any case) off a character's friends. */
  async remove(username: string, friend_username: string): Promise<string[]> {
    if (!username || !friend_username) return [];

    try {
      const currentFriends = await this.list(username);
      const friendIndex = currentFriends.findIndex((name) => nameKey(name) === nameKey(friend_username));
      if (friendIndex === -1) return currentFriends;

      currentFriends.splice(friendIndex, 1);
      const friendsString = currentFriends.join(",");

      const result = await write(
        username,
        "UPDATE friendslist SET friends = ? WHERE character_id = ?",
        (id) => [friendsString, id],
        (held) => held.map((row) => ({ ...row, friends: friendsString }))
      );

      if (!((result?.affectedRows ?? result?.count) > 0)) log.error(`Failed to remove friend for ${username}`);
      return currentFriends;
    } catch (error) {
      log.error(`Error removing friend for ${username}: ${error}`);
      return [];
    }
  }
};

export default friends;
