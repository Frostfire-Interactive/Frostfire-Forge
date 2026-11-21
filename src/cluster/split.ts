export function splitBlocks(
  blocksX: number,
  blocksY: number,
  nodeIds: string[],
  weight?: (bx: number, by: number) => number,
): Map<string, string> {
  const split = new Map<string, string>();
  const nodes = [...new Set(nodeIds)].sort();
  if (nodes.length === 0 || blocksX <= 0 || blocksY <= 0) return split;

  // The walk: lines along the longer side, so the cut between two runs crosses the shorter one.
  const acrossX = blocksX >= blocksY;
  const lines = acrossX ? blocksX : blocksY;
  const breadth = acrossX ? blocksY : blocksX;
  const walk: Array<[number, number]> = [];
  for (let line = 0; line < lines; line++) {
    for (let step = 0; step < breadth; step++) {
      const across = line % 2 === 0 ? step : breadth - 1 - step;
      walk.push(acrossX ? [line, across] : [across, line]);
    }
  }

  // Each block's weight once, in walk order. All weightless counts the blocks as equal.
  let weights = walk.map(([bx, by]) => {
    const value = weight ? Number(weight(bx, by)) : 1;
    return Number.isFinite(value) && value > 0 ? value : 0;
  });
  let total = weights.reduce((a, b) => a + b, 0);
  if (total === 0) {
    weights = weights.map(() => 1);
    total = weights.length;
  }

  // A block belongs to the node whose share of the total holds the block's midpoint.
  let before = 0;
  for (let i = 0; i < walk.length; i++) {
    const index = Math.min(nodes.length - 1, Math.floor(((before + weights[i]! / 2) * nodes.length) / total));
    const [bx, by] = walk[i]!;
    split.set(`${bx},${by}`, nodes[index]!);
    before += weights[i]!;
  }
  return split;
}
