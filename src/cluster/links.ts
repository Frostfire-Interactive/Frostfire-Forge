import log from "../modules/logger";
import { HelloNonces, checkHello, decodeLinkFrame, encodeLinkFrame, makeHello } from "./linkproto";
import type { LinkChannel, LinkSender, LinkTransport } from "./linktransport";
import type { NodeInfo } from "./nodes";

const CONTROL_CALL_KINDS: ReadonlySet<string> = new Set(["CALL", "ANSWER", "CAST"]);
export const isControlKind = (kind: string): boolean => kind.startsWith("LINK_") || CONTROL_CALL_KINDS.has(kind);

export const LINK_PING_MS = 500;
export const LINK_DEAD_MS = 1500;
/** How long the dialler waits for its node lookup and for LINK_OK. */
const HELLO_TIMEOUT_MS = 3000;
/** How long an accepted channel may stay silent before its LINK_HELLO (M1: a stranger holds a session this long at most). */
export const PRE_HELLO_MS = 1000;
const LINGER_MS = 10_000;
const REDIAL_MIN_MS = 250;
const REDIAL_MAX_MS = 5000;
/** Each redial delay is the backoff ±20%, so the neighbours of a restarted node do not dial in lockstep. */
const REDIAL_JITTER = 0.2;

export interface NodeLinksOptions {
  self: string;
  secret: string;
  transport: LinkTransport;
  nodeInfo: (nodeId: string) => Promise<NodeInfo | null>;
  pingMs?: number;
  deadMs?: number;
  lingerMs?: number;
  helloTimeoutMs?: number;
  /** How long an accepted channel waits for its LINK_HELLO. */
  preHelloMs?: number;
  now?: () => number;
}

interface Peer {
  id: string;
  channel: LinkChannel | null;
  up: boolean;
  upAt: number;
  heardAt: number;
  wanted: boolean;
  unwantedAt: number;
  dialing: boolean;
  redialAt: number;
  redialTimer: ReturnType<typeof setTimeout> | null;
  backoff: number;
  failures: number;
}

type Handler = (data: any, from: string) => void;
type Timer = ReturnType<typeof setTimeout>;

/** The ids linkproto can sign: ":" separates the signed fields. */
const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && !id.includes(":");

export class NodeLinks implements LinkSender {
  readonly self: string;
  private peersById = new Map<string, Peer>();
  private handlers = new Map<string, Handler>();
  private datagramHandlers: Array<(data: Uint8Array, from: string) => void> = [];
  private upHandlers: Array<(peer: string) => void> = [];
  private downHandlers: Array<(peer: string) => void> = [];
  private nonces = new HelloNonces();
  private timer: ReturnType<typeof setInterval> | null = null;
  private timers = new Set<Timer>();
  private lastTickAt = 0;
  private skippedJudging = false;
  private started = false;
  private stopped = false;
  private readonly now: () => number;
  private readonly pingMs: number;
  private readonly deadMs: number;
  private readonly lingerMs: number;
  private readonly helloTimeoutMs: number;
  private readonly preHelloMs: number;

  constructor(private readonly options: NodeLinksOptions) {
    if (!validId(options.self)) throw new Error(`Node links: "${options.self}" is not a usable node id (empty, or holds ':')`);
    this.self = options.self;
    this.now = options.now ?? Date.now;
    this.pingMs = options.pingMs ?? LINK_PING_MS;
    this.deadMs = options.deadMs ?? LINK_DEAD_MS;
    this.lingerMs = options.lingerMs ?? LINGER_MS;
    this.helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
    this.preHelloMs = options.preHelloMs ?? PRE_HELLO_MS;
  }

  /** Listens for neighbours. Throws when the transport cannot listen, and on a second call. */
  async start(): Promise<void> {
    if (this.started || this.stopped) throw new Error("Node links: start() runs once, before stop()");
    this.started = true;
    await this.options.transport.listen((channel) => this.accept(channel));
    if (this.stopped) {
      // stop() ran while the listener was opening, and may have stopped the transport before it was up.
      await this.options.transport.stop();
      return;
    }
    this.timer = setInterval(() => this.tick(), this.pingMs);
    (this.timer as any).unref?.();
    // Neighbours wanted before start are dialled now.
    this.tick();
  }

