import { ghosts, type GhostKindName } from "./ghosts";
import { linkCalls, neverRan } from "./linkcalls";
import { mirrorPlayers } from "./mirrors";
import { grants, handOverOf } from "./grants";
import log from "../modules/logger";
import { handedVerdict } from "../systems/itembounds";

/** The room in a player's bags: free slots, and the lowercase names of what they hold (more of one takes no slot). */
export interface BagRoom {
  free: number;
  held: string[];
}

/** The items `room` has space for, in order, as kill.ts fitsInBags counts it. */
export function fitsInRoom<T extends { itemName: string }>(room: BagRoom, items: T[]): T[] {
  const held = new Set(room.held.map((name) => String(name).toLowerCase()));
  let free = room.free;
  const fits: T[] = [];
  for (const item of items) {
    const key = String(item.itemName).toLowerCase();
    if (!held.has(key)) {
      if (free <= 0) continue;
      free--;
      held.add(key);
    }
    fits.push(item);
  }
  return fits;
}

export type ItemCall = "LOOT_OPEN" | "LOOT_TAKE" | "PICKUP_REQUEST" | "CHEST_OPEN" | "CHEST_TAKE";

export interface ItemAnswer {
  ok: boolean;
  reason?: string;
  [field: string]: unknown;
}

/** Serves one item call for `actor`, the calling player's mirror here. */
export type ItemServer = (actor: any, body: any) => ItemAnswer | Promise<ItemAnswer>;

const KINDS: Record<ItemCall, GhostKindName> = {
  LOOT_OPEN: "creature",
  LOOT_TAKE: "creature",
  PICKUP_REQUEST: "loot",
  CHEST_OPEN: "chest",
  CHEST_TAKE: "chest",
};

/** The node that owns the thing an item call acts on. Null when this node owns it, or nobody mirrors it here. */
export function itemOwner(name: ItemCall, id: string | number): string | null {
  return ghosts.ownerOf(KINDS[name], id);
}

export function serveItems(name: ItemCall, fn: ItemServer): () => void {
  return linkCalls.handle(name, async (body: any, from: string) => {
    const actor = mirrorPlayers.get(String(body?.actor?.id));
    const sameName = String(actor?.username ?? "").toLowerCase() === String(body?.actor?.username ?? "").toLowerCase();
    if (!actor || actor.mirrorFrom !== from || !sameName) return { ok: false, reason: "not_found" };
    const answer = await fn(actor, body);
    if (TAKES.has(name) && answer?.ok) {
      const handed = describeHandOver(answer);
      if (handed) {
        log.info(`${name} from ${from}: ${actor.username} (${actor.id}) was handed ${handed}`);
        const grantId = await grants.park({ username: String(actor.username), ...handOverOf(answer), call: name });
        if (grantId) return { ...answer, grantId };
      }
    }
    return answer;
  });
}

/** The calls that take something off the owner's side. */
const TAKES = new Set<ItemCall>(["LOOT_TAKE", "PICKUP_REQUEST", "CHEST_TAKE"]);

/** What an answer to a take hands over, as one line ("2 x Bone, 1 x Fang, 11 copper"). Empty when it hands over nothing. */
export function describeHandOver(answer: ItemAnswer): string {
  const parts: string[] = [];
  const rows: any[] = Array.isArray(answer.items) ? answer.items : answer.item ? [answer.item] : [];
  for (const row of rows) parts.push(`${row?.quantity ?? 1} x ${row?.itemName ?? row?.item ?? "?"}`);
  const copper = Number(answer.copper) || 0;
  if (copper > 0) parts.push(`${copper} copper`);
  return parts.join(", ");
}

export function handedRows(answer: ItemAnswer): Array<{ itemName: unknown; quantity: unknown }> {
  if (Array.isArray(answer.items)) return answer.items.map((row: any) => ({ itemName: row?.itemName, quantity: row?.quantity }));
  const row: any = answer.item;
  if (row && typeof row === "object") return [{ itemName: row.item ?? row.itemName, quantity: row.quantity }];
  return [];
}

export async function askOwner(name: ItemCall, id: string | number, player: any, body: Record<string, unknown>): Promise<ItemAnswer | null> {
  const owner = itemOwner(name, id);
  if (!owner) return null;
  const outcome = await linkCalls.call<ItemAnswer>(owner, name, { ...body, actor: { id: String(player.id), username: player.username } });
  if (outcome.ok) {
    const answer = outcome.answer;
    const grantId = answer?.ok && TAKES.has(name) ? answer.grantId : undefined;
    if (answer?.ok && TAKES.has(name)) {
      const handed = handedRows(answer);
      const source = `${name} of ${id} on ${owner}${typeof grantId === "string" ? ` (hand-over ${grantId})` : ""}`;
      const parked = typeof grantId === "string";
      const verdict = await handedVerdict({
        player: String(player.username), items: handed, copper: answer.copper ?? 0, source,
        waits: parked ? `it stays parked, and ${owner}'s recovery writes it` : "no hand-over was parked to wait in",
      });
      if (verdict === "refused") {
        if (parked) await grants.claim(grantId);
        return { ok: false, reason: "failed" };
      }
      if (verdict === "not-ready") {
        if (!parked) log.error(`${source} for ${player.username} is lost: ${describeHandOver(answer)} could not be checked yet and no hand-over was parked`);
        return { ok: false, reason: "failed" };
      }
    }
    // A parked hand-over is written here only once this node has taken it: else the owner's recovery gives it.
    if (typeof grantId === "string" && !(await grants.claim(grantId, handOverOf(answer)))) {
      log.warn(`${name} of ${id} on ${owner} for ${player.username}: hand-over ${grantId} was not claimed here, so it is not written here (${owner}'s recovery has it, unless the line above says it may be lost)`);
      return { ok: false, reason: "failed" };
    }
    return answer;
  }
  if (TAKES.has(name)) {
    if (!neverRan(outcome)) log.warn(`${name} of ${id} on ${owner} for ${player.username} ended ${outcome.why}: ${grants.attached() ? `if ${owner} took anything for them, its recovery gives it` : "what the owner took for them may be lost"}`);
    else if (outcome.why !== "down") log.warn(`${name} of ${id} on ${owner} for ${player.username} ended ${outcome.why}: it did not run, so nothing was taken`);
  }
  return { ok: false, reason: "failed" };
}
