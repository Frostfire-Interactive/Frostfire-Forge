import type { LinkSender } from "./linktransport";

export type CallFailure = "down" | "timeout" | "failed" | "busy" | "too-big";
/** `unsent`: the frame never left this node (no link up, or the send was refused at once). */
export type CallOutcome<T> = { ok: true; answer: T } | { ok: false; why: CallFailure; unsent?: boolean };

export const MAX_INFLIGHT_PER_PEER = 256;
/** The largest call body sent, as JSON. A larger one is refused before it is sent (the frame limit is 4 MiB). */
export const MAX_CALL_BODY_BYTES = 1024 * 1024;

export function neverRan(outcome: CallOutcome<unknown>): boolean {
  if (outcome.ok) return false;
  return outcome.why === "busy" || outcome.why === "too-big" || outcome.unsent === true;
}

export type Admission =
  | { state: "new" } | { state: "pending" } | { state: "stale" }
  | { state: "done"; answer: unknown; failed: boolean };
/** How many replaced epochs are remembered per peer. */
const RETIRED_EPOCHS = 8;
/** The call that carries a call on to the node that owns its entity now (spec §5). */
export const FORWARD_CALL = "FORWARD";
/** How many senders' epochs the forward windows remember; the least recently used one is dropped. */
const FORWARD_WINDOWS = 64;
/** How many forwards one call may take: a player who changed node twice in a short time is still reached. */
export const MAX_FORWARD_HOPS = 3;

/** `hops`: forwards so far, this one included (1 for the first). A body without it counts as the first. */
export type ForwardBody = { from: string; epoch: string; seq: number; name: string; body: unknown; hops: number };
export type ForwardAnswer = { answer?: unknown; failed?: boolean };
/** Where a call this node received should run: a peer id, or null (or this node, or the sender) to run it here. */
export type CallRedirect = (name: string, body: any, from: string) => string | null;

export type CallHandler = (body: any, from: string) => unknown | Promise<unknown>;
export type CastHandler = (body: any, from: string) => void;

/** `try`: which copy of the call this is, 2 and up for a resend; absent on the first. */
type CallFrame = { seq: number; epoch: string; name: string; body: unknown; try?: number };
/** `try` on a busy answer: the copy it refuses, as the call frame named it. */
type AnswerFrame = { seq: number; epoch: string; answer?: unknown; failed?: true; busy?: true; try?: number };
type CastFrame = { epoch: string; name: string; body: unknown };
type Pending = { peer: string; frame: CallFrame; resolve: (outcome: CallOutcome<unknown>) => void; timer: ReturnType<typeof setTimeout> };

export class SeqWindow {
  private readonly entries = new Map<number, { done: boolean; answer?: unknown; failed?: boolean }>();
  private highest = 0;

  constructor(private readonly size = 4096) {}

  admit(seq: number): Admission {
    if (!Number.isInteger(seq) || seq <= 0) return { state: "stale" };
    const known = this.entries.get(seq);
    if (known) return known.done ? { state: "done", answer: known.answer, failed: !!known.failed } : { state: "pending" };
    if (this.stale(seq)) return { state: "stale" };
    this.entries.set(seq, { done: false });
    if (seq > this.highest) this.highest = seq;
    if (this.entries.size > this.size * 2) this.prune();
    return { state: "new" };
  }

  /** Whether `seq` is in the window (running or done). */
  has(seq: number): boolean {
    return this.entries.has(seq);
  }

  stale(seq: number): boolean {
    return !Number.isInteger(seq) || seq <= 0 || seq <= this.highest - this.size;
  }

  settle(seq: number, answer: unknown, failed = false): void {
    const entry = this.entries.get(seq);
    if (!entry) return;
    entry.done = true;
    entry.answer = answer;
    entry.failed = failed;
  }

  /** Drops the numbers that fell out of the window; admit refuses them from now on. */
  private prune(): void {
    const floor = this.highest - this.size;
    for (const seq of this.entries.keys()) if (seq <= floor) this.entries.delete(seq);
  }
}

