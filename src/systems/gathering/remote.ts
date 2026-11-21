import { linkCalls, neverRan } from "../../cluster/linkcalls";
import { grants, handOverOf } from "../../cluster/grants";
import { bareMap } from "../../cluster/mirrors";
import log from "../../modules/logger";
import { REASONS, type GatherService, type Gatherer, type ServiceDeps } from "./service";
import type { GatherNode } from "./types";

/** A gatherer of a neighbouring node: as their node sees them, with whether their bags have room for the node's item. */
export interface RemoteGatherer extends Gatherer {
  hasRoom: boolean;
}

export interface GatherRequest {
  phase: "start" | "finish";
  nodeId: number;
  gatherer: RemoteGatherer;
}

export interface GatherAnswer {
  ok: boolean;
  reason?: string;
  node?: GatherNode;
  item?: string;
  quantity?: number;
  /** A finish's hand-over, parked on the owner (cluster/grants.ts). */
  grantId?: string;
}

const lower = (s: unknown) => String(s ?? "").toLowerCase();

/** Owner side: the remote gatherers whose request is being served now, by id. */
export class RemoteGatherers {
  private byId = new Map<string, { gatherer: RemoteGatherer; runs: number }>();

  get(id: string): RemoteGatherer | null {
    return this.byId.get(String(id))?.gatherer ?? null;
  }

  private byName(username: string): RemoteGatherer | null {
    for (const entry of this.byId.values()) if (lower(entry.gatherer.username) === lower(username)) return entry.gatherer;
    return null;
  }

  /** Whether `username` is a gatherer of a neighbouring node being served now. */
  isRemote(username: string): boolean {
    return this.byName(username) !== null;
  }

  /** Their node's answer to hasRoomFor, or null when `username` is not a remote gatherer. */
  roomOf(username: string): boolean | null {
    return this.byName(username)?.hasRoom ?? null;
  }

  /** Runs `work` with `gatherer` known; the newest snapshot of a gatherer wins, and it is dropped after its last run. */
  async run<T>(gatherer: RemoteGatherer, work: () => Promise<T>): Promise<T> {
    const key = String(gatherer.id);
    const entry = this.byId.get(key);
    if (entry) {
      entry.gatherer = gatherer;
      entry.runs++;
    } else {
      this.byId.set(key, { gatherer, runs: 1 });
    }
    try {
      return await work();
    } finally {
      const now = this.byId.get(key);
      if (now && --now.runs === 0) this.byId.delete(key);
    }
  }
}

type OwnDeps = Pick<ServiceDeps, "gatherer" | "hasRoomFor" | "give">;

export function withRemoteGatherers(base: OwnDeps, gatherers: RemoteGatherers): OwnDeps {
  return {
    gatherer: (id) => gatherers.get(id) ?? base.gatherer(id),
    hasRoomFor: async (username, item) => gatherers.roomOf(username) ?? (await base.hasRoomFor(username, item)),
    give: async (username, item, quantity) => (gatherers.isRemote(username) ? true : base.give(username, item, quantity)),
  };
}

export const GATHER_MIRROR_TOLERANCE_PX = 96;

export interface GatherMirror {
  username?: string;
  isDead?: boolean;
  isGhost?: boolean;
  location?: { map?: string; position?: { x?: number; y?: number } };
}

export interface AnswerDeps {
  service: Pick<GatherService, "start" | "finish">;
  gatherers: RemoteGatherers;
  /** The node a mirrored player came from (mirrors.ts mirrorOwner). */
  ownerOf(id: string): string | null;
  /** The mirror with this id (mirrors.ts mirrorPlayers): its name, its state, and where its node last said it stood. */
  mirrorOf(id: string): GatherMirror | null | undefined;
}

/** The snapshot as the rules read it: every field of a gatherer, typed. Null when it cannot be one (no position). */
function snapshotOf(sent: RemoteGatherer): RemoteGatherer | null {
  const x = Number(sent.x);
  const y = Number(sent.y);
  // A position that is not a number would pass the range check (NaN is never farther than the range).
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    id: String(sent.id), username: String(sent.username ?? ""), map: String(sent.map ?? ""),
    layerId: sent.layerId == null ? null : String(sent.layerId), x, y,
    dead: !!sent.dead, stunned: !!sent.stunned, casting: !!sent.casting, moving: !!sent.moving, inCombat: !!sent.inCombat,
    hasRoom: !!sent.hasRoom,
  };
}

