import type { BlockOwner } from "./blocks";
import type { NodeInfo } from "./nodes";

export type LoginRoute = "here" | { switchTo: NodeInfo };

/** The live nodes are read at most this often: every login asks. */
const LIVE_CACHE_MS = 1000;

export function routeLogin(
  spawn: { map: string; x: number; y: number },
  blocks: { ownerOf(map: string, x: number, y: number): BlockOwner | null } | null,
  live: readonly NodeInfo[],
  self: string
): LoginRoute {
  const owner = blocks?.ownerOf(spawn.map, spawn.x, spawn.y);
  if (!owner || owner.nodeId === self) return "here";
  const target = live.find((node) => node.nodeId === owner.nodeId);
  if (!target || !target.publicHost || !target.wtPort) return "here";
  return { switchTo: target };
}

/** The live nodes, read again once the last read is a second old. Logins at the same moment share one read; a failed read is not kept. */
export class LiveNodeCache {
  private nodes: NodeInfo[] = [];
  private readAt = -Infinity;
  private reading: Promise<NodeInfo[]> | null = null;

  constructor(private read: () => Promise<NodeInfo[]>, private ttlMs = LIVE_CACHE_MS, private now = () => Date.now()) {}

  get(): Promise<NodeInfo[]> {
    if (this.now() - this.readAt < this.ttlMs) return Promise.resolve(this.nodes);
    this.reading ??= this.read()
      .then((nodes) => {
        this.nodes = nodes;
        this.readAt = this.now();
        return nodes;
      })
      .finally(() => { this.reading = null; });
    return this.reading;
  }
}
