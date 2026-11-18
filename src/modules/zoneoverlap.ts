// Zone shapes against each other, for the rule that two zones never lie partly over each other: whether two rings lie
// apart, one inside the other or partly over each other, and a ring with another one cut out of it (ringMinus) or cut
// down to it (ringAnd). Every point of a zone is a whole tile corner. A cut is worked out exactly, in whole numbers,
// also where two borders cross between tile corners; each such crossing is then moved to a near tile corner on the side
// of the other ring that the cut keeps to. The game server (src/modules/zoneoverlap.ts) and the map editor
// (js/core/zoneoverlap.ts) have the same copy of this file: change both together.

/** How a ring lies against another one: apart (touching at most), inside it, around it, or partly over it. */
export type RingRelation = "apart" | "inside" | "around" | "overlap";

/** The point (x / d, y / d). d is above 0 and the three have no common factor, so a point has one key. */
interface Exact { x: bigint; y: bigint; d: bigint }

/** Where a piece of one ring's border lies against the other ring: inside it, outside it, or along its border the same
 * way or the other way. */
type Side = "in" | "out" | "same" | "back";

interface Piece { from: Exact; to: Exact; side: Side }

function gcd(a: bigint, b: bigint): bigint {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b) [a, b] = [b, a % b];
  return a;
}

function exact(x: bigint, y: bigint, d: bigint): Exact {
  if (d < 0n) { x = -x; y = -y; d = -d; }
  const g = gcd(gcd(x, y), d);
  return g > 1n ? { x: x / g, y: y / g, d: d / g } : { x, y, d };
}

const keyOf = (p: Exact) => `${p.x},${p.y},${p.d}`;
const same = (p: number[], q: number[]) => p[0] === q[0] && p[1] === q[1];

/** Twice the area of a ring: above 0 when its inside is on the left of each edge. */
function twiceArea(ring: number[][]): number {
  let twice = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    twice += p[0] * q[1] - q[0] * p[1];
  }
  return twice;
}

/** A ring without repeated points (its first point again at the end included), turned so its inside is on the left. */
function tidy(ring: number[][]): number[][] {
  const points: number[][] = [];
  for (const p of ring) if (!points.length || !same(points[points.length - 1], p)) points.push([p[0], p[1]]);
  while (points.length > 1 && same(points[0], points[points.length - 1])) points.pop();
  return twiceArea(points) < 0 ? points.reverse() : points;
}

function box(ring: number[][]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

/** Whether the boxes of two rings share more than an edge. */
function boxesOverlap(a: number[][], b: number[][]): boolean {
  const p = box(a), q = box(b);
  return p.minX < q.maxX && q.minX < p.maxX && p.minY < q.maxY && q.minY < p.maxY;
}

/** Where a whole tile corner is against a ring: 1 inside, 0 on its border, -1 outside. */
function where(px: number, py: number, ring: number[][]): number {
  let winding = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
    const s = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (s === 0 && Math.min(ax, bx) <= px && px <= Math.max(ax, bx) && Math.min(ay, by) <= py && py <= Math.max(ay, by)) return 0;
    if (ay <= py) {
      if (by > py && s > 0) winding++;
    } else if (by <= py && s < 0) winding--;
  }
  return winding !== 0 ? 1 : -1;
}

/** The places along each edge of `a` where it meets an edge of `b`, as fractions [n, d] of the edge (0 and 1, its
 * ends, included), and the same for `b`. */
