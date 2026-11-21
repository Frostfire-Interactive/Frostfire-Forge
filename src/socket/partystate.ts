import log from "../modules/logger";

/** Sets the player's party list and party id together. No members: no party, so party_id is null. */
export async function applyPartyMembers(p: any, members: string[], partyIdOf: (username: string) => Promise<number | null>): Promise<void> {
  p.party = members;
  if (members.length === 0) {
    p.party_id = null;
    return;
  }
  let partyId: number | null = null;
  try {
    partyId = await partyIdOf(p.username);
  } catch (error) {
    log.error(`The party id of ${p.username} could not be read: ${error}`);
  }
  // A newer update or a clear replaced the party while the look-up ran: the id of this one is not written.
  if (p.party !== members) return;
  p.party_id = partyId;
}

export function clearParty(p: any): void {
  p.party = [];
  p.party_id = null;
}

export function cacheIfHeld(cache: { get(id: string): any; set(id: string, value: any): void }, p: any): void {
  if (cache.get(p.id) === p) cache.set(p.id, p);
}
