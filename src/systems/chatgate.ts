import log from "../modules/logger";
import ignores from "./ignores";
import mutes from "./mutes";

export type ChatChannel = "say" | "whisper" | "party" | "guild";

/** A line a player sent. `to` are the players it reached, in lower case, its sender not among them. */
export interface ChatLine {
  at: number;
  channel: ChatChannel;
  text: string;
  to: string[];
  /** Sent while muted: it reached nobody, and its sender was not told. */
  muted: boolean;
}

/** How many of a player's latest lines are kept. */
export const LINES_KEPT = 20;
/** How long a player's lines are kept after their last one: long enough to report someone who has just left. */
export const LINES_KEPT_FOR = 30 * 60_000;
/** How much of a line is kept: the chat cap. Every channel caps a line before it gets here; this keeps what is held bounded all the same. */
export const TEXT_KEPT = 500;
/** Old lines are looked for once in this many lines. */
export const PRUNE_EVERY = 200;

const lines = new Map<string, ChatLine[]>();
let sincePrune = 0;
/** When it was last said that the mutes and ignore lists could not be read. */
let lastFailure = -Infinity;

const lower = (username: string) => String(username ?? "").toLowerCase();

export async function audience(sender: string, channel: ChatChannel, text: string, recipients: string[], now = Date.now()): Promise<{ muted: boolean; recipients: string[] }> {
  let muted = false;
  let reached = recipients;
  try {
    muted = await mutes.isMuted(sender, now);
    reached = muted ? [] : await ignores.notIgnoring(sender, recipients);
  } catch (error) {
    if (now - lastFailure >= 60_000) {
      lastFailure = now;
      log.error(`Mutes and ignore lists could not be read, so chat is not being held back by them: ${error}`);
    }
  }

  const name = lower(sender);
  const kept = lines.get(name) ?? [];
  kept.push({ at: now, channel, text: String(text ?? "").slice(0, TEXT_KEPT), to: reached.map(lower), muted });
  if (kept.length > LINES_KEPT) kept.splice(0, kept.length - LINES_KEPT);
  lines.set(name, kept);
  if (++sincePrune > PRUNE_EVERY) pruneLines(now);

  return { muted, recipients: reached };
}

/** Lets go of the lines of every player whose last one is older than they are kept for. */
export function pruneLines(now = Date.now()): void {
  sincePrune = 0;
  for (const [name, kept] of lines) {
    if (now - (kept.at(-1)?.at ?? 0) >= LINES_KEPT_FOR) lines.delete(name);
  }
}

/** A player's latest lines, oldest first. Copies. */
export function recentLines(username: string): ChatLine[] {
  return (lines.get(lower(username)) ?? []).map((line) => ({ ...line, to: [...line.to] }));
}

/** Of a player's latest lines, the ones that reached `viewer`: what a report from them may show. */
export function linesSeenBy(username: string, viewer: string): ChatLine[] {
  const name = lower(viewer);
  return recentLines(username).filter((line) => line.to.includes(name));
}

/** Lets go of one player's lines. */
export function forgetLines(username: string): void {
  lines.delete(lower(username));
}
