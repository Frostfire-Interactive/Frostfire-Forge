import { describeGrant, grants, type GrantItem, type ParkedGrant } from "../cluster/grants";
import { onLinksAttached } from "../cluster/linkhooks";
import log from "../modules/logger";
import { atomically } from "../services/batch";
import { packetManager } from "../socket/packet_manager";
import { formatMoney } from "./creatures/kill";
import currency from "./currency";
import { grantWrittenBefore, pruneGrantWrites, recordGrantWrite } from "./grantwrites";
import inventory from "./inventory";
import { handedVerdict } from "./itembounds";

/** A grant whose bounds are not read yet: nothing of it was written, and it is parked again. */
class BoundsNotReady extends Error {
  constructor(id: string) {
    super(`hand-over ${id} waits for its bounds to be read`);
    this.name = "BoundsNotReady";
  }
}

function send(wt: any, packets: any[]): void {
  if (!wt || !wt.send || wt.readyState !== 1) return;
  try {
    for (const packet of packets) wt.send(packet);
  } catch {
    // Connection closing.
  }
}

export async function giveGrant(grant: ParkedGrant, player: any | null): Promise<void> {
  const username = grant.username;
  // Guard (test "a grant out of bounds is refused whole and logged lost by name").
  const verdict = await handedVerdict({
    player: username, items: grant.items, copper: grant.copper,
    source: `Hand-over ${grant.id} (${grant.call} on ${grant.owner})`, waits: "it is parked again for a later check",
  });
  if (verdict === "refused") return;
  const added: GrantItem[] = [];
  let balance: Currency | null;
  try {
    balance = await atomically([username], async (batch) => {
      if (verdict === "not-ready") throw new BoundsNotReady(grant.id);
      added.length = 0;
      // First in the batch: its guard is the transaction's first statement (grantwrites.ts).
      await recordGrantWrite(batch, grant.id);
      for (const item of grant.items) {
        if (await inventory.add(username, { name: item.itemName, quantity: item.quantity } as any, batch)) added.push(item);
      }
      return grant.copper > 0 ? await currency.add(username, { copper: grant.copper, silver: 0, gold: 0 }, batch) : null;
    });
  } catch (error) {
    // Guard (test "a grant whose id was written before is skipped, not written again").
    if (grantWrittenBefore(error)) {
      log.info(`Hand-over ${grant.id} (${grant.call} on ${grant.owner}) for ${username} was written before: not written again (${describeGrant(grant)})`);
      return;
    }
    throw error;
  }
  for (const item of grant.items) {
    if (!added.includes(item)) log.error(`Hand-over ${grant.id} for ${username}: ${item.quantity} x ${item.itemName} is not an item, so it is lost`);
  }
  log.info(`Hand-over ${grant.id} (${grant.call} on ${grant.owner}) written for ${username}${player ? "" : " to their rows"}: ${describeGrant(grant)}`);
  if (!player?.wt) return;
  for (const item of added) send(player.wt, packetManager.lootReceived({ itemName: item.itemName, quantity: item.quantity, quality: "common" }));
  if (balance) {
    send(player.wt, packetManager.currency(balance));
    send(player.wt, packetManager.notify({ message: `You receive loot: ${formatMoney(grant.copper)}` }));
  }
}

grants.setWriter(giveGrant);

onLinksAttached(() => { void pruneGrantWrites(); });
