import log from "../modules/logger";
import type { ClusterBus } from "./bus";

export type NewsHandler = (data: any, from: string) => unknown;

/** The bus kind all news travels as. */
export const PEER_NEWS = "peer-news";

export class PeerNews {
  private handlers = new Map<string, NewsHandler>();
  private state: { bus: ClusterBus; self: string; region: string } | null = null;

  /** Who carries out a news here; null takes the handler off. */
  on(name: string, handler: NewsHandler | null): void {
    if (handler) this.handlers.set(name, handler);
    else this.handlers.delete(name);
  }

  attach(bus: ClusterBus, self: string, region: string): void {
    this.state = { bus, self, region };
    // The world channel reaches every region, and the sender too: neither is to carry it out.
    bus.on(PEER_NEWS, async (data, from) => {
      if (this.state?.bus !== bus || from === self || data?.region !== region) return;
      const name = String(data?.name ?? "");
      const handler = this.handlers.get(name);
      if (!handler) {
        log.debug(`Cluster news "${name}" from ${from}: nothing carries it out here`);
        return;
      }
      try {
        await handler(data?.data, from);
      } catch (error) {
        log.error(`Cluster news "${name}" from ${from} could not be carried out here: ${error}`);
      }
    });
  }

  detach(): void {
    this.state = null;
  }

  /** Tells the region's other nodes. Whether it went: never outside cluster mode. */
  async tell(name: string, data: unknown): Promise<boolean> {
    const state = this.state;
    if (!state) return false;
    try {
      await state.bus.toWorld(PEER_NEWS, { name, region: state.region, data });
      return true;
    } catch (error) {
      log.warn(`The other nodes could not be told of "${name}", so it holds on this node only: ${error}`);
      return false;
    }
  }
}

/** This node's news, attached while the cluster runs (cluster/index.ts). */
export const peerNews = new PeerNews();
export const tellPeers = (name: string, data: unknown): Promise<boolean> => peerNews.tell(name, data);
export const onPeerNews = (name: string, handler: NewsHandler | null): void => peerNews.on(name, handler);
