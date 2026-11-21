import log from "../modules/logger";
import { linkCalls, type LinkCalls } from "./linkcalls";
import { tradeSettle, type TradeSettle } from "./tradesettle";

/** The answer to a trade invitation, sent by the node of the one who answered to the asker's node. */
export interface TradeAnswer {
  /** The asker, and their id on the host. */
  asker: string;
  askerId: string;
  authorization: string;
  /** The one who answered, on the node that sends this. */
  partner: string;
  partnerId: string;
  accepted: boolean;
  /** The partner's node's stamp for the trade this answer may open. Every cast and update of the trade carries it. */
  stamp?: string;
}
export type TradeOp = "offer" | "accept" | "cancel" | "leave";
export interface TradeUpdate {
  username: string;
  op: TradeOp;
  /** TRADE_OFFER's packet body, for "offer". */
  offer?: unknown;
  /** The trade's stamp. */
  stamp?: string;
}
export interface TradeReply {
  ok: boolean;
  /** What the asked player is told. */
  reason?: string;
  /** TP_ANSWER: a trade was opened. */
  opened?: boolean;
  /** TP_UPDATE: the host holds no trade of theirs. */
  gone?: boolean;
  /** TP_UPDATE: the trade is being swapped, and cannot be cancelled now. Its end is cast when the swap is done. */
  settling?: boolean;
  /** sendUpdate: the end of the trade arrived while it was waited for, and has been shown to the player. */
  closed?: boolean;
}
export interface TradeStateCast {
  username: string;
  /** The TRADE_STATE packet body (systems/trades.ts TradeView). */
  state: unknown;
  stamp?: string;
}
export interface TradeClosedCast {
  username: string;
  completed: boolean;
  message: string;
  /** The offers changed hands: the player's bags and coins are read again. */
  reload: boolean;
  stamp?: string;
}
export interface TradeLost {
  role: "host" | "partner";
  username: string;
  peer: string;
}
export interface TradeHandlers {
  /** Host: the asked player answered an invitation of a player of this node. */
  answer(body: TradeAnswer, from: string): Promise<TradeReply>;
  /** Host: the asked player changed the trade held here. */
  update(body: TradeUpdate, from: string): Promise<TradeReply>;
  /** Partner's node: the trade as it stands for its player. */
  state(body: TradeStateCast): void | Promise<void>;
  /** Partner's node: its player's trade ended. */
  closed(body: TradeClosedCast): void | Promise<void>;
  /** The link to `peer` went down with a trade across it. Task 14 ends the trade and reloads the bags. */
  lost?(body: TradeLost): void | Promise<void>;
}

/** How long (ms) the partner's node waits for the end of a trade that was being swapped when it let go of it. */
export const SETTLE_WAIT_MS = 30_000;
export const TRADE_UNREACHABLE = "The trade could not be reached. Your bags show what you hold now.";
/** Told to a player who answers or accepts a trade while a lost trade of theirs (or their partner's) is settling. */
export const TRADE_SETTLING = "A trade that was cut off is still being settled. Try again in a moment.";
const ANSWER_UNREACHABLE = "Unable to process invitation - user not found or has disconnected";
const NOT_TRADING = "You are not trading.";
const lower = (name: unknown) => String(name ?? "").toLowerCase();

/** Partner's node: the trade of one of its players held elsewhere. */
interface HostEntry {
  peer: string;
  stamp: string;
  /** The trade as its host last sent it (TP_STATE). */
  state?: unknown;
  /** How many updates of this trade are on their way to the host. */
  inflight?: number;
  accepted?: boolean;
  /** How many accepts of this trade are on their way to the host (sent, and not yet answered). */
  acceptsInFlight?: number;
  acceptUnshown?: boolean;
}

/** Host: an asked player of a neighbouring node. */
interface PartnerEntry {
  peer: string;
  stamp: string;
  /** The player of this node who asked them, once the trade opened. */
  asker?: string;
}