function meetings(a: number[][], b: number[][]): { a: number[][][]; b: number[][][] } {
  const atA = a.map(() => [[0, 1], [1, 1]]), atB = b.map(() => [[0, 1], [1, 1]]);
  for (let i = 0; i < a.length; i++) {
    const [px, py] = a[i], [px1, py1] = a[(i + 1) % a.length];
    const dx = px1 - px, dy = py1 - py;
    for (let j = 0; j < b.length; j++) {
      const [qx, qy] = b[j], [qx1, qy1] = b[(j + 1) % b.length];
      if (Math.max(px, px1) < Math.min(qx, qx1) || Math.max(qx, qx1) < Math.min(px, px1)) continue;
      if (Math.max(py, py1) < Math.min(qy, qy1) || Math.max(qy, qy1) < Math.min(py, py1)) continue;
      const ex = qx1 - qx, ey = qy1 - qy, wx = qx - px, wy = qy - py;
      let den = dx * ey - dy * ex;
      if (den !== 0) {
        let t = wx * ey - wy * ex, u = wx * dy - wy * dx;
        if (den < 0) { den = -den; t = -t; u = -u; }
        if (t >= 0 && t <= den && u >= 0 && u <= den) {
          atA[i].push([t, den]);
          atB[j].push([u, den]);
        }
      } else if (wx * dy - wy * dx === 0) {
        // On the same line: each end of one edge that lies on the other one splits it there
        const lengthA = dx * dx + dy * dy, lengthB = ex * ex + ey * ey;
        for (const [x, y] of [[qx, qy], [qx1, qy1]]) {
          const n = (x - px) * dx + (y - py) * dy;
          if (n >= 0 && n <= lengthA) atA[i].push([n, lengthA]);
        }
        for (const [x, y] of [[px, py], [px1, py1]]) {
          const n = (x - qx) * ex + (y - qy) * ey;
          if (n >= 0 && n <= lengthB) atB[j].push([n, lengthB]);
        }
      }
    }
  }
  return { a: atA, b: atB };
}

/** The border of a ring cut into pieces at the given places along each edge. */
function pieces(ring: number[][], at: number[][][]): Array<{ from: Exact; to: Exact }> {
  const found: Array<{ from: Exact; to: Exact }> = [];
  ring.forEach(([x, y], i) => {
    const [x1, y1] = ring[(i + 1) % ring.length];
    const sorted = at[i]
      .map(([n, d]) => ({ n: BigInt(n), d: BigInt(d) }))
      .sort((p, q) => (p.n * q.d < q.n * p.d ? -1 : p.n * q.d > q.n * p.d ? 1 : 0));
    const points: Exact[] = [];
    for (const { n, d } of sorted) {
      const last = points[points.length - 1];
      const p = exact(BigInt(x) * d + n * BigInt(x1 - x), BigInt(y) * d + n * BigInt(y1 - y), d);
      if (!last || keyOf(last) !== keyOf(p)) points.push(p);
    }
    for (let k = 0; k + 1 < points.length; k++) found.push({ from: points[k], to: points[k + 1] });
  });
  return found;
}

/** Where a piece of border lies against a ring, found from its middle point. */
function sideOf(piece: { from: Exact; to: Exact }, ring: number[][]): Side {
  const { from, to } = piece;
  // The middle point in floating point first: an edge it is clearly to one side of, and clearly above or below the ends
  // of, counts from that. Only an edge it is close to is worked out exactly.
  const fx = (Number(from.x) / Number(from.d) + Number(to.x) / Number(to.d)) / 2;
  const fy = (Number(from.y) / Number(from.d) + Number(to.y) / Number(to.d)) / 2;
  const mx = from.x * to.d + to.x * from.d, my = from.y * to.d + to.y * from.d, md = 2n * from.d * to.d;
  let winding = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
    const sf = (bx - ax) * (fy - ay) - (by - ay) * (fx - ax);
    if (Math.abs(sf) > 1e-6 && Math.abs(fy - ay) > 1e-6 && Math.abs(fy - by) > 1e-6) {
      if (ay <= fy) {
        if (by > fy && sf > 0) winding++;
      } else if (by <= fy && sf < 0) winding--;
      continue;
    }
    const ex = BigInt(bx - ax), ey = BigInt(by - ay);
    const ax0 = BigInt(ax) * md, ay0 = BigInt(ay) * md, by0 = BigInt(by) * md;
    const s = ex * (my - ay0) - ey * (mx - ax0);
    if (s === 0n) {
      const lowX = BigInt(Math.min(ax, bx)) * md, highX = BigInt(Math.max(ax, bx)) * md;
      const lowY = BigInt(Math.min(ay, by)) * md, highY = BigInt(Math.max(ay, by)) * md;
      if (lowX <= mx && mx <= highX && lowY <= my && my <= highY) {
        const along = (to.x * from.d - from.x * to.d) * ex + (to.y * from.d - from.y * to.d) * ey;
        return along > 0n ? "same" : "back";
      }
    }
    if (ay0 <= my) {
      if (by0 > my && s > 0n) winding++;
    } else if (by0 <= my && s < 0n) winding--;
  }
  return winding !== 0 ? "in" : "out";
}

