import log from "./logger";

type MapSave = { saves: number; left: boolean; unsaved: boolean };

const underWay = new Map<string, MapSave>();
const missedListeners = new Set<(name: string) => unknown>();

const key = (name: string) => name.replace(/\.json$/, "");

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
