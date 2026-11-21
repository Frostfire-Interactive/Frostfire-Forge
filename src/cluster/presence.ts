import log from "../modules/logger";
import playerCache from "../services/playermanager";
import type { DirectoryEntry, PlayerDirectory } from "./directory";
import { StoppedWaiting, runWhenUp, storeHealth, type StoreGate } from "./health";

/** How long a claim or a release waits for a cluster store that is down (ms). */
export const PRESENCE_HOLD_MS = 120_000;
/** The most times a claim or a release runs when the store goes down under it. */
export const PRESENCE_ATTEMPTS = 3;

export interface PresenceOptions {
  /** No displaced-login for this claim: the player arrived by a handoff, and the old node already let them go. */
  quiet?(username: string): boolean;
  /** How long to hold the directory release of a removed player (ms). 0 or less: at once. */
  holdReleaseMs?(value: any): number;
  /** A held release was made: the player's client never reached the new node, and they are gone. */
  onLost?(value: any): void;
  onClaimed?(player: any, entry: DirectoryEntry): Promise<number | null>;
  siblings?(player: any): Promise<string[]>;
  /** The store's health. The node's (health.ts) unless a test gives another. */
  health?: StoreGate;
  /** How long a claim or a release waits for the store (ms). PRESENCE_HOLD_MS unless given. */
  storeHoldMs?: number;
}

export function trackPresence(
  directory: PlayerDirectory,
  onDisplaced: (previous: DirectoryEntry, username: string, player?: any) => void,
  options: PresenceOptions = {},
): () => void {
  const claims = new Map<string, Promise<number | null>>();
  const held = new Set<ReturnType<typeof setTimeout>>();

  const gate = options.health ?? storeHealth;
  let stopped = false;
  const whenUp = <T>(what: string, work: () => Promise<T>): Promise<T> =>
    runWhenUp(gate, what, work, { holdMs: options.storeHoldMs ?? PRESENCE_HOLD_MS, attempts: PRESENCE_ATTEMPTS, alive: () => !stopped });

  const displaceSiblings = async (username: string, value: any) => {
    if (!options.siblings) return;
    try {
      const own = username.toLowerCase();
      for (const name of await options.siblings(value)) {
        if (!name || name.toLowerCase() === own) continue;
        const entry = await directory.get(name);
        if (entry && entry.nodeId !== directory.nodeId) onDisplaced(entry, name, value);
      }
    } catch (error) {
      log.error(`The other characters of ${username}'s account were not checked for a session elsewhere: ${error}`);
    }
  };

  const stopAdd = playerCache.onAdd((key, value) => {
    const username = value?.username;
    if (typeof username !== "string" || !username) return;
    const replaced = new Map<string, DirectoryEntry>();
    const note = (entry: DirectoryEntry | null) => {
      if (entry && entry.nodeId !== directory.nodeId) replaced.set(`${entry.nodeId}/${entry.playerId}/${entry.epoch}`, entry);
    };
    const claim = async () => {
      return (await directory.claim(username, String(key), String(value?.location?.map ?? ""), note)).entry;
    };
    claims.set(key, whenUp(`Directory claim for ${username}`, claim)
      .then(async (entry) => {
        // Taken out first: a throw below reaches the catch, which must not name them a second time.
        const told = [...replaced.values()];
        replaced.clear();
        if (!options.quiet?.(username)) {
          for (const previous of told) onDisplaced(previous, username, value);
          await displaceSiblings(username, value);
        }
        if (!options.onClaimed) return entry.epoch;
        // The release below must name the entry as it is now: a lifted entry holds a higher epoch than the claim.
        try {
          return (await options.onClaimed(value, entry)) ?? entry.epoch;
        } catch (error) {
          log.error(`Owner epoch for ${username} could not be taken, so its saves are not fenced: ${error}`);
          return entry.epoch;
        }
      })
      .catch((error) => {
        if (error instanceof StoppedWaiting) log.debug(`Directory claim for ${username} was not made: ${error.message}`);
        else log.error(`Directory claim for ${username} failed: ${error}`);
        if (!options.quiet?.(username)) for (const previous of replaced.values()) onDisplaced(previous, username, value);
        return null;
      }));
  });

  const release = (claim: Promise<number | null>, username: string, released?: () => void) => {
    claim
      .then((epoch) => (epoch === null ? false : whenUp(`Directory release for ${username}`, () => directory.release(username, epoch))))
      .then((made) => { if (made) released?.(); })
      .catch((error) => {
        if (error instanceof StoppedWaiting) log.debug(`Directory release for ${username} was not made: ${error.message}`);
        else log.error(`Directory release for ${username} failed: ${error}`);
      });
  };

  const stopRemove = playerCache.onRemove((key, value) => {
    const claim = claims.get(key);
    claims.delete(key);
    const username = value?.username;
    if (!claim || typeof username !== "string") return;
    const holdMs = Number(options.holdReleaseMs?.(value)) || 0;
    if (holdMs <= 0) {
      release(claim, username);
      return;
    }
    const timer = setTimeout(() => {
      held.delete(timer);
      release(claim, username, () => options.onLost?.(value));
    }, holdMs);
    (timer as any).unref?.();
    held.add(timer);
  });

  // A held release cancelled here leaves its entry: startCluster's teardown sweeps this node's entries after this.
  return () => {
    stopped = true;
    stopAdd();
    stopRemove();
    for (const timer of held) clearTimeout(timer);
    held.clear();
  };
}
