import log from "../modules/logger";
import { isSwitchTicket } from "../socket/ticket";
import { trackPacket } from "./inflight";

export function spendsTicket<S>(store: S | null | undefined, token: unknown): store is S {
  return !!store && isSwitchTicket(token);
}

export function arrivalId(kept: string | null, isOpen: (id: string) => boolean): string | null {
  return kept !== null && !isOpen(kept) ? kept : null;
}

export async function guardedTeleport(cellsOn: boolean, player: any, teleport: () => Promise<unknown>): Promise<boolean> {
  if (!cellsOn) {
    await teleport();
    return true;
  }
  return trackPacket(String(player?.id), async () => {
    if (player?.handoff || player?.wt?.data?.handedOff) {
      log.warn(`Teleport of player ${player?.id} refused: the player is being handed off to another node`);
      return false;
    }
    await teleport();
    return true;
  });
}

/** How long a shutdown may take from the signal, in all: under the 20 s stop grace the compose files give. */
export const SHUTDOWN_DEADLINE_MS = 9_000;

export async function boundedStep(
  what: string,
  step: () => unknown,
  deadline: number,
  capMs = Infinity,
  now: () => number = Date.now,
): Promise<boolean> {
  const ms = Math.min(capMs, deadline - now());
  if (!(ms > 0)) {
    log.warn(`Shutdown: ${what} skipped, the shutdown deadline has passed.`);
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ended = await Promise.race([
    Promise.resolve()
      .then(step)
      .then(
        () => true,
        (error) => {
          log.error(`Shutdown: ${what} failed: ${error}`);
          return true;
        },
      ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]);
  clearTimeout(timer);
  if (!ended) log.warn(`Shutdown: ${what} cut short after ${Math.round(ms)} ms.`);
  return ended;
}
