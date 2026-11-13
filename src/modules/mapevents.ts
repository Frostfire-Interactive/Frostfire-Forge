/** Where this server stands in the asset server's list of changed maps: the asset server's run, and its last change. */
export type MapPlace = { epoch: string; seq: number };

export interface MapEventsDeps {
  /** Opens the asset server's stream of changes (POST /map-events) from this place. */
  open(place: MapPlace, signal: AbortSignal): Promise<Response>;
  place(): MapPlace;
  setPlace(place: MapPlace): void;
  /** Writes here and reads again the maps the asset server sent. */
  takeIn(maps: unknown): Promise<unknown>;
  /** Compares every map with the asset server's; its answer gives this server its place. */
  fullCheck(): Promise<unknown>;
  /** Reads the asset server's list of worlds again, and takes in each world that changed. */
  worldsChanged(): Promise<unknown>;
  /** The asset server has no /map-events (an older one): it is asked every few seconds instead. */
  legacy(): void;
  wait(ms: number): Promise<void>;
  log: { info(message: string): void; warn(message: string): void };
  /** A connection that sends nothing (not even the heartbeat, every 5 s) for this long is dropped and made again. */
  quietMs?: number;
}

const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 30000;

/**
 * Follows the asset server's map changes on one connection (/map-events): the asset server sends the maps changed
 * since this server's place, then each map saved and each world change as it is made. Nothing is asked while the
 * connection is open. When it ends (the asset server restarted, with new files maybe), it is made again from the place
 * reached, and the asset server sends only the maps that changed. A place it cannot answer from (another run, or
 * changes it no longer holds) is answered `full`: every map is compared once (fullCheck), which gives a new place.
 */
export function followMapEvents(deps: MapEventsDeps): { stop(): void; done: Promise<void> } {
  const quietMs = deps.quietMs ?? 20000;
  let stopped = false;
  let current: AbortController | null = null;

  const followOnce = async (): Promise<"ended" | "legacy" | "connected-then-failed"> => {
    if (!deps.place().epoch) await deps.fullCheck();
    if (!deps.place().epoch) throw new Error("the asset server gave no place in its list of changed maps");
    const abort = new AbortController();
    current = abort;
    let quiet: ReturnType<typeof setTimeout> | null = null;
    const hush = () => {
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(() => abort.abort(), quietMs);
    };
    hush();
    let connected = false;
    try {
      const response = await deps.open(deps.place(), abort.signal);
      if (response.status === 404 || (response.status >= 300 && response.status < 400)) return "legacy";
      if (!response.ok || !response.body) throw new Error(`the asset server answered ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          if (connected) return "ended";
          throw new Error("the asset server closed the connection before its first answer");
        }
        // Not watched while the lines are taken in: reading many maps again can take longer than a heartbeat
        if (quiet) clearTimeout(quiet);
        quiet = null;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (!line) continue; // the heartbeat
          const message = JSON.parse(line);
          if (!connected) {
            if (!message?.success) throw new Error(message?.error || "the asset server sent no changes");
            if (message.full) {
              await deps.fullCheck();
            } else {
              await deps.takeIn(message.maps);
              if (typeof message.epoch === "string" && Number.isInteger(message.seq)) deps.setPlace({ epoch: message.epoch, seq: message.seq });
            }
            connected = true;
            onConnected();
            await worlds();
            continue;
          }
          if (message?.worlds) {
            await worlds();
            continue;
          }
          const place = deps.place();
          if (message?.epoch !== place.epoch || !Number.isInteger(message?.seq) || !Number.isInteger(message?.from)) {
            abort.abort();
            return "ended";
          }
          if (message.seq <= place.seq) continue; // had already (taken in by the compare that gave the place)
          // A change missed between: the asset server is asked again from the place, and sends it
          if (message.from !== place.seq) {
            abort.abort();
            return "ended";
          }
          await deps.takeIn(message.maps);
          deps.setPlace({ epoch: place.epoch, seq: message.seq });
        }
        hush();
      }
    } catch (error) {
      if (connected) return "connected-then-failed";
      throw error;
    } finally {
      if (quiet) clearTimeout(quiet);
      if (current === abort) current = null;
    }
  };

  let failures = 0;
  let warned = false;
  const onConnected = () => {
    failures = 0;
    if (warned) deps.log.info("Following the asset server's map changes again");
    warned = false;
  };
  const worlds = async () => {
    try {
      await deps.worldsChanged();
    } catch (error: any) {
      deps.log.warn(`World change check failed: ${error?.message ?? error}`);
    }
  };

  const done = (async () => {
    while (!stopped) {
      let wait = RETRY_FIRST_MS;
      try {
        const outcome = await followOnce();
        if (outcome === "legacy") {
          if (!stopped) {
            deps.log.warn("The asset server has no /map-events (an older version): its map changes are asked for every few seconds instead");
            deps.legacy();
          }
          return;
        }
      } catch (error: any) {
        if (stopped) return;
        failures++;
        wait = Math.min(RETRY_FIRST_MS * 2 ** (failures - 1), RETRY_MAX_MS);
        if (!warned) deps.log.warn(`Could not follow the asset server's map changes, trying again: ${error?.message ?? error}`);
        warned = true;
      }
      if (stopped) return;
      await deps.wait(wait);
    }
  })();

  return {
    stop() {
      stopped = true;
      current?.abort();
    },
    done,
  };
}
