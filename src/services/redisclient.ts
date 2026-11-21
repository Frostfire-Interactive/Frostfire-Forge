import { RedisClient, type RedisOptions } from "bun";
import log from "../modules/logger";

export const CONNECT_WAIT_MS = 5_000;
/** How often a lost connection is tried again with a fresh client (ms). */
export const REVIVE_MS = 3_000;
/** How long one revival attempt waits for its fresh client to connect before it is closed and dropped (ms). */
export const ATTEMPT_MS = 5_000;
/** How long a cache call waits for its answer before Redis is asked whether it answers at all (ms). */
export const CACHE_CALL_MS = 3_000;
/** How long that question waits for its own answer (ms). */
export const CACHE_PROBE_MS = 2_000;
export const CLIENT_OPTIONS: RedisOptions = {
  autoReconnect: true,
  maxRetries: 0xffff_ffff, // the most Bun accepts
  enableOfflineQueue: false,
  connectionTimeout: CONNECT_WAIT_MS,
};
export const SHARED_OPTIONS: RedisOptions = { ...CLIENT_OPTIONS, enableOfflineQueue: true };

/** `connecting`, or a rejection after `ms`: a connect that is refused neither resolves nor rejects. */
export async function within(connecting: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      connecting,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("the connection was not made in time")), ms);
        (timer as { unref?: () => unknown }).unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// A lost connection being replaced: the timer, and the fresh client while it connects.
interface Revival {
  timer: ReturnType<typeof setInterval>;
  fresh: RedisClient | null;
  busy: boolean;
}

export interface RedisSlotOptions {
  /** How the connection is named in the log ("Redis", "Redis subscriber"). */
  name: string;
  /** A fresh client, not yet connected. */
  make: () => RedisClient;
  reviveMs: number;
  attemptMs: number;
  prepare?: (fresh: RedisClient, stale: () => boolean) => Promise<boolean>;
  /** A fresh client has taken the lost one's place. */
  adopted?: (fresh: RedisClient) => void;
  /** The client came back on its own. */
  reconnected?: (client: RedisClient) => void;
}

/** One connection that is replaced when it is lost: the client in use, and the timer that tries a fresh one. */
export class RedisSlot {
  client: RedisClient | null = null;
  // Clients closed on purpose: their onclose is not an outage.
  private closedByUs = new WeakSet<RedisClient>();
  // False while the client in use is lost.
  private connected = true;
  // Per lost client, the timer that tries a fresh one; and whether close() has been called.
  private revivals = new Map<RedisClient, Revival>();
  private stopped = false;

  constructor(private readonly options: RedisSlotOptions) {}

  /** Takes `client` as the one in use and watches it. `connected`: it has connected already (a first connection is not logged as a return). */
  use(client: RedisClient, connected: boolean): void {
    this.client = client;
    this.watch(client, connected);
  }

  /** False while the client in use is lost, and once closed here. */
  isUp(): boolean {
    return this.connected && this.client !== null && !this.closedByUs.has(this.client);
  }

  private watch(client: RedisClient, connected: boolean): void {
    let down = false;
    client.onclose = (error) => {
      // Closing is not an outage.
      if (this.closedByUs.has(client)) return;
      if (client === this.client) this.connected = false;
      this.revive(client);
      if (down) return;
      down = true;
      log.error(`${this.options.name} connection lost, reconnecting: ${error?.message ?? error}`);
    };
    client.onconnect = () => {
      // A client replaced or closed here may still say it connected.
      if (this.closedByUs.has(client)) return;
      this.stopRevival(client);
      if (client === this.client) this.connected = true;
      if (!connected) {
        connected = true; // the first connection
        return;
      }
      down = false;
      log.success(`${this.options.name} connection restored`);
      this.options.reconnected?.(client);
    };
  }

  /** Starts the timer that tries a fresh client for a lost one. One timer per lost client. */
  revive(client: RedisClient): void {
    if (client === this.client) this.connected = false;
    if (this.stopped || this.revivals.has(client)) return;
    const revival: Revival = { timer: setInterval(() => { void this.attempt(client, revival); }, this.options.reviveMs), fresh: null, busy: false };
    (revival.timer as { unref?: () => unknown }).unref?.();
    this.revivals.set(client, revival);
  }

  // Stops the timer of a client, and closes the fresh client that was connecting for it.
  private stopRevival(client: RedisClient): void {
    const revival = this.revivals.get(client);
    if (!revival) return;
    clearInterval(revival.timer);
    this.revivals.delete(client);
    if (revival.fresh) this.discard(revival.fresh);
    revival.fresh = null;
  }

  // Closes a client of ours that is not used: its onclose is no outage.
  private discard(client: RedisClient): void {
    if (this.closedByUs.has(client)) return;
    this.closedByUs.add(client);
    try { client.close(); } catch {}
  }

