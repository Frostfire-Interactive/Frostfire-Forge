const BODY = { halfWidth: 12, up: 18, down: 21 };

type Placed = { id: string; location: { position: { x: number; y: number } } };

export function pickPlayerAt<T extends Placed>(players: T[], x: number, y: number, range: number, viewerId: string): T | null {
  let top: T | null = null;
  let topY = -Infinity;
  let topDistSq = Infinity;
  let nearest: T | null = null;
  let nearestDistSq = Infinity;
  for (const p of players) {
    const px = Number(p.location.position.x);
    const py = Number(p.location.position.y);
    const dx = px - x;
    const dy = py - y;
    if (!(Math.abs(dx) < range && Math.abs(dy) < range)) continue;
    const distSq = dx * dx + dy * dy;
    if (distSq < nearestDistSq) {
      nearest = p;
      nearestDistSq = distSq;
    }
    if (Math.abs(dx) > BODY.halfWidth || dy > BODY.up || dy < -BODY.down) continue;
    const row = Math.round(py);
    const inFront = row !== topY ? row > topY
      : p.id === viewerId ? true
      : top?.id === viewerId ? false
      : distSq < topDistSq;
    if (!top || inFront) {
      top = p;
      topY = row;
      topDistSq = distSq;
    }
  }
  return top ?? nearest;
}

/** The player of this name (any case) other than the viewer, or null: a party frame clicked picks its member. */
export function pickPlayerNamed<T extends { id: string; username?: unknown }>(players: T[], username: string, viewerId: string): T | null {
  const want = String(username ?? "").toLowerCase();
  if (!want) return null;
  return players.find((p) => p.id !== viewerId && String(p.username ?? "").toLowerCase() === want) ?? null;
}

/** A member of the viewer's party of this name (any case), on any map: a party frame clicked targets them at any distance. */
export function pickPartyMember<T extends { id: string; username?: unknown }>(players: T[], username: string, viewer: { id: string; party?: unknown }): T | null {
  const want = String(username ?? "").toLowerCase();
  if (!want || !Array.isArray(viewer.party) || !viewer.party.some((m) => String(m).toLowerCase() === want)) return null;
  return pickPlayerNamed(players, want, viewer.id);
}

/** The player a party frame clicked names: the viewer for their own frame, else one shown here by that name, else a
 *  member of the viewer's party on any map. */
export function pickFromPartyFrame<T extends { id: string; username?: unknown }>(shown: T[], everyone: T[], username: string, viewer: T & { party?: unknown }): T | null {
  if (String(username ?? "").toLowerCase() === String(viewer.username ?? "").toLowerCase()) return viewer;
  return pickPlayerNamed(shown, username, viewer.id) ?? pickPartyMember(everyone, username, viewer);
}