export class TradeLink {
  /** Host: an asked player of a neighbouring node, their node, and the trade's stamp. */
  private partners = new Map<string, PartnerEntry>();
  private hosts = new Map<string, HostEntry>();
  /** Partner's node: a player whose trade was being swapped, and the wait for its end. */
  private waiting = new Map<string, { host: HostEntry; end: (closed: boolean) => void }>();
  private handlers: TradeHandlers | null = null;

  constructor(
    private readonly calls: LinkCalls,
    private readonly settleWaitMs = SETTLE_WAIT_MS,
    private readonly fence: TradeSettle = tradeSettle,
  ) {
    calls.handle("TP_ANSWER", async (body: TradeAnswer, from) => {
      if (!this.handlers) return { ok: false, reason: ANSWER_UNREACHABLE };
      // A trade opened now would be swapped here, from rows of a marked player that may predate a lost swap.
      if (body?.accepted && (this.fence.unsettled(body.asker) || this.fence.unsettled(body.partner))) {
        log.info(`The answer of ${lower(body.partner)} to the trade invitation of ${lower(body.asker)} was refused: a lost trade is settling`);
        return { ok: false, reason: TRADE_SETTLING };
      }
      const reply = await this.handlers.answer(body, from);
      // The asker is kept with the partner, so that an accept of theirs is refused while the asker is marked.
      const partner = reply?.opened ? this.partners.get(lower(body.partner)) : undefined;
      if (partner && partner.peer === from) partner.asker = lower(body.asker);
      return reply;
    });
    calls.handle("TP_UPDATE", (body: TradeUpdate, from) => {
      // Only the node the asked player is on speaks for them.
      const partner = this.partners.get(lower(body?.username));
      if (!this.handlers || partner?.peer !== from || partner.stamp !== (body?.stamp ?? "")) {
        log.warn(`Trade update "${body?.op}" for ${lower(body?.username)} from ${from} refused: no trade of theirs is held here for that node`);
        return { ok: false, gone: true, reason: NOT_TRADING };
      }
      // An accept could start the swap here, which reads the rows of both players.
      if (body.op === "accept" && (this.fence.unsettled(body.username) || (partner.asker && this.fence.unsettled(partner.asker)))) {
        log.info(`The accept of ${lower(body.username)} from ${from} was refused: a lost trade is settling`);
        return { ok: false, reason: TRADE_SETTLING };
      }
      return this.handlers.update({ ...body, username: lower(body.username) }, from);
    });
    calls.onCast("TP_STATE", (body: TradeStateCast, from) => {
      if (!this.fromHost(lower(body?.username), from, body?.stamp)) {
        log.info(`The trade window of ${lower(body?.username)} from ${from} was dropped: that node holds no trade of theirs`);
        return;
      }
      // Kept, so that a player whose own action is refused here can be shown the trade as the host holds it again.
      const host = this.hosts.get(lower(body?.username))!;
      host.state = body.state;
      if (!host.acceptsInFlight) host.acceptUnshown = false;
      this.run(() => this.handlers?.state(body));
    });
    calls.onCast("TP_CLOSED", (body: TradeClosedCast, from) => {
      const name = lower(body?.username);
      if (!this.fromHost(name, from, body?.stamp)) {
        log.info(`The end of the trade of ${name} from ${from} was dropped: that node holds no trade of theirs`);
        return;
      }
      this.hosts.delete(name);
      // Whoever waits for this end is released once it has been shown and the bags are read again.
      void this.run(() => this.handlers?.closed(body)).then(() => this.waiting.get(name)?.end(true));
    });
    calls.onPeerDown((peer) => this.peerDown(peer));
  }

  setHandlers(handlers: TradeHandlers | null): void {
    this.handlers = handlers;
  }

  partnerPeer(username: string): string | null {
    return this.partners.get(lower(username))?.peer ?? null;
  }

  /** Host: the asked player is on `peer`, and the trade they answered for carries `stamp` (the one in their TP_ANSWER). */
  setPartner(username: string, peer: string, stamp = ""): void {
    this.partners.set(lower(username), { peer, stamp });
  }

  dropPartner(username: string): void {
    this.partners.delete(lower(username));
  }

  /** Partner's node: the node that holds this node's player's trade. Null when no trade is held elsewhere. */
  hostOf(username: string): string | null {
    return this.hosts.get(lower(username))?.peer ?? null;
  }