  // One try with a fresh client; only one is in flight at a time. A fresh client that connects replaces the lost one.
  private async attempt(lost: RedisClient, revival: Revival): Promise<void> {
    if (revival.busy || this.stopped) return;
    // The lost client is no longer the slot's (it was closed here, or replaced): nothing to revive.
    if (this.client !== lost || this.closedByUs.has(lost)) {
      this.stopRevival(lost);
      return;
    }
    // After every wait: has anything made this attempt pointless?
    const stale = () => this.revivals.get(lost) !== revival || this.client !== lost || this.closedByUs.has(lost);
    revival.busy = true;
    let fresh: RedisClient | null = null;
    try {
      fresh = this.options.make();
      revival.fresh = fresh;
      await within(fresh.connect(), this.options.attemptMs);
      if (stale()) return this.discard(fresh);
      if (this.options.prepare && !(await this.options.prepare(fresh, stale))) return this.discard(fresh);
      revival.fresh = null;
      this.stopRevival(lost);
      this.replace(lost, fresh);
    } catch {
      // Not connected in time, or refused: the attempt is dropped, and the next tick tries again.
      if (fresh) this.discard(fresh);
    } finally {
      if (revival.fresh === fresh) revival.fresh = null;
      revival.busy = false;
    }
  }

  // The fresh client takes the lost one's place. It is watched like the first, and the return is logged once.
  private replace(lost: RedisClient, fresh: RedisClient): void {
    this.closedByUs.add(lost);
    try { lost.close(); } catch {}
    this.use(fresh, true);
    this.connected = true;
    this.options.adopted?.(fresh);
    log.success(`${this.options.name} connection restored`);
  }

  /** Lets `client` go: no revival for it, and it is closed. When it is the one in use, the slot has none. */
  release(client: RedisClient): void {
    this.stopRevival(client);
    if (this.client === client) this.client = null;
    this.discard(client);
  }

  /** Stops every revival and closes the client in use. */
  close(): void {
    this.stopped = true;
    for (const client of [...this.revivals.keys()]) this.stopRevival(client);
    if (!this.client) return;
    this.closedByUs.add(this.client);
    this.client.close();
  }
}

export class SharedRedis {
  private readonly slot: RedisSlot;
  private started: Promise<void> | null = null;
  private asking: Promise<boolean> | null = null;

  constructor(
    url: string | undefined = process.env.REDIS_URL,
    private readonly first?: RedisClient,
    private readonly make: () => RedisClient = () => new RedisClient(url, SHARED_OPTIONS),
    private readonly attemptMs = ATTEMPT_MS,
    reviveMs = REVIVE_MS,
    private readonly callMs = CACHE_CALL_MS,
    private readonly probeMs = CACHE_PROBE_MS,
  ) {
    this.slot = new RedisSlot({ name: "Redis cache", make, reviveMs, attemptMs });
  }

  private start(): Promise<void> {
    this.started ??= (async () => {
      const client = this.first ?? this.make();
      this.slot.use(client, false);
      try {
        await within(client.connect(), this.attemptMs);
      } catch (error) {
        log.error(`Could not connect to Redis: ${error}`);
        this.slot.revive(client);
      }
    })();
    return this.started;
  }

  private async redis(): Promise<RedisClient> {
    await this.start();
    return this.slot.client!;
  }

  private async call<T>(run: (client: RedisClient) => Promise<T>): Promise<T> {
    const started = Date.now();
    const running = this.redis().then(run);
    const ended = running.then(() => true, () => true); // also: a rejection after the call gave up has no one waiting
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const overdue = await Promise.race([
        ended.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), this.callMs);
          (timer as { unref?: () => unknown }).unref?.();
        }),
      ]);
      clearTimeout(timer);
      if (!overdue) return running;
      if (await Promise.race([ended, this.answers()])) continue;
      this.stalled();
      throw new Error(`Redis did not answer within ${Date.now() - started} ms`);
    }
  }

  // One question at a time, shared by every call waiting. On a connection of its own: the one in use answers in order.
  private answers(): Promise<boolean> {
    this.asking ??= this.ask().finally(() => { this.asking = null; });
    return this.asking;
  }

  private async ask(): Promise<boolean> {
    let probe: RedisClient | null = null;
    try {
      probe = this.make();
      const connected = probe.connect();
      await within(connected.then(() => probe!.send("PING", [])), this.probeMs);
      return true;
    } catch {
      return false;
    } finally {
      try { probe?.close(); } catch {}
    }
  }

  private stalled(): void {
    const client = this.slot.client;
    if (!client || !this.slot.isUp()) return;
    log.error("Redis cache did not answer: the connection counts as lost");
    this.slot.revive(client);
  }

  get(key: string): Promise<string | null> {
    return this.call((client) => client.get(key));
  }

  set(key: string, value: string): Promise<unknown> {
    return this.call((client) => client.set(key, value));
  }

  send(command: string, args: string[]): Promise<any> {
    return this.call((client) => client.send(command, args));
  }

  /** False while the connection is lost. */
  isUp(): boolean {
    return this.slot.isUp();
  }

  close(): void {
    this.slot.close();
  }
}

let shared: SharedRedis | null = null;
/** The cache client of this process, made on first use. */
export function sharedRedis(): SharedRedis {
  shared ??= new SharedRedis();
  return shared;
}