/** Both rings' borders cut where they meet, each piece marked with where it lies against the other ring. */
function cutUp(a: number[][], b: number[][]): { a: Piece[]; b: Piece[] } {
  const at = meetings(a, b);
  return {
    a: pieces(a, at.a).map((p) => ({ ...p, side: sideOf(p, b) })),
    b: pieces(b, at.b).map((p) => ({ ...p, side: sideOf(p, a) })),
  };
}

const within = (p: Piece) => p.side === "in" || p.side === "same";

function relationOf(cut: { a: Piece[]; b: Piece[] }): RingRelation {
  if (!cut.a.some(within) && !cut.b.some((p) => p.side === "in")) return "apart";
  if (cut.a.every(within)) return "inside";
  if (cut.b.every(within)) return "around";
  return "overlap";
}

/** How ring `a` lies against ring `b`. Rings with the same border are inside each other: `a` is inside. */
export function ringRelation(a: number[][], b: number[][]): RingRelation {
  const ta = tidy(a), tb = tidy(b);
  if (ta.length < 3 || tb.length < 3 || twiceArea(ta) === 0 || twiceArea(tb) === 0 || !boxesOverlap(ta, tb)) return "apart";
  return relationOf(cutUp(ta, tb));
}

/** The direction of a piece, near enough to compare angles. */
function heading(from: Exact, to: Exact): number {
  return Math.atan2(Number(to.y) / Number(to.d) - Number(from.y) / Number(from.d), Number(to.x) / Number(to.d) - Number(from.x) / Number(from.d));
}

/** Pieces joined end to start into rings. Where more than one piece starts at a point (two parts touch there), the one
 * that keeps closest to the part being followed is taken, so each part becomes its own ring. Null when the pieces do not
 * close up. */
function join(edges: Array<{ from: Exact; to: Exact }>): Exact[][] | null {
  const starting = new Map<string, number[]>();
  edges.forEach((edge, i) => {
    const key = keyOf(edge.from);
    const list = starting.get(key);
    if (list) list.push(i);
    else starting.set(key, [i]);
  });
  const used = edges.map(() => false);
  const rings: Exact[][] = [];
  for (let first = 0; first < edges.length; first++) {
    if (used[first]) continue;
    const ring: Exact[] = [];
    let at = first;
    for (let steps = 0; ; steps++) {
      if (steps > edges.length) return null;
      used[at] = true;
      const edge = edges[at];
      ring.push(edge.from);
      const options = (starting.get(keyOf(edge.to)) ?? []).filter((i) => !used[i] || i === first);
      if (!options.length) return null;
      let next = options[0];
      if (options.length > 1) {
        // The inside is on the left: turning right from the way back along this piece, the first piece met bounds it
        const back = heading(edge.to, edge.from);
        let best = Infinity;
        for (const i of options) {
          let turn = back - heading(edges[i].from, edges[i].to);
          while (turn <= 0) turn += Math.PI * 2;
          while (turn > Math.PI * 2) turn -= Math.PI * 2;
          if (turn < best) { best = turn; next = i; }
        }
      }
      if (next === first) break;
      at = next;
    }
    rings.push(ring);
  }
  return rings;
}

/** A point of a cut moved to a tile corner: the nearest one on the side `keep` of ring `b` (outside it for "out", inside
 * it for "in", or on its border unless `strict`), inside ring `a` or on its border when one that near is. */
function snap(p: Exact, a: number[][], b: number[][], keep: "out" | "in", strict: boolean): number[] {
  if (p.d === 1n) return [Number(p.x), Number(p.y)];
  const x = Number(p.x) / Number(p.d), y = Number(p.y) / Number(p.d);
  const corners: number[][] = [];
  for (let dx = -1; dx <= 2; dx++) for (let dy = -1; dy <= 2; dy++) corners.push([Math.floor(x) + dx, Math.floor(y) + dy]);
  corners.sort((c, e) => (c[0] - x) ** 2 + (c[1] - y) ** 2 - ((e[0] - x) ** 2 + (e[1] - y) ** 2));
  const wanted = keep === "out" ? -1 : 1;
  const allowed = corners.filter((c) => {
    const at = where(c[0], c[1], b);
    return at === wanted || (!strict && at === 0);
  });
  return allowed.find((c) => where(c[0], c[1], a) >= 0) ?? allowed[0] ?? corners[0];
}

