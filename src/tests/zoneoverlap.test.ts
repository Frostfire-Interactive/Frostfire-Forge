import { expect, test } from "bun:test";
import { outlineMeets, ringAnd, ringMinus, ringRelation } from "../modules/zoneoverlap";

const rect = (x: number, y: number, w: number, h: number) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const area = (rings: number[][][]) => rings.reduce((sum, ring) => {
  let twice = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) twice += ring[j]![0]! * ring[i]![1]! - ring[i]![0]! * ring[j]![1]!;
  return sum + Math.abs(twice) / 2;
}, 0);
const whole = (rings: number[][][]) => rings.every((ring) => ring.every((p) => Number.isInteger(p[0]) && Number.isInteger(p[1])));

test("rings far apart, sharing an edge or touching at a corner lie apart", () => {
  expect(ringRelation(rect(0, 0, 10, 10), rect(20, 0, 10, 10))).toBe("apart");
  expect(ringRelation(rect(0, 0, 10, 10), rect(10, 0, 10, 10))).toBe("apart");
  expect(ringRelation(rect(0, 0, 10, 10), rect(10, 10, 5, 5))).toBe("apart");
  expect(ringRelation(rect(0, 0, 10, 10), rect(10, 3, 5, 4))).toBe("apart");
});

test("a ring inside another is inside, and the other is around it", () => {
  expect(ringRelation(rect(2, 2, 4, 4), rect(0, 0, 10, 10))).toBe("inside");
  expect(ringRelation(rect(0, 0, 10, 10), rect(2, 2, 4, 4))).toBe("around");
  expect(ringRelation(rect(0, 0, 5, 10), rect(0, 0, 10, 10))).toBe("inside");
  expect(ringRelation(rect(0, 0, 10, 10), rect(0, 0, 10, 10))).toBe("inside");
});

test("rings partly over each other overlap, however they are drawn", () => {
  expect(ringRelation(rect(0, 0, 10, 10), rect(5, 5, 10, 10))).toBe("overlap");
  expect(ringRelation(rect(0, 0, 10, 10).reverse(), rect(5, 5, 10, 10))).toBe("overlap");
  // a plus sign: neither has a point inside the other
  expect(ringRelation(rect(0, 4, 10, 2), rect(4, 0, 2, 10))).toBe("overlap");
});

test("ringMinus leaves a ring apart from the other one as it is", () => {
  expect(ringMinus(rect(0, 0, 10, 10), rect(10, 0, 10, 10))).toEqual([rect(0, 0, 10, 10)]);
});

test("ringMinus cuts a ring back to the other one's edge", () => {
  const cut = ringMinus(rect(0, 0, 10, 10), rect(5, 0, 10, 10))!;
  expect(cut).toHaveLength(1);
  expect(area(cut)).toBe(50);
  expect(ringRelation(cut[0]!, rect(5, 0, 10, 10))).toBe("apart");
});

test("ringMinus moves a cut between tile corners to a corner outside the other ring", () => {
  const slanted = [[5, -1], [12, -1], [12, 11], [3, 11]];
  const cut = ringMinus(rect(0, 0, 10, 10), slanted)!;
  expect(whole(cut)).toBe(true);
  expect(cut.every((ring) => ringRelation(ring, slanted) === "apart")).toBe(true);
  // the exact cut keeps 40 tiles: the corners it moves to lose less than a tile along each edge it cuts
  expect(area(cut)).toBeLessThanOrEqual(40);
  expect(area(cut)).toBeGreaterThan(30);
});

test("ringMinus cuts a ring in two where the other one crosses it", () => {
  const cut = ringMinus(rect(0, 0, 30, 10), rect(10, -5, 10, 20))!;
  expect(cut).toHaveLength(2);
  expect(cut.map((ring) => area([ring])).sort()).toEqual([100, 100]);
  expect(outlineMeets(cut)).toBe(false);
});

test("ringMinus leaves nothing of a ring inside the other one", () => {
  expect(ringMinus(rect(2, 2, 2, 2), rect(0, 0, 10, 10))).toEqual([]);
});

test("ringMinus takes away a sliver that runs over a shared border", () => {
  const bumped = [[0, 0], [10, 0], [10, 4], [12, 5], [10, 6], [10, 10], [0, 10]];
  const cut = ringMinus(bumped, rect(10, 0, 10, 10))!;
  expect(cut).toHaveLength(1);
  expect(area(cut)).toBe(100);
  expect(ringRelation(cut[0]!, rect(10, 0, 10, 10))).toBe("apart");
});

