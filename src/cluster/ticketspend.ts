import log from "../modules/logger";
import type { ClusterStore } from "./store";

export const TICKET_KEY_PREFIX = "cells:ticket:";

export type TicketSpend = "spent" | "reused" | "unknown";

export async function spendTicket(
  store: Pick<ClusterStore, "setIfAbsent">, token: string, expiresAt: number, now = Date.now(),
): Promise<TicketSpend> {
  if (!token) return "unknown";
  // A NaN or fractional TTL would be refused by Redis and take the refusal below.
  const left = Number.isFinite(expiresAt) && Number.isFinite(now) ? Math.ceil(expiresAt - now) : 0;
  const ttlMs = Math.max(1_000, left + 1_000);
  try {
    return (await store.setIfAbsent(TICKET_KEY_PREFIX + token, "1", ttlMs)) ? "spent" : "reused";
  } catch (error) {
    log.warn(`Ticket spend not recorded (store failed); the SWITCH ticket is refused: ${error}`);
    return "unknown";
  }
}
