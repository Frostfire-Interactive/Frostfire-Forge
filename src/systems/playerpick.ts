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