test("ringMinus follows the other ring's points along the cut", () => {
  const notched = [[10, 0], [20, 0], [20, 10], [10, 10], [12, 5]];
  const cut = ringMinus(rect(0, 0, 15, 10), notched)!;
  expect(cut).toHaveLength(1);
  expect(cut[0]).toContainEqual([12, 5]);
  expect(area(cut)).toBe(110);
});

test("ringAnd keeps the part of a ring inside the other one", () => {
  const part = ringAnd(rect(0, 0, 10, 10), rect(5, 5, 10, 10))!;
  expect(part).toHaveLength(1);
  expect(area(part)).toBe(25);
  expect(ringRelation(part[0]!, rect(5, 5, 10, 10))).toBe("inside");
});

test("ringAnd moves a cut between tile corners to a corner inside the other ring", () => {
  const slanted = [[5, -1], [12, -1], [12, 11], [3, 11]];
  const part = ringAnd(rect(0, 0, 10, 10), slanted)!;
  expect(whole(part)).toBe(true);
  expect(part.every((ring) => ringRelation(ring, slanted) === "inside")).toBe(true);
  expect(area(part)).toBeLessThanOrEqual(60);
  expect(area(part)).toBeGreaterThan(50);
});

test("ringAnd of rings apart is nothing", () => {
  expect(ringAnd(rect(0, 0, 10, 10), rect(10, 0, 10, 10))).toEqual([]);
});

test("outlineMeets finds rings that cross or touch themselves or each other", () => {
  expect(outlineMeets([rect(0, 0, 10, 10), rect(20, 0, 5, 5)])).toBe(false);
  expect(outlineMeets([[[0, 0], [10, 10], [10, 0], [0, 10]]])).toBe(true);
  expect(outlineMeets([rect(0, 0, 10, 10), rect(10, 10, 5, 5)])).toBe(true);
  expect(outlineMeets([[[0, 0], [10, 0], [10, 10], [10, 5]]])).toBe(true);
});

// Rings drawn round a middle point, on a small grid so their points and edges often meet exactly
function randomRings(seed: number, count: number): number[][][] {
  let state = seed;
  const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  const rings: number[][][] = [];
  while (rings.length < count) {
    const cx = 10 + Math.floor(next() * 10), cy = 10 + Math.floor(next() * 10);
    const points = 3 + Math.floor(next() * 8);
    const angles = Array.from({ length: points }, () => next() * Math.PI * 2).sort((a, b) => a - b);
    const ring = angles.map((angle) => {
      const radius = 2 + next() * 9;
      return [Math.round(cx + Math.cos(angle) * radius), Math.round(cy + Math.sin(angle) * radius)];
    });
    const flat = ring.every((p, i) => i < 2 || (ring[1]![0]! - ring[0]![0]!) * (p[1]! - ring[0]![1]!) === (ring[1]![1]! - ring[0]![1]!) * (p[0]! - ring[0]![0]!));
    if (!flat && !outlineMeets([ring])) rings.push(ring);
  }
  return rings;
}

test("cuts of random rings are whole tiles, keep out of or inside the other ring and never meet", () => {
  let pairs = 0, cuts = 0, refused = 0;
  for (const seed of [1, 7]) {
    const rings = randomRings(seed, 400);
    for (let i = 0; i + 1 < rings.length; i += 2) {
      const a = rings[i]!, b = rings[i + 1]!;
      if (ringRelation(a, b) !== "overlap") continue;
      pairs++;
      for (const [cut, wanted] of [[ringMinus(a, b), "apart"], [ringAnd(a, b), "inside"]] as const) {
        cuts++;
        if (!cut) { refused++; continue; }
        expect(whole(cut)).toBe(true);
        expect(outlineMeets(cut)).toBe(false);
        for (const ring of cut) expect(ringRelation(ring, b)).toBe(wanted);
        for (let p = 0; p < cut.length; p++) for (let q = p + 1; q < cut.length; q++) expect(ringRelation(cut[p]!, cut[q]!)).toBe("apart");
      }
    }
  }
  expect(pairs).toBeGreaterThan(100);
  expect(refused / cuts).toBeLessThan(0.06);
});
