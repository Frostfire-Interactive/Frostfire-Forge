import type { ServerOrder } from "../cluster/index";
import { followWhitelist } from "../services/whitelist";

// What an admin orders of the whole server: a restart, a shutdown. In a cluster each runs on every node of the region:
// the node that was asked does its part and tells the others, and a node that starts later joins what is under way
// (cluster/index.ts sendServerOrder, serverOrdersKept).

export const RESTART_DELAY_MS = 15 * 60000;
const NOTICE_MINUTES = 15;
const NOTICE_SECONDS = 30;
/** A notice this far behind was slow to get here, so it is still given. Further back it is skipped. */
const LATE_NOTICE_MS = 5000;

/** A restart or shutdown that is under way on this node. */
export const restartState = {
  scheduled: false,
  timers: [] as ReturnType<typeof setTimeout>[],
  shutdownStarted: false,
};

export interface ServerOrderDeps {
  players(): any[];
  tell(player: any, message: string): void;
  setTimeout(run: () => void, ms: number): any;
  clearTimeout(timer: any): void;
  setInterval(run: () => unknown, ms: number): any;
  clearInterval(timer: any): void;
  /** Tells the region's other nodes. */
  share(order: ServerOrder): void;
  /** Everyone is out: ends this node. */
  finish(reason: string): Promise<void>;
}

function tellAll(message: string, deps: ServerOrderDeps): void {
  for (const player of deps.players()) deps.tell(player, message);
}

/** Disconnects everyone and, once they are gone, ends this node. */
function drain(reason: string, deps: ServerOrderDeps): void {
  const closeAll = (players: any[]) => {
    for (const player of players) player.wt.close(1000, "Server is restarting", { drain: true });
  };
  closeAll(deps.players());
  const check = deps.setInterval(async () => {
    const remaining = deps.players();
    closeAll(remaining);
    if (remaining.length === 0) {
      deps.clearInterval(check);
      await deps.finish(reason);
    }
  }, 100);
}

/** Starts this node's countdown to a restart `leftMs` from now. */
export function startRestart(leftMs: number, deps: ServerOrderDeps): void {
  if (restartState.scheduled || restartState.shutdownStarted) return;
  restartState.scheduled = true;
  restartState.timers = [];

  const notice = (message: string, before: number) => {
    const at = leftMs - before;
    if (at < -LATE_NOTICE_MS) return;
    restartState.timers.push(deps.setTimeout(() => tellAll(message, deps), Math.max(0, at)));
  };
  for (let minutes = NOTICE_MINUTES; minutes >= 1; minutes--) {
    notice(`⚠️ Server restarting in ${minutes} minute${minutes === 1 ? "" : "s"} ⚠️`, minutes * 60000);
  }
  for (let seconds = NOTICE_SECONDS; seconds >= 1; seconds--) {
    notice(`⚠️ Server restarting in ${seconds} second${seconds === 1 ? "" : "s"} ⚠️`, seconds * 1000);
  }
  restartState.timers.push(deps.setTimeout(() => drain("/restart", deps), Math.max(0, leftMs)));
}

/** Calls this node's countdown off. */
export function callOffRestart(deps: ServerOrderDeps): void {
  if (!restartState.scheduled) return;
  restartState.timers.forEach((timer) => deps.clearTimeout(timer));
  restartState.timers = [];
  restartState.scheduled = false;
  tellAll("⚠️ Server restart has been aborted ⚠️", deps);
}

/** Warns this node's players, disconnects them and ends the node. */
export async function startShutdown(deps: ServerOrderDeps): Promise<void> {
  if (restartState.shutdownStarted) return;
  restartState.shutdownStarted = true;
  tellAll("⚠️ Server shutting down - please reconnect in a few minutes ⚠️", deps);
  await new Promise<void>((resolve) => deps.setTimeout(resolve, 5000));
  drain("/shutdown", deps);
}

/** /restart: starts the countdown everywhere, or calls it off everywhere when one is running. */
export function toggleRestart(deps: ServerOrderDeps): void {
  if (restartState.scheduled) {
    callOffRestart(deps);
    deps.share({ what: "restart-off" });
    return;
  }
  if (restartState.shutdownStarted) return;
  const endsAt = Date.now() + RESTART_DELAY_MS;
  startRestart(RESTART_DELAY_MS, deps);
  deps.share({ what: "restart", endsAt });
}

/** /shutdown: everywhere. */
export async function shutdownEverywhere(deps: ServerOrderDeps): Promise<void> {
  deps.share({ what: "shutdown" });
  await startShutdown(deps);
}

/** Carries out what an admin on another node ordered. */
export function followServerOrder(order: ServerOrder, deps: ServerOrderDeps): void {
  switch (order.what) {
    case "restart": {
      const left = Number(order.endsAt) - Date.now();
      if (left > 0) startRestart(left, deps);
      return;
    }
    case "restart-off":
      callOffRestart(deps);
      return;
    case "shutdown":
      void startShutdown(deps);
      return;
    case "whitelist":
      void followWhitelist(order);
      return;
  }
}