  /** The neighbours to link with now. Others linger for `lingerMs`, then go. */
  want(peers: Iterable<string>): void {
    const wanted = new Set<string>();
    for (const id of peers) {
      if (validId(id)) wanted.add(id);
      else log.warn(`Node links: ignoring neighbour "${id}", not a usable node id`);
    }
    wanted.delete(this.self);
    const now = this.now();
    for (const id of wanted) {
      const peer = this.peer(id);
      peer.wanted = true;
      peer.unwantedAt = 0;
    }
    for (const peer of this.peersById.values()) {
      if (wanted.has(peer.id) || !peer.wanted) continue;
      peer.wanted = false;
      peer.unwantedAt = now;
    }
    // Dial and drop at once, but leave silence to the timer: a call right after a stall must not judge it.
    this.tick(false);
  }

  isUp(peer: string): boolean {
    return this.peersById.get(peer)?.up ?? false;
  }

  /** Peers whose link is up, sorted. */
  peers(): string[] {
    return [...this.peersById.values()].filter((peer) => peer.up).map((peer) => peer.id).sort();
  }

  send(peer: string, kind: string, data: unknown): boolean {
    const target = this.peersById.get(peer);
    if (!target?.up || !target.channel) return false;
    return target.channel.send(encodeLinkFrame(kind, data), isControlKind(kind));
  }

  sendDatagram(peer: string, data: Uint8Array): boolean {
    const target = this.peersById.get(peer);
    if (!target?.up || !target.channel) return false;
    return target.channel.sendDatagram(data);
  }

  on(kind: string, handler: Handler): void {
    if (kind.startsWith("LINK_")) throw new Error(`Node links: "${kind}" is reserved`);
    if (this.handlers.has(kind)) throw new Error(`Node links: "${kind}" already has a handler`);
    this.handlers.set(kind, handler);
  }

