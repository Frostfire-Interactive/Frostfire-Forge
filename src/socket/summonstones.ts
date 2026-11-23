import log from "../modules/logger";
import playerCache from "../services/playermanager";
import { askPlayer, deliverToPlayer, registerPlayerAction, runOnPlayer } from "../cluster/deliver";
import { invitations } from "../cluster/invitations";
import { summonClaims, stoneKey } from "../cluster/summonclaims";
import { isCopyKey } from "../systems/dungeons/copykey";
import { PROMPT_MS, SESSION_TICK_MS, WAIT_MS, check, touch, type Member, type Session, type Step, type Stone } from "../systems/summonsession";
import { randomBytes } from "../modules/hash";
import type { SummonSpot } from "./summonmove";

// Summoning stones at run time: a touch with a party member targeted, the wait for a helper, the cast, the prompt and the move. The rules are
// systems/summonsession.ts; this holds the sessions of the stones on this node and does the sending.

/** What a SUMMON_STONE invitation carries: where the target is taken. */
export type SummonInvite = { map: string; x: number; y: number; stone: string };

const SUMMON_GAP = 8;
const lower = (s: unknown): string => String(s ?? "").toLowerCase();
const shown = (username: string): string => username.charAt(0).toUpperCase() + username.slice(1);

/** Where a summoned player lands: just below the stone's foot, facing down. */
export function summonSpot(stone: { map: string; x: number; y: number }): SummonSpot {
  return { map: stone.map, x: stone.x, y: stone.y + SUMMON_GAP, direction: "down" };
}

/** Why the target cannot be summoned now, or null. A player who is not online is null here: `t` is null for that. */
export function targetProblem(t: { username: string; isDead?: boolean; isGhost?: boolean; location: { map: string } } | null, inDungeon: boolean, name?: string): string | null {
  if (!t) return name ? `${shown(name)} is not online.` : "That player is not online.";
  const who = shown(t.username);
  if (t.isDead || t.isGhost) return `${who} is dead.`;
  if (isCopyKey(String(t.location?.map ?? "")) || inDungeon) return `${who} is inside a dungeon.`;
  return null;
}

// ----------------------------------------------------------------- helpers

// The socket layer is loaded when first needed, so the pure parts above can be used (and tested) without it.
const socket = () => io.socket();
const tell = (to: string, message: string): void => void socket().then((m) => io.deliverToPlayer(to, m.packetManager.notify({ message })));

function memberOf(p: any): Member {
  const party = Array.isArray(p.party) && p.party.length ? p.party.map(lower) : null;
  return {
    username: lower(p.username), x: Number(p.location?.position?.x), y: Number(p.location?.position?.y), map: String(p.location?.map ?? ""),
    party, dead: !!(p.isDead || p.isGhost), online: true,
  };
}

/** A party member not on this node: somewhere else, so never at the stone and alive as far as is known. */
const elsewhere = (username: string): Member => ({ username, x: Number.NaN, y: Number.NaN, map: "", party: null, dead: false, online: true });

/** The summoner's live party, the summoner included: members on this node as they are, others as placeholders. */
function matesOf(p: any): Member[] {
  const names: string[] = Array.isArray(p.party) ? p.party.map(lower) : [];
  return names.map((n) => { const here = playerCache.getByUsername(n); return here ? memberOf(here) : elsewhere(n); });
}

async function stoneAt(p: any, name: unknown): Promise<Stone | null> {
  if (typeof name !== "string") return null;
  const map = String(p?.location?.map ?? "");
  if (!map || isCopyKey(map)) return null;
  const found = (await socket()).stonesOn(map)?.find((s) => s.name === name);
  return found ? { map, name: found.name, x: found.position.x, y: found.position.y } : null;
}

// ---------------------------------------------------------------- sessions

type Held = { session: Session; authorization?: string };
/** What the runtime talks to; a test swaps these. */
export const io = { askPlayer, deliverToPlayer, runOnPlayer, socket: async () => ({ ...(await import("./receiver")), ...(await import("./packet_manager")), ...(await import("./dungeons")) }) };

const sessions = new Map<string, Held>();
/** Stones whose summoner's touch is being checked and claimed: another touch meanwhile is ignored. */
const asking = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

const keyOf = (stone: Stone) => stoneKey(stone.map, stone.name);

function sayAll(step: Step): void {
  for (const line of step.say) tell(line.to, line.text);
}

/** Whether a player is in their summoning-stone cast now: its cast is the one they are in. */
export const castingSummon = (p: any): boolean => !!p?.casting && p.summonCastId !== undefined && p.summonCastId === p.castId;

/** The summoner's wait and then the cast, as one cast made on the spot: a step breaks it (movement.ts interrupts it), as
 *  it does the home item's. Already in it, nothing changes. */
export function startSummonCast(p: any): void {
  if (castingSummon(p)) return;
  p.casting = true;
  p.castOnSelf = true;
  p.interruptableSpell = true;
  p.castingSpellId = undefined;
  p.castId = (p.castId || 0) + 1;
  p.summonCastId = p.castId;
  p.mounted = false;
}