/** Whether the snapshot stands somewhere its mirror does not: another map, or farther than the tolerance. */
function strayed(mirror: GatherMirror | null | undefined, gatherer: RemoteGatherer): boolean {
  const position = mirror?.location?.position;
  if (position?.x == null || position?.y == null) return true;
  const x = Number(position.x);
  const y = Number(position.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
  if (bareMap(mirror?.location?.map) !== bareMap(gatherer.map)) return true;
  const dx = x - gatherer.x;
  const dy = y - gatherer.y;
  return dx * dx + dy * dy > GATHER_MIRROR_TOLERANCE_PX * GATHER_MIRROR_TOLERANCE_PX;
}

export async function answerGather(request: GatherRequest, from: string, deps: AnswerDeps): Promise<GatherAnswer> {
  const sent = request?.gatherer;
  if (!sent || deps.ownerOf(String(sent.id)) !== from) return { ok: false, reason: REASONS.gone };
  const mirror = deps.mirrorOf(String(sent.id));
  if (lower(mirror?.username) !== lower(sent.username)) return { ok: false, reason: REASONS.gone };
  const gatherer = snapshotOf(sent);
  if (!gatherer) return { ok: false, reason: REASONS.gone };
  const nodeId = Number(request.nodeId);
  if (request.phase !== "start" && request.phase !== "finish") {
    log.warn(`GATHER_REQUEST from ${from} for ${gatherer.username} has no phase: refused`);
    return { ok: false, reason: REASONS.failed };
  }
  // A finish refused for its place is the node lost to the gatherer, as the service answers a local one.
  const finishing = request.phase === "finish";
  if (strayed(mirror, gatherer)) return { ok: false, reason: finishing ? REASONS.lost : REASONS.gone };
  gatherer.dead = gatherer.dead || !!(mirror?.isDead || mirror?.isGhost);
  return deps.gatherers.run(gatherer, async () => {
    if (request.phase === "start") {
      const started = await deps.service.start(gatherer.id, nodeId);
      return started.ok ? { ok: true, node: started.node } : { ok: false, reason: started.reason };
    }
    const outcome = await deps.service.finish(gatherer.id, nodeId);
    if (!outcome.ok) return { ok: false, reason: outcome.reason };
    log.info(`GATHER_REQUEST from ${from}: ${gatherer.username} (${gatherer.id}) was handed ${outcome.quantity} x ${outcome.item} from node ${nodeId}`);
    // Parked before the answer goes out (cluster/grants.ts), as serveItems does. Without a store it is null.
    const grantId = await grants.park({
      username: gatherer.username,
      items: [{ itemName: String(outcome.item), quantity: Math.max(1, Math.floor(Number(outcome.quantity) || 1)) }],
      copper: 0,
      call: "GATHER_REQUEST",
    });
    const handed: GatherAnswer = { ok: true, node: outcome.node, item: outcome.item, quantity: outcome.quantity };
    return grantId ? { ...handed, grantId } : handed;
  });
}

export async function requestGather(owner: string, request: GatherRequest, item?: string): Promise<GatherAnswer> {
  const outcome = await linkCalls.call<GatherAnswer>(owner, "GATHER_REQUEST", request);
  if (outcome.ok && outcome.answer) {
    const grantId = request.phase === "finish" && outcome.answer.ok ? outcome.answer.grantId : undefined;
    // As askOwner: a parked item is written here only once this node has taken it.
    if (typeof grantId === "string" && !(await grants.claim(grantId, handOverOf(outcome.answer as unknown as Record<string, unknown>)))) {
      log.warn(`GATHER_REQUEST finish of node ${request.nodeId} (${item ?? "?"}) on ${owner} for ${request.gatherer?.username}: hand-over ${grantId} was not claimed here, so it is not written here (${owner}'s recovery has it, unless the line above says it may be lost)`);
      return { ok: false, reason: REASONS.failed };
    }
    return outcome.answer;
  }
  if (request.phase === "finish") {
    const what = `GATHER_REQUEST finish of node ${request.nodeId} (${item ?? "?"}) on ${owner} for ${request.gatherer?.username}`;
    const after = grants.attached() ? `if ${owner} took anything for them, its recovery gives it` : "what the owner took for them may be lost";
    if (outcome.ok || !neverRan(outcome)) log.warn(`${what} ended ${outcome.ok ? "empty" : outcome.why}: ${after}`);
    else if (outcome.why !== "down") log.warn(`${what} ended ${outcome.why}: it did not run, so nothing was taken`);
  }
  return { ok: false, reason: REASONS.failed };
}

/** What the gathered node can give, as this node knows it (not as the owner answers): its item, and the most its area yields. */
export interface ExpectedYield {
  item: string;
  /** The area's quantity_max: the most one gather gives. */
  maxQuantity: number;
}

export interface ReceiveDeps {
  /** The node's item and largest yield, read here: what the owner answers is checked against it (security review L7). */
  expected: ExpectedYield;
  /** Whether the player's session is still the one this node holds (a player who left, or logged in elsewhere, is not). */
  stillHere(): boolean;
  give(username: string, item: string, quantity: number, grantId?: string): Promise<boolean>;
}

export type Received = { ok: true; item: string; quantity: number } | { ok: false; reason: string };

export async function receiveGathered(username: string, owner: string, nodeId: number, answer: GatherAnswer, deps: ReceiveDeps): Promise<Received> {
  const answered = String(answer.item ?? "");
  if (!answered) {
    log.error(`Node ${nodeId} of ${owner} was gathered for ${username}, but the answer names no item: it is lost`);
    return { ok: false, reason: REASONS.failed };
  }
  const item = String(deps.expected?.item ?? "");
  if (!item || lower(answered) !== lower(item)) {
    log.warn(`Node ${nodeId} of ${owner} was gathered for ${username}, but the answer names ${JSON.stringify(answered.slice(0, 64))} and the node gives ${JSON.stringify(item.slice(0, 64))}: nothing is granted`);
    return { ok: false, reason: REASONS.failed };
  }
  const most = Math.max(1, Math.floor(Number(deps.expected.maxQuantity) || 1));
  let quantity = Math.max(1, Math.floor(Number(answer.quantity) || 1));
  if (quantity > most) {
    log.warn(`Node ${nodeId} of ${owner} was gathered for ${username}, but the answer gives ${quantity} x ${item} and the node yields at most ${most}: cut to ${most}`);
    quantity = most;
  }
  const grantId = typeof answer.grantId === "string" ? answer.grantId : undefined;
  const lost = `${quantity} x ${item} from node ${nodeId} of ${owner} was lost for ${username}`;
  // The session may have ended during the round trip: another node can hold this player's rows by now.
  if (!deps.stillHere()) {
    await parkAgain(username, item, quantity, `${lost}, who left meanwhile`, grantId);
    return { ok: false, reason: REASONS.failed };
  }
  try {
    if (await deps.give(username, item, quantity, grantId)) return { ok: true, item, quantity };
  } catch (error) {
    log.error(`${lost}: ${error}`);
    return { ok: false, reason: REASONS.failed };
  }
  await parkAgain(username, item, quantity, lost, grantId);
  return { ok: false, reason: REASONS.failed };
}

async function parkAgain(username: string, item: string, quantity: number, lost: string, grantId?: string): Promise<void> {
  let id: string | null = null;
  try {
    id = await grants.park({ username, items: [{ itemName: item, quantity }], copper: 0, call: "GATHER_REQUEST" }, grantId);
  } catch (error) {
    log.error(`${lost} (it could not be parked again: ${error})`);
    return;
  }
  if (!id) {
    log.error(lost);
    return;
  }
  log.warn(`${quantity} x ${item} gathered for ${username} could not be written here: it is parked again as hand-over ${id}`);
}
