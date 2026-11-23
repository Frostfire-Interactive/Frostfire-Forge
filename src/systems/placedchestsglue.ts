import { spawnsHere } from "../cluster";
import { objectViews } from "../cluster/kinds/objects";
import log from "../modules/logger";
import assetCache from "../services/assetCache";
import lootChest from "./lootChest";
import { isCopyKey } from "./dungeons/copykey";
import type { MapChestObject } from "./dungeons/types";
import { dueResets, syncPlacedChests } from "./placedchests";

const RESET_TICK_MS = 30_000;

const show = (id: string) => { const c = lootChest.getChest(id); if (c) objectViews.showChest(c); };

/** Brings a map's placed chests to its current objects: only changed chests are replaced, and what changed is shown or hidden for everyone on the map. */
export function respawnMapChests(map: string, chests: MapChestObject[]): void {
  const { removed, added } = syncPlacedChests(map, chests, { resets: true, here: (x, y) => spawnsHere(map, x, y) });
  for (const id of removed) objectViews.hideChest({ id, map });
  for (const id of added) show(id);
}

let resetTimer: ReturnType<typeof setInterval> | null = null;

function stopPlacedChests(): void {
  if (resetTimer) clearInterval(resetTimer);
  resetTimer = null;
}

/**
 * Spawns the placed chests of every map but copies and starts their reset timer. Run again, it spawns nothing twice
 * and starts no second timer. A map that fails is logged and skipped. Returns a function that stops the timer.
 */
export async function startPlacedChests(): Promise<() => void> {
  let props: Array<{ name: string; chests?: MapChestObject[] }> = [];
  try {
    props = ((await assetCache.get("mapProperties")) || []) as typeof props;
  } catch (error) {
    log.error(`Placed chests could not read the map properties: ${error}`);
  }
  for (const p of Array.isArray(props) ? props : []) {
    if (!p?.chests?.length || isCopyKey(p.name)) continue;
    try {
      syncPlacedChests(p.name, p.chests, { resets: true, here: (x, y) => spawnsHere(p.name, x, y) });
    } catch (error) {
      log.error(`Placed chests of ${p.name} could not be spawned: ${error}`);
    }
  }
  if (!resetTimer) {
    resetTimer = setInterval(() => {
      try {
        for (const id of dueResets(Date.now())) show(id);
      } catch (error) {
        log.error(`Placed chests could not be reset: ${error}`);
      }
    }, RESET_TICK_MS);
  }
  return stopPlacedChests;
}
