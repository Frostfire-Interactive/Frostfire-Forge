import log from "../modules/logger";
import playerCache from "../services/playermanager";
import { deliverToPlayer, registerPlayerAction, runOnPlayer } from "../cluster/deliver";
import { clusterDirectory } from "../cluster/index";
import { packetManager } from "./packet_manager";

const statusOf = (username: string, online: boolean) => packetManager.updateOnlineStatus({ online, username });

/** Everyone whose lists show this player: friends, party, guild. Lower case, each once, never the player. */
export function contactsOf(p: any): string[] {
  const names = new Set<string>();
  for (const list of [p?.friends, p?.party, p?.guild]) {
    if (!Array.isArray(list)) continue;
    for (const name of list) names.add(String(name).toLowerCase());
  }
  names.delete(String(p?.username ?? "").toLowerCase());
  names.delete("");
  return [...names];
}

/** Tells these contacts how the player stands, and the player how each of them does. */
export async function greetContacts(p: any, names: string[] = contactsOf(p)): Promise<void> {
  const from = p.username;
  const me = String(from).toLowerCase();
  const online = !p.isStealth;
  await Promise.all(names.filter((name) => String(name).toLowerCase() !== me).map(async (name) => {
    if (!(await runOnPlayer(name, "contact-hello", { from, online }))) await deliverToPlayer(from, statusOf(name, false));
  }));
}

/** As greetContacts, for a player who may be on another node. A player who is not online is greeted by nobody. */
export function greetFrom(username: string, names: string[]): Promise<boolean> {
  return runOnPlayer(username, "contact-greet", { names });
}

/** Gives a player, on whichever node holds them, their friends list as it now stands. */
export function sendFriends(username: string, friends: string[]): Promise<boolean> {
  return runOnPlayer(username, "friends-update", { friends });
}

/** Tells every contact the player is gone (or, stealthed, looks it). A contact who is not online is skipped. */
export async function tellContactsOffline(p: any): Promise<void> {
  const offline = statusOf(p.username, false);
  await Promise.all(contactsOf(p).map((name) => deliverToPlayer(name, offline)));
}

registerPlayerAction("contact-hello", async (contact, { from, online }) => {
  await deliverToPlayer(contact.username, statusOf(from, online));
  await deliverToPlayer(from, statusOf(contact.username, !contact.isStealth));
});
registerPlayerAction("contact-greet", (p, { names }) => greetContacts(p, names));
/** The player's friends as they now are: kept with the player, who tells them when they leave, and sent to their client. */
registerPlayerAction("friends-update", async (p, { friends }) => {
  p.friends = friends;
  playerCache.set(p.id, p);
  await deliverToPlayer(p.username, packetManager.updateFriends({ friends }));
});

export async function contactsLost(peer: string, restarted: boolean): Promise<void> {
  const directory = clusterDirectory();
  if (!directory) return;
  const holders = new Map<string, string[]>();
  for (const p of Object.values(playerCache.list()) as any[]) {
    if (!p?.username) continue;
    for (const name of contactsOf(p)) {
      if (playerCache.getByUsername(name)) continue;
      (holders.get(name) ?? holders.set(name, []).get(name)!).push(p.username);
    }
  }
  try {
    for (const [name, players] of holders) {
      const entry = await directory.get(name);
      if (entry && (restarted || entry.nodeId !== peer)) continue;
      const offline = statusOf(name, false);
      await Promise.all(players.map((username) => deliverToPlayer(username, offline)));
    }
  } catch (error) {
    log.error(`The contacts lost with node ${peer} could not all be told: ${error}`);
  }
}
