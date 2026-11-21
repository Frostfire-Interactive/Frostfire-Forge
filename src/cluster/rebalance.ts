import { blockKey, type MapBlocks } from "./blocks";
import type { LoadReport } from "./nodes";

export const REBALANCE_EVERY_MS = 10_000;
export const OVERLOAD_RATIO = 1.08;
export const MIN_OVERLOAD = 25;
export const MIN_BLOCK_AGE_MS = 30_000;
export const NODE_COOLDOWN_MS = 60_000;
export const MOVE_LAG_LIMIT_MS = 250;
export const MOVE_SENDER_LAG_LIMIT_MS = 1000;
/** A block lighter than this share of the sender's overload above the average is not worth a move. */
export const MIN_BLOCK_SHARE = 0.05;
export const MAX_MOVES_PER_PASS = 4;

const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

export interface PlannedMove {
  map: string; bx: number; by: number; from: string; to: string; blockEpoch: number; load: number;
}

export interface RebalanceInput {
  now: number;
  tables: Array<{ map: string; table: MapBlocks }>;
  /** Live nodes' reports only. */
  loads: LoadReport[];
  /** Nodes in an open order, as sender or receiver, and those that took part in a move within NODE_COOLDOWN_MS. */
  busy: ReadonlySet<string>;
  live?: readonly string[];
  noReceiveFrom?: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface RebalanceOptions { ratio?: number; minOverload?: number; minAgeMs?: number; maxMoves?: number }

export function nodeLoad(report: LoadReport): number {
  let total = 0;
  for (const value of Object.values(report.blocks ?? {})) total += Number(value) || 0;
  return total;
}

export function isLagging(report: LoadReport, limit: number = MOVE_LAG_LIMIT_MS): boolean {
  return typeof report.lagMs === "number" && report.lagMs > limit;
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function planRebalance(input: RebalanceInput, opts: RebalanceOptions = {}): PlannedMove[] {
  const ratio = opts.ratio ?? OVERLOAD_RATIO;
  const minOverload = opts.minOverload ?? MIN_OVERLOAD;
  const minAgeMs = opts.minAgeMs ?? MIN_BLOCK_AGE_MS;
  const maxMoves = opts.maxMoves ?? MAX_MOVES_PER_PASS;
  const load = new Map<string, number>();
  const blockLoad = new Map<string, number>();
  const ownerOf = new Map<string, string>();
  for (const { map, table } of input.tables) {
    for (const [key, owner] of Object.entries(table.owners)) {
      if (owner?.nodeId) ownerOf.set(`${map}|${key}`, owner.nodeId);
    }
  }
  for (const report of input.loads) {
    load.set(report.nodeId, nodeLoad(report));
    for (const [key, value] of Object.entries(report.blocks ?? {})) {
      if (ownerOf.get(key) === report.nodeId) blockLoad.set(key, (Number(value) || 0));
    }
  }
  // Every node the average is taken over: a live node with no report counts at load 0.
  const all = new Map(load);
  for (const nodeId of input.live ?? []) if (!all.has(nodeId)) all.set(nodeId, 0);
  if (all.size < 2) return [];
  let sum = 0;
  for (const value of all.values()) sum += value;
  const average = sum / all.size;
  // No load anywhere: nothing is over the ratio, and no block passes hysteresis for an empty node.
  if (average <= 0) return [];
  const busy = new Set(input.busy);
  // A lagging node receives nothing (noReceive); one far behind gives nothing either (busy).
  const noReceive = new Set<string>();
  for (const report of input.loads) {
    if (isLagging(report)) noReceive.add(report.nodeId);
    if (isLagging(report, MOVE_SENDER_LAG_LIMIT_MS)) busy.add(report.nodeId);
  }
  const moves: PlannedMove[] = [];
  if (input.live) seedEmpty(input, all, blockLoad, minAgeMs, maxMoves, busy, noReceive, moves);
  const over = [...load]
    .filter(([, value]) => value > ratio * average && value - average >= minOverload)
    .sort((a, b) => b[1] - a[1] || byName(a[0], b[0]));
  for (const [from, fromLoad] of over) {
    if (moves.length >= maxMoves) break;
    if (busy.has(from)) continue;
    let best: (PlannedMove & { toLoad: number }) | null = null;
    for (const { map, table } of input.tables) {
      for (const [key, owner] of Object.entries(table.owners)) {
        if (owner?.nodeId !== from || input.now - owner.since < minAgeMs) continue;
        const weight = blockLoad.get(`${map}|${key}`) ?? 0;
        if (weight <= 0 || weight < MIN_BLOCK_SHARE * (fromLoad - average)) continue;
        const [bx, by] = key.split(",").map(Number) as [number, number];
        for (const [dx, dy] of NEIGHBOURS) {
          const to = table.owners[blockKey(bx + dx, by + dy)]?.nodeId;
          if (!to || to === from || busy.has(to) || noReceive.has(to) || !load.has(to)) continue;
          if (input.noReceiveFrom?.get(from)?.has(to)) continue;
          const toLoad = load.get(to)!;
          // The neighbour must stay below the sender, or the block would only move the overload.
          if (toLoad + weight >= fromLoad - weight) continue;
          const candidate = { map, bx, by, from, to, blockEpoch: owner.epoch, load: weight, toLoad };
          if (!best || better(candidate, best)) best = candidate;
        }
      }
    }
    if (!best) continue;
    const { toLoad: _toLoad, ...move } = best;
    moves.push(move);
    busy.add(from);
    busy.add(move.to);
  }
  return moves;
}

function seedEmpty(
  input: RebalanceInput,
  load: ReadonlyMap<string, number>,
  blockLoad: ReadonlyMap<string, number>,
  minAgeMs: number,
  maxMoves: number,
  busy: Set<string>,
  noReceive: ReadonlySet<string>,
  moves: PlannedMove[],
): void {
  const owned = new Map<string, number>();
  for (const { table } of input.tables) {
    for (const owner of Object.values(table.owners)) {
      if (owner?.nodeId) owned.set(owner.nodeId, (owned.get(owner.nodeId) ?? 0) + 1);
    }
  }
  const empty = [...load.keys()].filter((nodeId) => !owned.has(nodeId)).sort(byName);
  for (const to of empty) {
    if (moves.length >= maxMoves) return;
    if (busy.has(to) || noReceive.has(to)) continue;
    const toLoad = load.get(to) ?? 0;
    const givers = [...load]
      .filter(([nodeId]) => nodeId !== to && (owned.get(nodeId) ?? 0) >= 2 && !busy.has(nodeId))
      .sort((a, b) => b[1] - a[1] || byName(a[0], b[0]));
    for (const [from, fromLoad] of givers) {
      if (input.noReceiveFrom?.get(from)?.has(to)) continue;
      let best: (PlannedMove & { edge: boolean }) | null = null;
      for (const { map, table } of input.tables) {
        for (const [key, owner] of Object.entries(table.owners)) {
          if (owner?.nodeId !== from || input.now - owner.since < minAgeMs) continue;
          const weight = blockLoad.get(`${map}|${key}`) ?? 0;
          if (toLoad + weight >= fromLoad - weight) continue;
          const [bx, by] = key.split(",").map(Number) as [number, number];
          const edge = NEIGHBOURS.some(([dx, dy]) => table.owners[blockKey(bx + dx, by + dy)]?.nodeId !== from);
          const candidate = { map, bx, by, from, to, blockEpoch: owner.epoch, load: weight, edge };
          if (!best || seedsBetter(candidate, best)) best = candidate;
        }
      }
      if (!best) continue;
      const { edge: _edge, ...move } = best;
      moves.push(move);
      busy.add(from);
      busy.add(to);
      break;
    }
  }
}

function seedsBetter(a: PlannedMove & { edge: boolean }, b: PlannedMove & { edge: boolean }): boolean {
  if (a.edge !== b.edge) return a.edge;
  if (a.load !== b.load) return a.load > b.load;
  return byName(`${a.map}|${a.bx},${a.by}`, `${b.map}|${b.bx},${b.by}`) < 0;
}

// The least loaded neighbour first; then the heavier block (one move does more); then by name, so a plan is stable.
function better(a: PlannedMove & { toLoad: number }, b: PlannedMove & { toLoad: number }): boolean {
  if (a.toLoad !== b.toLoad) return a.toLoad < b.toLoad;
  if (a.load !== b.load) return a.load > b.load;
  return byName(`${a.map}|${a.bx},${a.by}|${a.to}`, `${b.map}|${b.bx},${b.by}|${b.to}`) < 0;
}