  /** Partner's node: the trade of this node's player as its host last sent it (TP_STATE), which is what a swap would make. Null before the first. */
  lastState(username: string): unknown | null {
    return this.hosts.get(lower(username))?.state ?? null;
  }

  acceptSent(username: string): boolean {
    return this.hosts.get(lower(username))?.acceptUnshown === true;
  }

  /** Records a host for a player, as an accepted answer does, and (`accepted`) that they sent an accept. For tests. */
  setHost(username: string, peer: string, stamp = "", accepted = false): void {
    this.hosts.set(lower(username), { peer, stamp, accepted });
  }

  dropHost(username: string): void {
    this.hosts.delete(lower(username));
  }

  /** Partner's node: the answer of its player to an invitation held on `peer`. The host is kept only when a trade opened. */
  async sendAnswer(peer: string, body: TradeAnswer): Promise<TradeReply> {
    const name = lower(body.partner);
    // The host would swap from this player's rows in the shared cache, which their mark here does not fence.
    if (body.accepted && this.fence.unsettled(name)) return { ok: false, reason: TRADE_SETTLING };
    // A trade this player already has is not touched by an answer that opens none (a second invitation declined).
    const had = this.hosts.has(name);
    const mine = { peer, stamp: crypto.randomUUID() };
    // Recorded before asking: the host sends the trade's first TP_STATE before it answers.
    if (body.accepted && !had) this.hosts.set(name, mine);
    const sent = await this.calls.call<TradeReply>(peer, "TP_ANSWER", { ...body, stamp: mine.stamp });
    const reply: TradeReply = sent.ok && sent.answer ? sent.answer : { ok: false, reason: ANSWER_UNREACHABLE };
    // An answer that did not arrive may still have opened a trade there. It is not asked again: it is ended by its asker, or by the sweep.
    if (body.accepted && !sent.ok) log.warn(`The answer of ${name} to the trade invitation of ${lower(body.asker)} on ${peer} ended ${sent.why}: a trade may be open there that ${name} is not shown`);
    if (body.accepted && !had && !reply.opened && this.hosts.get(name) === mine) this.hosts.delete(name);
    return reply;
  }

  /** Partner's node: its player acts on their trade held elsewhere. Null when no trade of theirs is held elsewhere. */
  async sendUpdate(username: string, op: TradeOp, offer?: unknown): Promise<TradeReply | null> {
    const name = lower(username);
    const host = this.hosts.get(name);
    if (!host) return null;
    // Not sent: the swap it could start would read this player's rows on the host, past their mark here.
    if (op === "accept" && this.fence.unsettled(name)) return { ok: false, reason: TRADE_SETTLING };
    // Recorded before it is sent: an accept that is not answered may still have arrived.
    if (op === "accept") {
      host.accepted = true;
      host.acceptUnshown = true;
      host.acceptsInFlight = (host.acceptsInFlight ?? 0) + 1;
    }
    host.inflight = (host.inflight ?? 0) + 1;
    try {
      const { peer, stamp } = host;
      // One who leaves is done with the trade, whatever its host answers.
      if (op === "leave") this.hosts.delete(name);
      const sent = await this.calls.call<TradeReply>(peer, "TP_UPDATE", offer === undefined ? { username: name, op, stamp } : { username: name, op, offer, stamp });
      if (!sent.ok) {
        log.warn(`The trade update "${op}" of ${name} to ${peer} ended ${sent.why}: the trade is ended for ${name} here, and may still be open there`);
        if (op !== "leave") {
          const followed = await this.calls.call<TradeReply>(peer, "TP_UPDATE", { username: name, op: "cancel", stamp });
          // The swap is under way there and goes on. Its end is cast with the reload that is right: wait for it.
          if (followed.ok && followed.answer?.settling && this.hosts.get(name) === host) {
            if (await this.awaitEnd(name, host)) return { ok: false, gone: true, closed: true };
            log.warn(`The end of the trade of ${name} did not arrive from ${peer} within ${this.settleWaitMs} ms of a swap that was under way (or the link went down): their bags and coins are read again now`);
          }
        }
        if (this.hosts.get(name) === host) this.hosts.delete(name);
        return { ok: false, gone: true, reason: TRADE_UNREACHABLE };
      }
      if (sent.answer?.gone && this.hosts.get(name) === host) this.hosts.delete(name);
      return sent.answer;
    } finally {
      host.inflight = Math.max(0, (host.inflight ?? 1) - 1);
      if (op === "accept") host.acceptsInFlight = Math.max(0, (host.acceptsInFlight ?? 1) - 1);
    }
  }

