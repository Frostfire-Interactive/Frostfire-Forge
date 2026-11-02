import log from "../modules/logger";
import type { ClusterBus } from "./bus";
import type { LoadReport, NodeRegistry } from "./nodes";

// Who is on the other nodes of this region. Two things answer that, at two costs:
//
// - The load reports, which every node already writes each second: how many players, how busy. Read on a short timer,
//   so the online count every player sees costs a few store reads and no message.
// - A node's own answer over the bus, for what a report does not hold (the names, a control panel's numbers). Asked
//   only while someone wants it, at most once per ROSTER_FRESH_MS however many panels are open. The rows travel as
//   one JSON string: the bus signs what it sends key by key, which is cheap for one string and not for a list.

/** How often the load reports are read. */
export const CENSUS_MS = 2_000;
/** How long a node gets to answer. One that does not is left to its load report. */
export const ROSTER_WAIT_MS = 500;
/** How long the answers are kept, so several panels share them. */
export const ROSTER_FRESH_MS = 1_000;
/** How long a new count must hold before players see it: longer than a load report and a census read together. */
export const ONLINE_SETTLE_MS = 4_000;

/**
 * The online count players are shown. A player crossing a border leaves one node's connections at once, and the other
 * nodes' reports only seconds later, so for that long the sum is one off though nobody came or went. A change goes out
 * once it has held, which those never do. Asked on a timer with the count now; answers with the count to send, or null.
 */
export class SettledCount {
  private sent = 0;
  private matched = 0;

  constructor(private readonly settleMs = ONLINE_SETTLE_MS) {}

  next(count: number, now: number): number | null {
    if (count === this.sent) {
      this.matched = now;
      return null;
    }
    if (now - this.matched < this.settleMs) return null;
    this.sent = count;
    this.matched = now;
    return count;
  }
}

/** What a node says when asked. */
export interface NodeAnswer {
  rows: unknown[];
  status: unknown;
}

/** What this module needs from the control panel, which it does not load. */
export interface PanelSource {
  /** This node's players and numbers. */
  answer(): NodeAnswer;
  /** Something an admin did through a panel on another node. */
  activity(entry: unknown): void;
}

/** One peer of this region. `answer` is null for a node that did not answer in time. */
export interface PeerRoster {
  nodeId: string;
  report: LoadReport | null;
  answer: NodeAnswer | null;
}

export class Census {
  private peers: LoadReport[] = [];
  private fresh: { at: number; roster: PeerRoster[] } | null = null;
  private asking: Promise<PeerRoster[]> | null = null;
  private asked = 0;
  private waiting = new Map<number, { answers: Map<string, NodeAnswer>; expected: Set<string>; done: () => void }>();
  private failing = false;

  constructor(
    private readonly registry: NodeRegistry,
    private readonly bus: ClusterBus,
    private readonly self: string,
    private readonly region: string,
    private readonly panel: () => PanelSource | null,
    private readonly waitMs = ROSTER_WAIT_MS,
    private readonly freshMs = ROSTER_FRESH_MS,
  ) {
    bus.on("roster-ask", ({ ask }, from) => this.answerAsk(ask, from));
    bus.on("roster-reply", ({ ask, body }, from) => this.hear(ask, body, from));
    bus.on("panel-activity", (entry, from) => { if (from !== this.self) this.panel()?.activity(entry); });
  }

  /** Tells the other nodes' panels what an admin did here. */
  shareActivity(entry: unknown): void {
    this.bus.toWorld("panel-activity", entry).catch((error) => log.debug(`An admin's action could not be shared with the other nodes: ${error}`));
  }

  /** Reads the load reports. A read that fails keeps the last ones: a count a moment old beats none. */
  async read(): Promise<void> {
    try {
      this.peers = (await this.registry.loads(this.region)).filter((report) => report.nodeId !== this.self);
      this.failing = false;
    } catch (error) {
      if (!this.failing) log.warn(`The other nodes' load reports could not be read: ${error}`);
      this.failing = true;
    }
  }

  /** The players on this region's other nodes, as of the last read. */
  othersOnline(): number {
    let players = 0;
    for (const report of this.peers) players += report.players;
    return players;
  }

  /** The other nodes' load reports, as of the last read. */
  reports(): readonly LoadReport[] {
    return this.peers;
  }

  /** Every peer with what it said. Resolves within the wait, and never rejects. */
  roster(): Promise<PeerRoster[]> {
    if (this.fresh && Date.now() - this.fresh.at < this.freshMs) return Promise.resolve(this.fresh.roster);
    this.asking ??= this.ask().finally(() => { this.asking = null; });
    return this.asking;
  }

  private async ask(): Promise<PeerRoster[]> {
    const peers = this.peers;
    const expected = new Set(peers.map((report) => report.nodeId));
    const answers = new Map<string, NodeAnswer>();
    if (expected.size > 0) {
      const ask = ++this.asked;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.waitMs);
        this.waiting.set(ask, { answers, expected, done: () => { clearTimeout(timer); resolve(); } });
        for (const nodeId of expected) {
          this.bus.toNode(nodeId, "roster-ask", { ask }).catch((error) => log.debug(`Node ${nodeId} could not be asked for its roster: ${error}`));
        }
      });
      this.waiting.delete(ask);
    }
    const roster = peers.map((report) => ({ nodeId: report.nodeId, report, answer: answers.get(report.nodeId) ?? null }));
    this.fresh = { at: Date.now(), roster };
    return roster;
  }

  private async answerAsk(ask: unknown, from: string): Promise<void> {
    const panel = this.panel();
    if (!panel) return;
    await this.bus.toNode(from, "roster-reply", { ask, body: JSON.stringify(panel.answer()) });
  }

  private hear(ask: number, body: unknown, from: string): void {
    const waiting = this.waiting.get(ask);
    if (!waiting || !waiting.expected.has(from) || typeof body !== "string") return;
    const answer = JSON.parse(body) as NodeAnswer;
    waiting.answers.set(from, { rows: Array.isArray(answer?.rows) ? answer.rows : [], status: answer?.status ?? null });
    if (waiting.answers.size >= waiting.expected.size) waiting.done();
  }
}
