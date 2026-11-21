import { registerPlayerAction, runOnPlayer } from "../../cluster/deliver";
import { ghosts } from "../../cluster/ghosts";
import { linkCalls } from "../../cluster/linkcalls";
import { grants } from "../../cluster/grants";
import { mirrorByUsername, mirrorOwner } from "../../cluster/mirrors";
import log from "../../modules/logger";

export interface RewardBody {
  username: string;
  playerId: string;
  creatureId: number;
  templateId: number;
  templateName: string;
  xp: number;
}

export const STAT_INT_MAX = 2147483647;

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/** A name or id as it is written in a log line: peers send these, so only the start of one is kept. */
const shown = (value: unknown) => String(value).slice(0, 64);

export type RewardApplier = (body: RewardBody, from?: string) => Promise<boolean>;

let applier: RewardApplier | null = null;

export function setRewardApplier(fn: RewardApplier | null): RewardApplier | null {
  const previous = applier;
  applier = fn;
  return previous;
}

export async function sendRewards(bodies: RewardBody[]): Promise<string[]> {
  const missed: string[] = [];
  await Promise.all(bodies.map(async (body) => {
    const peer = mirrorOwner(body.playerId);
    if (!peer) {
      missed.push(body.username);
      return;
    }
    const outcome = await linkCalls.call<{ ok: boolean }>(peer, "APPLY_REWARD", body);
    if (!outcome.ok || !outcome.answer?.ok) missed.push(body.username);
  }));
  return missed;
}

export function checkedReward(body: unknown, from: string): RewardBody | null {
  const b = body as Partial<RewardBody> | null;
  if (!b || typeof b.username !== "string" || typeof b.playerId !== "string" || !isCount(b.creatureId) || !isCount(b.templateId) || !isCount(b.xp) || b.xp > STAT_INT_MAX) {
    log.warn(`Kill reward from ${shown(from)} refused: its fields are not a share (${shown(b?.username)}, xp ${shown(b?.xp)})`);
    return null;
  }
  // A creature this node mirrors belongs to the node that owns it: nobody else may pay out for its kill.
  const owner = ghosts.ownerOf("creature", b.creatureId);
  if (owner && owner !== from) {
    log.warn(`Kill reward from ${shown(from)} for creature ${b.creatureId} refused: the creature belongs to ${owner}`);
    return null;
  }
  return { username: b.username, playerId: b.playerId, creatureId: b.creatureId, templateId: b.templateId, templateName: String(b.templateName ?? ""), xp: b.xp };
}

linkCalls.handle("APPLY_REWARD", async (body: RewardBody, from: string) => {
  const share = checkedReward(body, from);
  if (!share) return { ok: false };
  log.info(`APPLY_REWARD from ${shown(from)}: ${shown(share.username)} (${shown(share.playerId)}), ${share.xp} XP for creature ${share.creatureId}`);
  return { ok: applier ? await applier(share, from) : false };
});

export interface GrantBody {
  username: string;
  copper: number;
  /** Not sent any more, and ignored when it arrives. */
  message?: string;
  /** The grant id (cluster/grants.ts): the receiver gives one id once. Set by sendGrant while the store is attached. */
  id?: string;
}

/** given: written there. sent: sent to their node, no answer. absent: they are not there. unknown: the link failed. */
export type GrantOutcome = "given" | "sent" | "absent" | "failed" | "unknown";

/** Gives a share to a player of this node. "absent" when they are not here, "failed" for an amount no corpse holds. */
export type GrantApplier = (body: GrantBody) => Promise<GrantOutcome>;

let grantApplier: GrantApplier | null = null;

export function setGrantApplier(fn: GrantApplier | null): GrantApplier | null {
  const previous = grantApplier;
  grantApplier = fn;
  return previous;
}

export async function sendGrant(share: GrantBody): Promise<GrantOutcome> {
  const body: GrantBody = grants.attached() && !share.id ? { ...share, id: grants.newId() } : share;
  const peer = mirrorByUsername(body.username)?.mirrorFrom;
  // A link that is down sends nothing, so the share is certainly unapplied: the directory may know another way.
  if (peer && linkCalls.isUp(peer)) {
    const outcome = await linkCalls.call<{ result: GrantOutcome }>(peer, "GRANT", body);
    if (!outcome.ok) {
      if (!body.id) return "unknown";
      // It may have been given there: sent again with the same id, it is given at most once.
      return (await runOnPlayer(body.username, "cells-grant", body)) ? "sent" : "unknown";
    }
    const result = outcome.answer?.result ?? "unknown";
    // The mirror was stale: they moved on. The directory knows where.
    if (result !== "absent") return result;
  }
  return (await runOnPlayer(body.username, "cells-grant", body)) ? "sent" : "absent";
}

/** The share a peer sent, as far as its shape goes, or null. Only the name, the amount and a grant id are kept. */
export function checkedGrant(body: unknown): GrantBody | null {
  const b = body as Partial<GrantBody> | null;
  if (!b || typeof b.username !== "string" || !isCount(b.copper) || b.copper > STAT_INT_MAX) return null;
  const id = typeof b.id === "string" && b.id.length > 0 && b.id.length <= 128 ? b.id : null;
  return id ? { username: b.username, copper: b.copper, id } : { username: b.username, copper: b.copper };
}

linkCalls.handle("GRANT", async (body: GrantBody, from: string) => {
  const share = checkedGrant(body);
  if (!share) {
    log.warn(`Corpse money from ${shown(from)} refused: its fields are not a share (${shown((body as any)?.username)}, ${shown((body as any)?.copper)} copper)`);
    return { result: "failed" as GrantOutcome };
  }
  log.info(`GRANT from ${shown(from)}: ${shown(share.username)}, ${share.copper} copper`);
  return { result: grantApplier ? await grantApplier(share) : "failed" };
});
registerPlayerAction("cells-grant", async (player, body: GrantBody) => {
  const share = checkedGrant(body);
  // The action runs on the player the sender named; a body for someone else is not theirs to pay out.
  if (!share || String(player?.username ?? "").toLowerCase() !== share.username.toLowerCase()) {
    log.warn(`Corpse money for ${shown((body as any)?.username)} (${shown((body as any)?.copper)} copper) refused on arrival: not a share for ${shown(player?.username)}`);
    return;
  }
  log.info(`cells-grant (bus): ${shown(share.username)}, ${share.copper} copper`);
  const result = grantApplier ? await grantApplier(share) : "failed";
  if (result !== "given") log.warn(`Corpse money for ${share.username} (${share.copper} copper) was ${result} on arrival`);
}, (body: GrantBody) => `corpse money (${body?.copper} copper) was not given`);
