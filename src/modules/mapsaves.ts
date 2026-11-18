import log from "./logger";

// The map editor's saves (SAVE_MAP) under way: those of this server, and in cluster mode those of the other nodes of
// the region, each marked here from the saver's word that it is under way ("map-saving" peer news) until its news of
// how it ended. The asset server tells every game server of each save as soon as it has written it (/map-events),
// often before the save has finished. A change to a map with a save under way is left to that save, which takes the
// new map in itself (here, or on the other nodes through its "world-saved" or "map-saved" news) and shows its players
// the saved chunks: taken in as a change made elsewhere, it would have every player on the map load it again (the
// loading screen, and the map editor opened again). A save that ends without saving has what was left to it taken in
// after all, as any change from the asset server.

type MapSave = { saves: number; left: boolean; unsaved: boolean };

const underWay = new Map<string, MapSave>();
const missedListeners = new Set<(name: string) => unknown>();

const key = (name: string) => name.replace(/\.json$/, "");

/**
 * Marks a save of a map or world (by name, with or without .json) as under way until the function it returns is
 * called, with whether the save saved. Two saves of one map can overlap: it is under way until both have ended, and
 * what was left to them is taken in after all if either did not save.
 */
export function startMapSave(name: string): (saved: boolean) => void {
  const k = key(name);
  const save = underWay.get(k) ?? { saves: 0, left: false, unsaved: false };
  save.saves++;
  underWay.set(k, save);
  let ended = false;
  return (saved: boolean) => {
    if (ended) return;
    ended = true;
    if (!saved) save.unsaved = true;
    if (--save.saves > 0) return;
    underWay.delete(k);
    if (save.left && save.unsaved) tellMissed(k);
  };
}

/** Whether a save of that map or world (by name, with or without .json) is under way. */
export function mapSaveUnderWay(name: string): boolean {
  return underWay.has(key(name));
}

/**
 * Leaves the asset server's word of a change to that map or world to the save under way of it, if there is one:
 * true when there is, and the change is then not taken in now.
 */
export function leaveToSave(name: string): boolean {
  const save = underWay.get(key(name));
  if (!save) return false;
  save.left = true;
  return true;
}

/** Calls `listener` with the name (without .json) of each map whose change was left to a save that ended without saving. */
export function onLeftChangeMissed(listener: (name: string) => unknown): () => void {
  missedListeners.add(listener);
  return () => { missedListeners.delete(listener); };
}

function tellMissed(name: string): void {
  for (const listener of missedListeners) {
    try {
      const run = listener(name);
      if (run instanceof Promise) run.catch((error) => log.error(`The change to ${name} left to a save could not be taken in: ${error}`));
    } catch (error) {
      log.error(`The change to ${name} left to a save could not be taken in: ${error}`);
    }
  }
}