  onDatagram(handler: (data: Uint8Array, from: string) => void): void { this.datagramHandlers.push(handler); }
  /** Also runs when a peer's link is replaced by a new HELLO (it may have restarted): treat it as a reset. */
  onPeerUp(handler: (peer: string) => void): void { this.upHandlers.push(handler); }
  onPeerDown(handler: (peer: string) => void): void { this.downHandlers.push(handler); }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const peer of this.peersById.values()) this.drop(peer, "stopping", false);
    this.peersById.clear();
    await this.options.transport.stop();
  }

  private peer(id: string): Peer {
    let peer = this.peersById.get(id);
    if (!peer) {
      peer = {
        id, channel: null, up: false, upAt: 0, heardAt: 0, wanted: false, unwantedAt: 0,
        dialing: false, redialAt: 0, redialTimer: null, backoff: REDIAL_MIN_MS, failures: 0,
      };
      this.peersById.set(id, peer);
    }
    return peer;
  }

  private forget(peer: Peer): void {
    if (peer.redialTimer) this.cancel(peer.redialTimer);
    peer.redialTimer = null;
    this.peersById.delete(peer.id);
  }

  private tick(fromTimer = true): void {
    if (this.stopped || !this.timer) return;
    const now = this.now();
    let judge = false;
    if (fromTimer) {
      const late = this.lastTickAt > 0 && now - this.lastTickAt > this.pingMs * 2;
      judge = !late || this.skippedJudging;
      this.skippedJudging = !judge;
      this.lastTickAt = now;
    }
    for (const peer of [...this.peersById.values()]) {
      const dialler = this.self < peer.id;
      // Only a link that held for a while earns a fresh backoff: one that dies at once keeps backing off.
      if (peer.up && peer.backoff !== REDIAL_MIN_MS && now - peer.upAt >= this.deadMs * 2) peer.backoff = REDIAL_MIN_MS;
      if (judge && peer.up && now - peer.heardAt > this.deadMs) {
        log.warn(`Node link to ${peer.id} went silent; dropping it`);
        this.drop(peer, "silent", true);
      }
      if (!peer.wanted && (dialler ? !peer.channel || now - peer.unwantedAt >= this.lingerMs : !peer.channel)) {
        this.drop(peer, "not a neighbour", true);
        this.forget(peer);
        continue;
      }
      if (peer.up && peer.channel) peer.channel.send(encodeLinkFrame("LINK_PING", {}), true);
      if (peer.wanted && dialler && !peer.up && !peer.dialing && !peer.channel && now >= peer.redialAt) {
        void this.dial(peer);
      }
    }
  }

  private async dial(peer: Peer): Promise<void> {
    peer.dialing = true;
    try {
      const info = await this.within(this.options.nodeInfo(peer.id), this.helloTimeoutMs, "no node info");
      if (!info?.linkPort) throw new Error("it has no link port");
      const channel = await this.options.transport.dial({ host: info.linkHost || info.publicHost, port: info.linkPort, certHash: info.certHash ?? "" });
      // Stopped, given up on (no longer wanted), or linked another way while the dial was out.
      if (this.stopped || this.peersById.get(peer.id) !== peer || peer.channel) {
        channel.close("not needed");
        return;
      }
      peer.channel = channel;
      this.listenOn(channel, peer.id);
      channel.send(encodeLinkFrame("LINK_HELLO", makeHello(this.options.secret, this.self, peer.id, this.now())), true);
      this.after(this.helloTimeoutMs, () => {
        if (peer.channel === channel && !peer.up) this.drop(peer, "no LINK_OK", true);
      });
    } catch (error) {
      this.failed(peer, String(error));
      this.backOff(peer);
    } finally {
      peer.dialing = false;
    }
  }

  private accept(channel: LinkChannel): void {
    if (this.stopped) {
      channel.close("stopping");
      return;
    }
    let known: string | null = null;
    const timer = this.after(this.preHelloMs, () => { if (!known) channel.close("no hello"); });
    channel.start({
      frame: (payload) => {
        if (known) return this.frame(payload, known, channel);
        const frame = decodeLinkFrame(payload);
        const from = frame?.t === "LINK_HELLO" ? checkHello(this.options.secret, frame.d, this.self, this.now(), this.nonces) : null;
        this.cancel(timer);
        if (!from) {
          // Never log the secret or the signature: the likely causes are enough to act on.
          const why = frame?.t === "LINK_HELLO" ? "bad LINK_HELLO (wrong secret, clock skew over 10 s, or a replay)" : "the first frame was not a LINK_HELLO";
          log.warn(`Node link from ${channel.remote} refused: ${why}`);
          channel.close("bad hello");
          return;
        }
        if (from > this.self) {
          // Only the smaller id dials. Taking this one would replace the link we dialled ourselves.
          log.warn(`Node link from ${from} refused: ${from} > ${this.self}, so ${this.self} dials, not ${from}`);
          channel.close("wrong dialler");
          return;
        }
        const peer = this.peer(from);
        const old = peer.channel;
        if (old && old !== channel && peer.up && this.now() - peer.heardAt <= this.deadMs) {
          log.warn(`Node link from ${from} refused: its link is up and live, so it is not replaced`);
          channel.close("link already up");
          // Taken by peer() for a peer that was already there: nothing new to forget.
          return;
        }
        known = from;
        peer.channel = channel;
        // The gate before the hello (wtlinks.ts) frees this channel's place: it is a peer now.
        channel.authenticated?.();
        if (old && old !== channel) old.close("replaced");
        channel.send(encodeLinkFrame("LINK_OK", { from: this.self }), true);
        this.markUp(peer);
      },
      datagram: (data) => { if (known) this.datagram(data, known, channel); },
      closed: (reason) => { if (known) this.closed(known, channel, reason); },
    });
  }

  private listenOn(channel: LinkChannel, peerId: string): void {
    channel.start({
      frame: (payload) => this.frame(payload, peerId, channel),
      datagram: (data) => this.datagram(data, peerId, channel),
      closed: (reason) => this.closed(peerId, channel, reason),
    });
  }

  private frame(payload: Uint8Array, from: string, channel: LinkChannel): void {
    const peer = this.peersById.get(from);
    if (!peer || peer.channel !== channel) return;
    peer.heardAt = this.now();
    const frame = decodeLinkFrame(payload);
    if (!frame) return;
    if (frame.t === "LINK_OK") {
      if (!peer.up) this.markUp(peer);
      return;
    }
    if (frame.t.startsWith("LINK_") || !peer.up) return;
    const handler = this.handlers.get(frame.t);
    if (!handler) {
      log.debug(`Node link: nothing handles "${frame.t}"`);
      return;
    }
    try {
      handler(frame.d, from);
    } catch (error) {
      log.error(`Node link: "${frame.t}" from ${from} failed: ${error}`);
    }
  }

  private datagram(data: Uint8Array, from: string, channel: LinkChannel): void {
    const peer = this.peersById.get(from);
    if (!peer?.up || peer.channel !== channel) return;
    peer.heardAt = this.now();
    for (const handler of this.datagramHandlers) {
      try {
        handler(data, from);
      } catch (error) {
        log.error(`Node link: datagram from ${from} failed: ${error}`);
      }
    }
  }

  private closed(from: string, channel: LinkChannel, reason: string): void {
    // A channel we dropped ourselves was taken off its peer first, so its own `closed` stops here.
    const peer = this.peersById.get(from);
    if (!peer || peer.channel !== channel) return;
    this.drop(peer, `closed: ${reason}`, true);
  }

  private markUp(peer: Peer): void {
    peer.up = true;
    peer.upAt = this.now();
    peer.heardAt = peer.upAt;
    peer.failures = 0;
    log.info(`Node link to ${peer.id} is up`);
    for (const handler of this.upHandlers) {
      try { handler(peer.id); } catch (error) { log.error(`Node link up handler failed: ${error}`); }
    }
  }

  private drop(peer: Peer, reason: string, tell: boolean): void {
    const channel = peer.channel;
    const wasUp = peer.up;
    peer.channel = null;
    peer.up = false;
    channel?.close(reason);
    if (!tell) return;
    this.backOff(peer);
    if (!wasUp) {
      // A dial that reached the peer but never came up: refused, or no LINK_OK in time.
      if (channel && this.self < peer.id) this.failed(peer, reason);
      return;
    }
    log.warn(`Node link to ${peer.id} is down (${reason})`);
    for (const handler of this.downHandlers) {
      try { handler(peer.id); } catch (error) { log.error(`Node link down handler failed: ${error}`); }
    }
  }

  /** The first failure in a row is a warning; the rest of a run of retries would only flood the log. */
  private failed(peer: Peer, reason: string): void {
    peer.failures++;
    if (peer.failures === 1) log.warn(`Node link to ${peer.id} not made: ${reason} (retrying; repeats log at debug)`);
    else log.debug(`Node link to ${peer.id} not made (try ${peer.failures}): ${reason}`);
  }

  private backOff(peer: Peer): void {
    const delay = Math.round(peer.backoff * (1 - REDIAL_JITTER + Math.random() * REDIAL_JITTER * 2));
    peer.redialAt = this.now() + delay;
    peer.backoff = Math.min(peer.backoff * 2, REDIAL_MAX_MS);
    if (this.stopped || !peer.wanted || this.self > peer.id) return;
    // A timer of its own, so the redial is on time rather than at the next ping tick. The tick still dials as a fallback.
    if (peer.redialTimer) this.cancel(peer.redialTimer);
    peer.redialTimer = this.after(delay, () => {
      peer.redialTimer = null;
      if (this.peersById.get(peer.id) !== peer || !peer.wanted || peer.up || peer.dialing || peer.channel) return;
      void this.dial(peer);
    }, false);
  }

  private after(ms: number, run: () => void, grace = true): Timer {
    const due = this.now() + ms;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.stopped) return;
      if (grace && this.now() - due > this.pingMs) {
        this.after(this.pingMs, run, false);
        return;
      }
      run();
    }, ms);
    (timer as any).unref?.();
    this.timers.add(timer);
    return timer;
  }

  private cancel(timer: Timer): void {
    clearTimeout(timer);
    this.timers.delete(timer);
  }

  /** `promise`, or a rejection after `ms`: a hung store call must not hold a dial open forever. */
  private async within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: Timer | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} within ${ms} ms`)), ms);
      (timer as any).unref?.();
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