/** A ring without points that add nothing: one the same as the point before it, or one on a straight line between its
 * neighbours (which also takes away a spike that runs out and straight back). Empty when fewer than 3 points are left. */
function plain(ring: number[][]): number[][] {
  const points = ring.slice();
  for (let changed = true; changed && points.length >= 3;) {
    changed = false;
    for (let i = 0; i < points.length && points.length >= 3; i++) {
      const prev = points[(i + points.length - 1) % points.length], p = points[i], next = points[(i + 1) % points.length];
      if (same(prev, p) || (p[0] - prev[0]) * (next[1] - prev[1]) - (p[1] - prev[1]) * (next[0] - prev[0]) === 0) {
        points.splice(i, 1);
        i--;
        changed = true;
      }
    }
  }
  return points.length >= 3 ? points : [];
}

/** Whether an edge of ring `p` meets an edge of ring `q`. */
function ringsMeet(p: number[][], q: number[][]): boolean {
  for (let i = 0; i < p.length; i++) {
    for (let j = 0; j < q.length; j++) if (edgesMeet(p[i], p[(i + 1) % p.length], q[j], q[(j + 1) % q.length])) return true;
  }
  return false;
}

/**
 * Rings of a cut that touch at a point moved apart. A cut can leave two parts joined at one point (or one part touching
 * itself), and two rings of a zone never meet: each time the point comes again, it moves to the nearest tile corner
 * inside its ring that keeps the ring simple, on the side `keep` of `b` and clear of the other rings. Null when no
 * corner near enough does.
 */
function unpinch(rings: number[][][], b: number[][], keep: "out" | "in"): number[][][] | null {
  const seen = new Set<string>();
  const wanted = keep === "out" ? "apart" : "inside";
  for (let r = 0; r < rings.length; r++) {
    for (let i = 0; i < rings[r].length; i++) {
      const [x, y] = rings[r][i];
      if (!seen.has(`${x},${y}`)) {
        seen.add(`${x},${y}`);
        continue;
      }
      const corners: number[][] = [];
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) if (dx || dy) corners.push([x + dx, y + dy]);
      corners.sort((c, e) => (c[0] - x) ** 2 + (c[1] - y) ** 2 - ((e[0] - x) ** 2 + (e[1] - y) ** 2));
      // Each corner inside the ring near the point, then the ring without the point, which cuts across its corner
      const trials = corners.filter((c) => where(c[0], c[1], rings[r]) === 1).map((c) => rings[r].map((p, k) => (k === i ? c : p)));
      if (rings[r].length > 3) trials.push(rings[r].filter((_, k) => k !== i));
      const moved = trials.find((trial) =>
        twiceArea(trial) > 0
        && !outlineMeets([trial])
        && ringRelation(trial, b) === wanted
        && rings.every((other, k) => k === r || !ringsMeet(trial, other)));
      if (!moved) return null;
      const removed = moved.length < rings[r].length;
      rings[r] = moved;
      if (removed) i--;
      else seen.add(`${rings[r][i][0]},${rings[r][i][1]}`);
    }
  }
  return rings;
}

/** The rings of a cut, moved to tile corners and checked: each one simple and on the side `keep` of `b`, none of them
 * meeting or inside another. A part that shrinks to nothing on the move is left out. The points move to the nearest
 * corners first; when that breaks a rule, they move to corners clear of `b`'s border. Null when both break a rule. */
function finish(rings: Exact[][], a: number[][], b: number[][], keep: "out" | "in"): number[][][] | null {
  return snapped(rings, a, b, keep, false) ?? snapped(rings, a, b, keep, true);
}

function snapped(rings: Exact[][], a: number[][], b: number[][], keep: "out" | "in", strict: boolean): number[][][] | null {
  const snapped: number[][][] = [];
  for (const ring of rings) {
    const points = plain(ring.map((p) => snap(p, a, b, keep, strict)));
    if (points.length >= 3 && twiceArea(points) > 0) snapped.push(points);
  }
  const result = unpinch(snapped, b, keep);
  if (!result || outlineMeets(result)) return null;
  for (const ring of result) if (ringRelation(ring, b) !== (keep === "out" ? "apart" : "inside")) return null;
  for (let i = 0; i < result.length; i++) {
    for (let j = i + 1; j < result.length; j++) if (ringRelation(result[i], result[j]) !== "apart") return null;
  }
  return result;
}

