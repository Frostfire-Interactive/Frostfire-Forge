/**
 * USER REQUEST 2026-11-14 ("When admins are in stealth, subtract them from the online player account and disallow
 * whispers. Essentially, show them as offline for non-admins."): a stealthed player looks offline to everyone but
 * admins. The world, friends, party and guild already hide them (aoi.ts, contacts.ts); this is the rest:
 *
 * - the realm list's player count: the gateway is told how many of this node's players are stealthed
 *   (`hiddenConnections` in the heartbeat) and leaves them out of the count it shows;
 * - whispers: a player's whisper to a stealthed player is answered as one to a player who is offline. Only the node
 *   holding the target knows whether they are stealthed, so it is asked there (the action WHISPER_REACH).
 */
import type { Delivery } from "../cluster/deliver";

export const WHISPER_REACH = "whisper-reach";
/** How long a whisper waits for the target's node to say whether it may reach them (ms). */
export const WHISPER_REACH_MS = 2000;

/** `reachable`: send it. `offline`: no such player online, as far as the sender may know. `unreached`: no answer. */
export type WhisperReach = "reachable" | "offline" | "unreached";

/** Whether a whisper from an admin (`admin`) or a player may reach this target. */
export function mayWhisper(target: any, args: { admin?: boolean } | undefined): boolean {
  return !target?.isStealth || !!args?.admin;
}

/** Registers the action every node answers WHISPER_REACH with. */
export function registerWhisperReach(delivery: Pick<Delivery, "registerAction">): void {
  delivery.registerAction(WHISPER_REACH, (target, args) => mayWhisper(target, args));
}

/** Whether `sender`'s whisper may reach the player named `targetName`, here or on another node. */
export async function whisperReach(delivery: Pick<Delivery, "askPlayer">, sender: any, targetName: string, timeoutMs = WHISPER_REACH_MS): Promise<WhisperReach> {
  const answer = await delivery.askPlayer<boolean>(targetName, WHISPER_REACH, { admin: !!sender?.isAdmin }, timeoutMs);
  if (answer.status === "answered") return answer.value === true ? "reachable" : "offline";
  return answer.status === "gone" ? "offline" : "unreached";
}

/** How many of these players the realm count leaves out: the stealthed ones. */
export function hiddenCount(players: Iterable<any>): number {
  let hidden = 0;
  for (const p of players) if (p?.isStealth) hidden++;
  return hidden;
}