  /** Host: the trade as it stands for an asked player of a neighbouring node. False when they are not one, or the cast was not sent. */
  sendState(username: string, state: unknown): boolean {
    const peer = this.partnerPeer(username);
    if (!peer) return false;
    const sent = this.calls.cast(peer, "TP_STATE", { username: lower(username), state, stamp: this.partners.get(lower(username))?.stamp });
    if (!sent) log.warn(`The trade window of ${lower(username)} could not be sent to ${peer}: the link is down`);
    return sent;
  }

  /** Host: the trade of an asked player of a neighbouring node ended. They stop being a partner here either way. */
  sendClosed(username: string, closed: Omit<TradeClosedCast, "username" | "stamp">): boolean {
    const peer = this.partnerPeer(username);
    const stamp = this.partners.get(lower(username))?.stamp;
    this.dropPartner(username);
    if (!peer) return false;
    const sent = this.calls.cast(peer, "TP_CLOSED", { username: lower(username), ...closed, stamp });
    // Their node finds out the next time they act on the trade, and a swap's reload is not made until then.
    if (!sent) log.warn(`The end of the trade of ${lower(username)} could not be sent to ${peer}: the link is down${closed.reload ? ", and their bags and coins are not read again there" : ""}`);
    return sent;
  }

  peerDown(peer: string): void {
    for (const [name, partner] of [...this.partners]) {
      if (partner.peer !== peer) continue;
      this.partners.delete(name);
      log.warn(`The link to ${peer} went down: the trade with ${name} is ended here`);
      void this.run(() => this.handlers?.lost?.({ role: "host", username: name, peer }));
    }
    for (const [name, host] of [...this.hosts]) {
      if (host.peer !== peer) continue;
      if (host.accepted) void this.fence.unsettle(name, "the link went down with their accepted trade held there", peer);
      this.hosts.delete(name);
      if (host.inflight) continue;
      log.warn(`The link to ${peer} went down: the trade of ${name} held there is ended here`);
      void this.run(() => this.handlers?.lost?.({ role: "partner", username: name, peer }));
    }
    for (const wait of [...this.waiting.values()]) {
      if (wait.host.peer === peer) wait.end(false);
    }
  }

  /** Forgets every partner, host and handler. For tests. */
  reset(): void {
    for (const wait of [...this.waiting.values()]) wait.end(false);
    this.partners.clear();
    this.hosts.clear();
    this.handlers = null;
  }

  /** Whether a cast about `name`'s trade came from the node and the trade recorded for them. */
  private fromHost(name: string, from: string, stamp: unknown): boolean {
    const host = this.hosts.get(name);
    return !!host && host.peer === from && host.stamp === (stamp ?? "");
  }

  private awaitEnd(name: string, host: HostEntry): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const end = (closed: boolean) => {
        clearTimeout(timer);
        if (this.waiting.get(name)?.end === end) this.waiting.delete(name);
        resolve(closed);
      };
      const timer = setTimeout(() => end(false), this.settleWaitMs);
      this.waiting.set(name, { host, end });
    });
  }

  private run(work: () => void | Promise<void>): Promise<void> {
    const failed = (error: unknown) => log.warn(`A trade message from a neighbouring node could not be handled: ${error}`);
    try {
      return Promise.resolve(work()).catch(failed);
    } catch (error) {
      failed(error);
      return Promise.resolve();
    }
  }
}

/** The node's trade link. Its handlers are registered on `linkCalls`, and do nothing until the links are attached. */
export const tradeLink = new TradeLink(linkCalls);