function castBar(username: string, spell: string, time: number): void {
  void io.runOnPlayer(username, "summon-stone-cast", { spell, time });
}

async function release(key: string, s: Session): Promise<void> {
  if (s.target) await summonClaims.release(key, s.target, s.summoner);
}

/** The session after a step: stored, or gone with what it held let go. */
async function settle(key: string, was: Session | null, step: Step): Promise<boolean> {
  // The session was replaced or ended while the caller waited: its step is stale and changes nothing.
  if ((sessions.get(key)?.session ?? null) !== was) return false;
  sayAll(step);
  if (!step.session) {
    const held = sessions.get(key);
    sessions.delete(key);
    if (was) await release(key, was);
    if (held?.authorization) await invitations.take(held.authorization);
    stopWhenEmpty();
  } else {
    const held = sessions.get(key);
    sessions.set(key, { session: step.session, authorization: held?.authorization });
    startTicking();
  }
  const castOver = was?.phase === "casting" && step.effect !== undefined && step.effect !== "offer-prompt" && step.effect !== "start-cast";
  // The summoner's wait ended without a helper: its bar and pose just go, as nothing interrupted it.
  const waitOver = was?.phase === "waiting" && !step.session;
  if (castOver) for (const name of [was.summoner, was.helper]) if (name) castBar(name, "interrupted", 1);
  if (waitOver) castBar(was.summoner, "Summoning", 0);
  return true;
}

function startTicking(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), SESSION_TICK_MS);
}

function stopWhenEmpty(): void {
  if (sessions.size > 0 || !timer) return;
  clearInterval(timer);
  timer = null;
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const key of [...sessions.keys()]) {
      const held = sessions.get(key);
      if (!held) continue;
      const s = held.session;
      const members = new Map<string, Member | undefined>();
      for (const name of [s.summoner, s.helper]) {
        if (!name) continue;
        const here = playerCache.getByUsername(name);
        members.set(name, here ? { ...memberOf(here), cast: castingSummon(here) } : undefined);
      }
      // Once the target has answered (or the prompt was dropped) its claim is gone: the session is over.
      if (s.phase === "prompting" && s.target && !(await summonClaims.targetBusy(s.target))) {
        if (sessions.get(key)?.session !== s) continue;
        await settle(key, s, { session: null, say: [], effect: "end" });
        continue;
      }
      if (sessions.get(key)?.session !== s) continue;
      const step = check(s, members, Date.now());
      if (step.session === s && !step.effect) continue;
      await run(key, s, step);
    }
  } catch (error) {
    log.error(`Summoning stone tick failed: ${error}`);
  } finally {
    ticking = false;
  }
}

/** Applies a step: its messages, its session, and what it asks for. */
async function run(key: string, was: Session | null, step: Step): Promise<void> {
  if (!(await settle(key, was, step))) return;
  const s = step.session;
  // The touchers are in the cast at once (they are on this node), so the next check finds them in it.
  const inCast = (name: string) => { const here = playerCache.getByUsername(name); if (here) startSummonCast(here); };
  if (step.effect === "start-wait" && s) {
    inCast(s.summoner);
    castBar(s.summoner, "Summoning", WAIT_MS / 1000);
  } else if (step.effect === "start-cast" && s) {
    for (const name of [s.summoner, s.helper]) if (name) { inCast(name); castBar(name, "Summoning", 5); }
  } else if (step.effect === "offer-prompt" && s) {
    for (const name of [s.summoner, s.helper]) if (name) castBar(name, "Summoning", 0);
    // Not awaited: a slow ask of another node must not hold up the other stones' sessions.
    void offerPrompt(key, s).catch((error) => log.error(`Summoning stone offer failed: ${error}`));
  }
}

/** The cast is done: the target is asked, from its own node, whether to come. */
async function offerPrompt(key: string, s: Session): Promise<void> {
  const target = s.target!;
  const summoner = playerCache.getByUsername(s.summoner);
  const authorization = randomBytes(16).toString();
  // Kept before the ask: an offer that is made after the ask timed out is still taken back when the session ends.
  const held = sessions.get(key);
  if (held) held.authorization = authorization;
  const answer = await io.askPlayer<unknown>(target, "summon-stone", {
    step: "offer", from: s.summoner, originator: String(summoner?.id ?? s.summoner), authorization,
    summon: { map: s.stone.map, x: s.stone.x, y: s.stone.y, stone: s.stone.name } satisfies SummonInvite,
  }, 5_000);
  const v: any = answer.status === "answered" ? answer.value : undefined;
  const object = v !== null && typeof v === "object";
  if (object && v.ok === true) return;
  if (sessions.get(key)?.session !== s) return;
  const text = object && typeof v.problem === "string" ? v.problem : `${shown(target)} is not online.`;
  tell(s.summoner, text);
  await settle(key, s, { session: null, say: [], effect: "end" });
}

