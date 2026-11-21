// viewedId -> set of viewerIds that currently have viewedId in their AOI.
const viewers = new Map<string, Set<string>>();

function key(id: number | string): string {
  return String(id);
}

/** Record that `viewerId` can now see `viewedId`. */
export function addViewer(viewedId: number | string, viewerId: number | string): void {
  const k = key(viewedId);
  let set = viewers.get(k);
  if (!set) {
    set = new Set<string>();
    viewers.set(k, set);
  }
  set.add(key(viewerId));
}

/** Record that `viewerId` can no longer see `viewedId`. */
export function removeViewer(viewedId: number | string, viewerId: number | string): void {
  const set = viewers.get(key(viewedId));
  if (!set) return;
  set.delete(key(viewerId));
  if (set.size === 0) viewers.delete(key(viewedId));
}

export function replaceVisibleSet(
  viewerId: number | string,
  oldViewed: Iterable<number | string>,
  newViewed: Iterable<number | string>,
): void {
  const next = new Set<string>();
  for (const id of newViewed) next.add(key(id));

  for (const id of oldViewed) {
    if (!next.has(key(id))) removeViewer(id, viewerId);
  }
  for (const id of next) {
    // addViewer is idempotent, so re-adding an unchanged entry is harmless.
    addViewer(id, viewerId);
  }
}

/** Drop `viewerId` from every viewed-set (viewer disconnected / changed map). */
export function clearViewer(viewerId: number | string): void {
  const v = key(viewerId);
  for (const [viewedId, set] of viewers) {
    if (set.delete(v) && set.size === 0) viewers.delete(viewedId);
  }
}

/** Drop `viewedId` entirely - nobody sees it any more (it despawned). */
export function clearViewed(viewedId: number | string): void {
  viewers.delete(key(viewedId));
}

/** Viewer ids that currently have `viewedId` in their AOI. Empty set if none. */
export function getViewers(viewedId: number | string): Set<string> {
  return viewers.get(key(viewedId)) ?? EMPTY;
}

const EMPTY: Set<string> = new Set();

/** Test / diagnostics only. */
export function _size(): number {
  return viewers.size;
}

export function _reset(): void {
  viewers.clear();
}