export class LinkCalls {
  private links: LinkSender | null = null;
  private session: object | null = null;
  private epoch = "";
  private seq = 0;
  private readonly handlers = new Map<string, CallHandler>();
  private readonly casts = new Map<string, CastHandler>();
  private readonly pending = new Map<number, Pending>();
  private readonly windows = new Map<string, { epoch: string; window: SeqWindow; retired: string[] }>();

  private readonly fwdWindows = new Map<string, SeqWindow>();
  private redirect: CallRedirect | null = null;
  private readonly upHooks = new Set<(peer: string) => void>();
  private readonly downHooks = new Set<(peer: string) => void>();
  /** Calls running now, per peer: what the busy cap counts. */
  private readonly running = new Map<string, number>();

  constructor(private readonly timeoutMs = 10_000) {
    this.handlers.set(FORWARD_CALL, (body, from) => this.forwarded(body, from));
  }

  /** Answer every call named `name`. Throws on a second handler; the returned function removes this one. */
  handle(name: string, fn: CallHandler): () => void {
    if (this.handlers.has(name)) throw new Error(`Link call ${name} already has a handler`);
    this.handlers.set(name, fn);
    return () => { if (this.handlers.get(name) === fn) this.handlers.delete(name); };
  }

  /** Run on every cast named `name`. Throws on a second handler; the returned function removes this one. */
  onCast(name: string, fn: CastHandler): () => void {
    if (this.casts.has(name)) throw new Error(`Link cast ${name} already has a handler`);
    this.casts.set(name, fn);
    return () => { if (this.casts.get(name) === fn) this.casts.delete(name); };
  }

  /** Run after a link to a peer came up and the calls pending to it were sent again. */
  onPeerUp(fn: (peer: string) => void): () => void {
    this.upHooks.add(fn);
    return () => { this.upHooks.delete(fn); };
  }

  /** Run after a link to a peer went down and the calls pending to it failed. */
  onPeerDown(fn: (peer: string) => void): () => void {
    this.downHooks.add(fn);
    return () => { this.downHooks.delete(fn); };
  }

  setRedirect(fn: CallRedirect | null): void {
    this.redirect = fn;
  }

  attach(links: LinkSender): void {
    if (this.links === links) return;
    if (this.links) this.detach();
    // A token for this attach, not the links: a re-attach on the same links must not bring the old closures back.
    const session = {};
    const live = () => this.session === session;
    links.on("CALL", (data, from) => { if (live()) void this.serve(links, session, data as CallFrame, from).catch(() => {}); });
    links.on("ANSWER", (data, from) => { if (live()) this.answered(data as AnswerFrame, from); });
    links.on("CAST", (data, from) => { if (live()) this.received(data as CastFrame, from); });
    links.onPeerUp((peer) => {
      if (!live()) return;
      this.resend(links, peer);
      this.runHooks(this.upHooks, peer);
    });
    links.onPeerDown((peer) => {
      if (!live()) return;
      this.fail((call) => call.peer === peer, "down");
      this.runHooks(this.downHooks, peer);
    });
    this.epoch = crypto.randomUUID();
    this.seq = 0;
    this.links = links;
    this.session = session;
  }

  /** Stop: every pending call ends as down, and every peer's window is forgotten. */
  detach(): void {
    this.links = null;
    this.session = null;
    this.windows.clear();
    this.fwdWindows.clear();
    this.running.clear();
    this.fail(() => true, "down");
  }

  isUp(peer: string): boolean {
    return !!this.links?.isUp(peer);
  }