// ----------------------------------------------------------------- packets

/** SUMMON_STONE_TOUCH: the player touched a stone on their map, with the party member they have targeted (`target`). */
export async function touchStone(p: any, data: any): Promise<void> {
  if (!p || p.isDead || p.isGhost) return;
  const stone = await stoneAt(p, data?.name);
  if (!stone) return;
  const key = keyOf(stone);
  const was = sessions.get(key)?.session ?? null;
  const me = memberOf(p);
  const step = touch(was, me, stone, Date.now(), matesOf(p), lower(data?.target) || null);
  if (step.session === was && !step.effect) return sayAll(step);
  // The touch starts this player's cast: they stand still for it, and are in no other cast.
  if (step.effect === "start-wait" || step.effect === "start-cast") {
    if (p.moving) return tell(me.username, "You must stand still to use that.");
    if (p.casting || playerCache.get(p.id)?.casting) return;
  }
  if (step.effect !== "start-wait" || !step.session) return run(key, was, step);

  // The summoner's first touch is being checked: this one (a double click) changes nothing.
  if (asking.has(key)) return;
  const target = step.session.target!;
  asking.add(key);
  try {
    const problem = await asked(target);
    if (problem) return tell(me.username, problem);
    const claim = await summonClaims.claim(key, target, me.username);
    if (claim === "stone") return tell(me.username, "This summoning stone is already in use.");
    if (claim === "target") return tell(me.username, `${shown(target)} is already being summoned.`);
    // Another session took the stone while the claim was asked for.
    if (sessions.has(key)) {
      await summonClaims.release(key, target, me.username);
      return;
    }
    await run(key, null, step);
  } finally {
    asking.delete(key);
  }
}

/** The target's own node says whether it can be summoned: null when it can. No answer, or one that makes no sense, is a target not reached. */
async function asked(target: string): Promise<string | null> {
  const answer = await io.askPlayer<unknown>(target, "summon-stone", { step: "check" }, 5_000);
  const v: any = answer.status === "answered" ? answer.value : undefined;
  if (v !== null && typeof v === "object") {
    if (typeof v.problem === "string") return v.problem;
    if (v.ok === true) return null;
  }
  return targetProblem(null, false, target);
}

registerPlayerAction("summon-stone", async (target, args: any) => {
  const problem = targetProblem(target, false);
  if (args?.step === "check") return problem ? { problem } : { ok: true };
  if (args?.step !== "offer") return null;
  if (problem) return { problem };
  const from = { username: String(args.from) };
  const summon = args.summon as SummonInvite;
  const sent = await (await socket()).offerInvitation(from, target.username, {
    action: "SUMMON_STONE", message: `${shown(from.username)} wants to summon you to a summoning stone.`,
    originator: String(args.originator), authorization: String(args.authorization),
  }, undefined, { summon, ttlMs: PROMPT_MS });
  return sent ? { ok: true } : { problem: `${shown(target.username)} is not online.` };
});

registerPlayerAction("summon-stone-cast", async (p, args: any) => {
  if (!p?.wt) return;
  const m = await socket();
  const { broadcastCastToAOI } = await import("./aoi");
  const live = playerCache.get(p.id) ?? p;
  const spell = String(args?.spell ?? "");
  const time = Number(args?.time) || 0;
  const bar = () => broadcastCastToAOI(live, m.packetManager.castSpell({ id: live.id, spell, time }));
  const pose = async (casting: boolean) => {
    if (!live.wt) return;
    m.bumpStateRevision();
    await m.sendPositionAnimation(live.wt, live.location?.position?.direction || "down", false, false, live.mount_type || "unicorn", undefined, m.stateRevision(), casting);
  };
  if (spell === "Summoning" && time > 0) {
    // The wait, then the cast: shown with the casting pose, which a step breaks.
    for (const held of new Set([p, live])) startSummonCast(held);
    if (live !== p) { p.castId = live.castId; p.summonCastId = live.summonCastId; }
    playerCache.set(live.id, live);
    await pose(true);
    bar();
    return;
  }
  // A step already broke the cast and showed it interrupted.
  if (!castingSummon(live)) return;
  if (spell === "interrupted") return m.interruptPlayerCast(live);
  // The cast is done: its bar and its pose go.
  for (const held of new Set([p, live])) {
    held.casting = false;
    held.interruptableSpell = false;
    held.summonCastId = undefined;
  }
  playerCache.set(live.id, live);
  bar();
  await pose(false);
});

/** Test hooks: one tick of the sessions, and a clean slate. */
export const tickSessions = (): Promise<void> => tick();
export function resetSummonSessions(): void {
  sessions.clear();
  asking.clear();
  if (timer) clearInterval(timer);
  timer = null;
  ticking = false;
}

/** Test hook: whether any session is held. */
export function summonSessionsHeld(): number {
  return sessions.size;
}