const copy = (ring: number[][]) => [ring.map((p) => [p[0], p[1]])];

/**
 * Ring `a` with what lies inside ring `b` cut away: the rings left (none when `a` lies wholly inside `b`, more than one
 * when `b` cuts it in two), drawn with their inside on the left. Where the cut follows `b`, it runs along `b`'s points;
 * where a border crosses between tile corners, the point moves to a corner outside `b`. A ring apart from `b` comes back
 * as it is. Null when the cut cannot be made in whole tiles without breaking a zone rule.
 */
export function ringMinus(a: number[][], b: number[][]): number[][][] | null {
  if (ringRelation(a, b) === "apart") return copy(a);
  const ta = tidy(a), tb = tidy(b);
  const cut = cutUp(ta, tb);
  if (relationOf(cut) === "inside") return [];
  const kept = [
    ...cut.a.filter((p) => p.side === "out" || p.side === "back"),
    ...cut.b.filter((p) => p.side === "in").map((p) => ({ from: p.to, to: p.from })),
  ];
  const rings = join(kept);
  return rings ? finish(rings, ta, tb, "out") : null;
}

/**
 * The part of ring `a` inside ring `b`: its rings (none when they lie apart), drawn with their inside on the left. Where a
 * border crosses between tile corners, the point moves to a corner inside `b`. Null when the cut cannot be made in whole
 * tiles without breaking a zone rule.
 */
export function ringAnd(a: number[][], b: number[][]): number[][][] | null {
  if (ringRelation(a, b) === "apart") return [];
  const ta = tidy(a), tb = tidy(b);
  const cut = cutUp(ta, tb);
  const relation = relationOf(cut);
  if (relation === "inside") return copy(a);
  if (relation === "around") return copy(b);
  const rings = join([...cut.a.filter(within), ...cut.b.filter((p) => p.side === "in")]);
  return rings ? finish(rings, ta, tb, "in") : null;
}

function side(a: number[], b: number[], c: number[]): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function between(a: number[], b: number[], c: number[]): boolean {
  return Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]);
}

function edgesMeet(a: number[], b: number[], c: number[], d: number[]): boolean {
  const s1 = side(c, d, a), s2 = side(c, d, b), s3 = side(a, b, c), s4 = side(a, b, d);
  if (((s1 > 0 && s2 < 0) || (s1 < 0 && s2 > 0)) && ((s3 > 0 && s4 < 0) || (s3 < 0 && s4 > 0))) return true;
  return (s1 === 0 && between(c, d, a)) || (s2 === 0 && between(c, d, b)) || (s3 === 0 && between(a, b, c)) || (s4 === 0 && between(a, b, d));
}

function foldsBack(from: number[], at: number[], to: number[]): boolean {
  if (same(from, at) || same(at, to)) return true;
  return side(from, at, to) === 0 && (from[0] - at[0]) * (to[0] - at[0]) + (from[1] - at[1]) * (to[1] - at[1]) > 0;
}

/**
 * Whether the rings of an outline cross or touch themselves or each other: two edges meet anywhere but the point two
 * edges of a ring that follow each other share, or an edge runs back along the one before it. The map editor's
 * outlineCrosses is the same rule. A ring may end with its first point again.
 */
export function outlineMeets(outline: number[][][]): boolean {
  const rings = outline.map((ring) => (ring.length > 3 && same(ring[0], ring[ring.length - 1]) ? ring.slice(0, -1) : ring));
  const edges: Array<{ ring: number; index: number; a: number[]; b: number[] }> = [];
  rings.forEach((ring, r) => {
    for (let i = 0; i < ring.length; i++) edges.push({ ring: r, index: i, a: ring[i], b: ring[(i + 1) % ring.length] });
  });
  for (let p = 0; p < edges.length; p++) {
    for (let q = p + 1; q < edges.length; q++) {
      const e = edges[p], f = edges[q];
      if (e.ring === f.ring) {
        if (f.index === e.index + 1) {
          if (foldsBack(e.a, e.b, f.b)) return true;
          continue;
        }
        if (e.index === 0 && f.index === rings[e.ring].length - 1) {
          if (foldsBack(f.a, f.b, e.b)) return true;
          continue;
        }
      }
      if (edgesMeet(e.a, e.b, f.a, f.b)) return true;
    }
  }
  return false;
}
