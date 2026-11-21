import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import { clusterEnabled, regionId } from "../cluster/config";

/** Lower case usernames. Filled by loadRealmWhitelist; /whitelist add and remove keep it in step with the database. */
export const realmWhitelist = new Set<string>();

let enabled = process.env.WHITELIST === "true";
const listeners: Array<(enabled: boolean) => void> = [];

/** The realm of the whitelist rows. The nodes of a cluster are one realm, whatever their own SERVER_ID. */
export const whitelistRealm = (): string => (clusterEnabled() ? regionId() : process.env.SERVER_ID || "default");

/** A change an admin made here, which the region's other nodes follow. */
export type WhitelistChange = { enabled?: boolean; add?: string; remove?: string };

let share: (change: WhitelistChange) => void = () => {};

/** How a change reaches the other nodes: the socket layer sets it. */
export function shareWhitelistChanges(send: (change: WhitelistChange) => void): void {
  share = send;
}

/** Says a name was put on or taken off the list. */
export function whitelistNameChanged(change: WhitelistChange): void {
  share(change);
}

const UNTIL_RESTART = "This lasts until the server restarts: the WHITELIST setting decides how it starts.";

/** Whether logins are checked against the whitelist right now. */
export function isWhitelistEnabled(): boolean {
  return enabled;
}

/** `listener` is called with the new state each time the whitelist is switched. */
export function onWhitelistSwitch(listener: (enabled: boolean) => void): void {
  listeners.push(listener);
}

export async function loadRealmWhitelist(): Promise<number> {
  const rows = (await query("SELECT username FROM whitelist WHERE realm = ?", [whitelistRealm()])) as Array<{ username: string }>;
  realmWhitelist.clear();
  for (const row of rows) realmWhitelist.add(String(row.username).toLowerCase());
  return realmWhitelist.size;
}

let turn: Promise<unknown> = Promise.resolve();

export function setWhitelistEnabled(wanted: boolean, by?: string): Promise<{ success: boolean; message: string }> {
  // One switch at a time: the list is read between being asked and enforcing it.
  const mine = turn.then(async () => {
    const result = await switchTo(wanted, by);
    if (result.success) share({ enabled: wanted });
    return result;
  });
  turn = mine.catch(() => {});
  return mine;
}

/** Applies what an admin changed on another node. Nothing is passed on. */
export async function followWhitelist(change: WhitelistChange): Promise<void> {
  if (typeof change.enabled === "boolean") {
    const wanted = change.enabled;
    const mine = turn.then(() => switchTo(wanted));
    turn = mine.catch(() => {});
    await mine;
  }
  if (change.add) realmWhitelist.add(change.add);
  if (change.remove) realmWhitelist.delete(change.remove);
}

async function switchTo(wanted: boolean, by?: string): Promise<{ success: boolean; message: string }> {
  if (wanted === enabled) return { success: false, message: `Whitelist is already ${wanted ? "on" : "off"}` };

  const admin = String(by ?? "").toLowerCase().trim();
  let added = false;
  if (wanted) {
    try {
      await loadRealmWhitelist();
      if (admin && !realmWhitelist.has(admin)) {
        await query("INSERT INTO whitelist (realm, username) VALUES (?, ?)", [whitelistRealm(), admin]);
        realmWhitelist.add(admin);
        added = true;
      }
    } catch (error) {
      log.error(`Failed to turn the whitelist on: ${error}`);
      return { success: false, message: "The whitelist could not be read from the database, so it was left off" };
    }
  }

  enabled = wanted;
  log.info(`[Whitelist] Turned ${wanted ? "on" : "off"}${admin ? ` by ${admin}` : ""}`);
  for (const listener of listeners) {
    try {
      listener(enabled);
    } catch (error) {
      log.error(`Whitelist switch listener failed: ${error}`);
    }
  }

  if (!wanted) return { success: true, message: `Whitelist is off: anyone can log in. ${UNTIL_RESTART}` };
  const names = `${realmWhitelist.size} ${realmWhitelist.size === 1 ? "name" : "names"}`;
  return {
    success: true,
    message: `Whitelist is on with ${names}${added ? " (you were added)" : ""}. Players already online stay, new logins are checked. ${UNTIL_RESTART}`,
  };
}
