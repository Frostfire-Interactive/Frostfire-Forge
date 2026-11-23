// The summoning-stone session as pure transitions: no timers, no I/O, `now` is passed in.

export const STONE_RANGE_PX = 150;
export const WAIT_MS = 30_000;
export const CAST_MS = 5_000;
export const PROMPT_MS = 60_000;
/** How often the owner of a session runs `check`. */
export const SESSION_TICK_MS = 250;

/** `cast`: false when their summon cast was broken (Esc, a stun); unknown when not given. */
export type Member = { username: string; x: number; y: number; map: string; party: string[] | null; dead: boolean; online: boolean; cast?: boolean };
export type Phase = "waiting" | "casting" | "prompting";
export type Stone = { map: string; name: string; x: number; y: number };
export type Spot = { x: number; y: number };
/** `spots`: where each toucher stood when they touched; a step from there ends their cast. */
export type Session = { stone: Stone; phase: Phase; summoner: string; target: string | null; helper: string | null; until: number; spots?: Record<string, Spot> };
export type Step = {
  session: Session | null;
  say: Array<{ to: string; text: string }>;
  effect?: "start-wait" | "start-cast" | "cancel-cast" | "offer-prompt" | "end";
};

const FAR = "Move closer to the summoning stone.";
const NO_PARTY = "You must be in a party to use a summoning stone.";
const NO_TARGET = "Target a party member to summon.";
const SUMMON_SELF = "You cannot summon yourself.";
const BUSY = "This summoning stone is already in use.";
const WAITING = "Waiting for another party member to touch the stone.";
const NOT_PARTY = "Only a member of the summoner's party can help.";
const SELF = "You cannot help summon yourself.";
const LAPSED = "Nobody else touched the summoning stone in time.";
const CANCELLED = "The summon was cancelled.";
const shown = (name: string) => `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
const noAnswer = (target: string) => `${shown(target)} did not answer.`;

export function inRange(m: Pick<Member, "x" | "y" | "map">, stone: Stone): boolean {
  return m.map === stone.map && Math.hypot(m.x - stone.x, m.y - stone.y) <= STONE_RANGE_PX;
}

const said = (to: string, text: string) => [{ to, text }];
const spotOf = (m: Member): Spot => ({ x: m.x, y: m.y });
/** Whether a toucher has stepped from where they touched, or their cast was broken. */
function moved(s: Session, m: Member | undefined): boolean {
  if (m?.cast === false) return true;
  const at = m ? s.spots?.[m.username] : undefined;
  return !!at && (m!.x !== at.x || m!.y !== at.y);
}

/**
 * A player touches the stone. On a free stone it starts the summon of `target` (the toucher's target, lower-cased):
 * another member of their party who is not at the stone already. `mates` is the live party (the toucher included),
 * read to know who is at the stone; a member on another node is not in it, and is never at the stone.
 */
export function touch(s: Session | null, who: Member, stone: Stone, now: number, mates?: Member[], target?: string | null): Step {
  if (!inRange(who, stone)) return { session: s, say: said(who.username, FAR) };
  if (!s) {
    if (!who.party || who.party.length === 0) return { session: null, say: said(who.username, NO_PARTY) };
    if (!target) return { session: null, say: said(who.username, NO_TARGET) };
    if (target === who.username) return { session: null, say: said(who.username, SUMMON_SELF) };
    if (!who.party.includes(target)) return { session: null, say: said(who.username, `${shown(target)} is not in your party.`) };
    const there = mates?.find((m) => m.username === target);
    if (there && inRange(there, stone)) return { session: null, say: said(who.username, `${shown(target)} is already at the summoning stone.`) };
    return {
      session: { stone, phase: "waiting", summoner: who.username, target, helper: null, until: now + WAIT_MS, spots: { [who.username]: spotOf(who) } },
      say: said(who.username, WAITING),
      effect: "start-wait",
    };
  }
  if (s.phase !== "waiting") return { session: s, say: said(who.username, BUSY) };
  if (who.username === s.summoner) return { session: s, say: said(who.username, WAITING) };
  if (who.username === s.target) return { session: s, say: said(who.username, SELF) };
  if (!who.party || !who.party.includes(s.summoner)) return { session: s, say: said(who.username, NOT_PARTY) };
  return {
    session: { ...s, phase: "casting", helper: who.username, until: now + CAST_MS, spots: { ...s.spots, [who.username]: spotOf(who) } },
    say: [],
    effect: "start-cast",
  };
}

/** A toucher who is still there: online, alive, and at the stone. A handed-off one is missing from the map. */
function present(m: Member | undefined, stone: Stone): m is Member {
  return !!m && m.online && !m.dead && inRange(m, stone);
}

/** Run every SESSION_TICK_MS. */
export function check(s: Session, members: Map<string, Member | undefined>, now: number): Step {
  const summoner = members.get(s.summoner);
  if (s.phase === "waiting") {
    if (now > s.until) return { session: null, say: said(s.summoner, LAPSED), effect: "end" };
    if (!present(summoner, s.stone)) return { session: null, say: [], effect: "end" };
    if (moved(s, summoner)) return { session: null, say: said(s.summoner, CANCELLED), effect: "end" };
    return { session: s, say: [] };
  }
  if (s.phase === "casting") {
    const helper = s.helper ? members.get(s.helper) : undefined;
    const together = present(summoner, s.stone) && present(helper, s.stone)
      && !!summoner.party && !!helper.party
      && summoner.party.includes(helper.username) && helper.party.includes(summoner.username)
      && (s.target === null || summoner.party.includes(s.target))
      && !moved(s, summoner) && !moved(s, helper);
    if (!together) {
      const say = [s.summoner, ...(s.helper ? [s.helper] : [])].map((to) => ({ to, text: CANCELLED }));
      return { session: null, say, effect: "cancel-cast" };
    }
    if (now >= s.until) return { session: { ...s, phase: "prompting", until: now + PROMPT_MS }, say: [], effect: "offer-prompt" };
    return { session: s, say: [] };
  }
  // Not answered in time. The same line whether the prompt was shown or the target ignores the summoner.
  if (now > s.until) return { session: null, say: s.target ? said(s.summoner, noAnswer(s.target)) : [], effect: "end" };
  return { session: s, say: [] };
}