  /** Ask `peer` to run `name`. Ends `down` at once when no link to it is up. */
  call<T = unknown>(peer: string, name: string, body: unknown, opts: { timeoutMs?: number } = {}): Promise<CallOutcome<T>> {
    const links = this.links;
    if (!links || !links.isUp(peer)) return Promise.resolve({ ok: false, why: "down", unsent: true });
    // JSON.stringify answers undefined for a function or a symbol; that body is sent as null.
    if (Buffer.byteLength(JSON.stringify(body ?? null) ?? "null") > MAX_CALL_BODY_BYTES) {
      return Promise.resolve({ ok: false, why: "too-big", unsent: true });
    }
    const frame: CallFrame = { seq: ++this.seq, epoch: this.epoch, name, body };
    return new Promise<CallOutcome<T>>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.get(frame.seq)?.timer !== timer) return;
        this.pending.delete(frame.seq);
        resolve({ ok: false, why: "timeout" });
      }, opts.timeoutMs ?? this.timeoutMs);
      this.pending.set(frame.seq, { peer, frame, resolve: resolve as (outcome: CallOutcome<unknown>) => void, timer });
      if (!links.send(peer, "CALL", frame)) this.fail((call) => call.frame.seq === frame.seq, "down", true);
    });
  }

  /** Send `name` to `peer` with no answer and no dedup. False when no link to it is up. */
  cast(peer: string, name: string, body: unknown): boolean {
    const links = this.links;
    if (!links) return false;
    const frame: CastFrame = { epoch: this.epoch, name, body };
    return links.send(peer, "CAST", frame);
  }

  private async serve(links: LinkSender, session: object, frame: CallFrame, from: string): Promise<void> {
    if (!frame || typeof frame.name !== "string" || typeof frame.epoch !== "string") return;
    let slot = this.windows.get(from);
    if (slot?.retired.includes(frame.epoch)) return;
    if (!slot || slot.epoch !== frame.epoch) {
      const retired = slot ? [...slot.retired, slot.epoch].slice(-RETIRED_EPOCHS) : [];
      slot = { epoch: frame.epoch, window: new SeqWindow(), retired };
      this.windows.set(from, slot);
    }
    const window = slot.window;
    const reply = (answer: unknown, failed: boolean) => {
      if (this.session !== session) return;
      const out: AnswerFrame = failed ? { seq: frame.seq, epoch: frame.epoch, failed: true } : { seq: frame.seq, epoch: frame.epoch, answer };
      links.send(from, "ANSWER", out);
    };
    if (!window.has(frame.seq) && !window.stale(frame.seq) && (this.running.get(from) ?? 0) >= MAX_INFLIGHT_PER_PEER) {
      if (this.session === session) {
        const busy: AnswerFrame = { seq: frame.seq, epoch: frame.epoch, busy: true };
        if (Number.isInteger(frame.try)) busy.try = frame.try;
        links.send(from, "ANSWER", busy);
      }
      return;
    }
    const admitted = window.admit(frame.seq);
    if (admitted.state === "pending") return;
    if (admitted.state === "stale") return reply(null, true);
    if (admitted.state === "done") return reply(admitted.answer, admitted.failed);
    this.running.set(from, (this.running.get(from) ?? 0) + 1);
    let answer: unknown = null;
    let failed = false;
    try {
      // A FORWARD is not redirected here: forwarded() passes it on itself.
      const to = frame.name === FORWARD_CALL || !this.redirect ? null : this.redirect(frame.name, frame.body, from);
      if (to && to !== from && to !== links.self) {
        const body: ForwardBody = { from, epoch: frame.epoch, seq: frame.seq, name: frame.name, body: frame.body, hops: 1 };
        const outcome = await this.call<ForwardAnswer>(to, FORWARD_CALL, body);
        // Not run here when the forward failed: the new owner may have run it, and an action runs at most once.
        if (!outcome.ok || outcome.answer?.failed) failed = true;
        else answer = outcome.answer?.answer ?? null;
      } else {
        answer = await this.run(frame.name, frame.body, from);
      }
    } catch {
      failed = true;
    } finally {
      // After a detach the counts were cleared: a call of the old attach must not lower the new one's.
      if (this.session === session) {
        const left = (this.running.get(from) ?? 1) - 1;
        if (left > 0) this.running.set(from, left);
        else this.running.delete(from);
      }
    }
    window.settle(frame.seq, answer, failed);
    reply(answer, failed);
  }

  private async run(name: string, body: unknown, from: string): Promise<unknown> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`No handler for link call ${name}`);
    return (await handler(body, from)) ?? null;
  }

  private async forwarded(raw: any, sender: string): Promise<ForwardAnswer> {
    const from = typeof raw?.from === "string" ? raw.from : "";
    const epoch = typeof raw?.epoch === "string" ? raw.epoch : "";
    const name = typeof raw?.name === "string" ? raw.name : "";
    const seq = Number(raw?.seq);
    const hops = Number.isInteger(raw?.hops) && raw.hops > 0 ? raw.hops : 1;
    if (!from || !epoch || !name || name === FORWARD_CALL) return { failed: true };
    if (from === this.links?.self || from === sender) return { failed: true };
    const key = JSON.stringify([from, epoch]);
    let window = this.fwdWindows.get(key);
    if (window) this.fwdWindows.delete(key);
    else window = new SeqWindow();
    this.fwdWindows.set(key, window);
    if (this.fwdWindows.size > FORWARD_WINDOWS) this.fwdWindows.delete(this.fwdWindows.keys().next().value as string);
    const admitted = window.admit(seq);
    if (admitted.state === "done") return admitted.failed ? { failed: true } : { answer: admitted.answer };
    // Still running, or too old to tell: not run a second time.
    if (admitted.state !== "new") return { failed: true };
    let answer: unknown = null;
    let failed = false;
    try {
      const to = this.redirect ? this.redirect(name, raw.body, from) : null;
      // Back to the original caller is never a hop: it would refuse a forward naming itself. Run here instead.
      if (to && to !== from && to !== this.links?.self) {
        if (to === sender) {
          failed = true;
        } else if (hops >= MAX_FORWARD_HOPS) {
          // Not run here either: the entity is not here, and an action runs at most once.
          failed = true;
        } else {
          const body: ForwardBody = { from, epoch, seq, name, body: raw.body, hops: hops + 1 };
          const outcome = await this.call<ForwardAnswer>(to, FORWARD_CALL, body);
          // Any failure of the onward forward settles failed: the next node may have run it.
          if (!outcome.ok || outcome.answer?.failed) failed = true;
          else answer = outcome.answer?.answer ?? null;
        }
      } else {
        answer = await this.run(name, raw.body, from);
      }
    } catch {
      failed = true;
    }
    window.settle(seq, answer, failed);
    return failed ? { failed: true } : { answer };
  }

  private runHooks(hooks: Set<(peer: string) => void>, peer: string): void {
    for (const hook of [...hooks]) {
      try {
        hook(peer);
      } catch {
        // One hook's failure does not keep the others from running.
      }
    }
  }

  private answered(frame: AnswerFrame, from: string): void {
    if (!frame || frame.epoch !== this.epoch) return;
    const call = this.pending.get(frame.seq);
    if (!call || call.peer !== from) return;
    // A busy answer to an older copy says nothing of the copy resent after it, which may run: the call waits on.
    if (frame.busy && (frame.try ?? 1) !== (call.frame.try ?? 1)) return;
    this.pending.delete(frame.seq);
    clearTimeout(call.timer);
    call.resolve(frame.busy ? { ok: false, why: "busy" } : frame.failed ? { ok: false, why: "failed" } : { ok: true, answer: frame.answer });
  }

  private received(frame: CastFrame, from: string): void {
    if (!frame || typeof frame.name !== "string") return;
    try {
      this.casts.get(frame.name)?.(frame.body, from);
    } catch {
      // A cast has no answer: a handler that throws only loses its own message.
    }
  }

  private resend(links: LinkSender, peer: string): void {
    for (const call of this.pending.values()) {
      if (call.peer !== peer) continue;
      // A new copy number, so a busy answer to the copy before it is not taken for this one.
      call.frame = { ...call.frame, try: (call.frame.try ?? 1) + 1 };
      links.send(peer, "CALL", call.frame);
    }
  }

  private fail(which: (call: Pending) => boolean, why: CallFailure, unsent = false): void {
    for (const [seq, call] of [...this.pending]) {
      if (!which(call)) continue;
      this.pending.delete(seq);
      clearTimeout(call.timer);
      call.resolve(unsent ? { ok: false, why, unsent: true } : { ok: false, why });
    }
  }
}

/** This node's link calls: attached by startCluster when the node has links, never otherwise. */
export const linkCalls = new LinkCalls();
