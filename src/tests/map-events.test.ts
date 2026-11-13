import { describe, expect, test } from "bun:test";
import { followMapEvents, type MapPlace } from "../modules/mapevents";

// The engine follows the asset server's changes (/map-events) instead of asking every few seconds: one connection,
// on which the asset server sends the maps changed since this server's place, then each change as it is made.

type Step = Error | Response | ((signal: AbortSignal) => Response);

function stream(signal?: AbortSignal) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  signal?.addEventListener("abort", () => { try { controller.error(new Error("aborted")); } catch {} });
  return {
    response: new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } }),
    send: (value: unknown) => controller.enqueue(encoder.encode(typeof value === "string" ? value : `${JSON.stringify(value)}\n`)),
    end: () => controller.close(),
  };
}

/** A stream that sends these lines and ends; or, with `open`, stays open after them. */
function lines(values: unknown[], open = false): (signal: AbortSignal) => Response {
  return (signal) => {
    const s = stream(signal);
    for (const value of values) s.send(value);
    if (!open) s.end();
    return s.response;
  };
}

function harness(steps: Step[], start: MapPlace = { epoch: "e1", seq: 4 }, options: { quietMs?: number; fullPlace?: MapPlace } = {}) {
  let place = { ...start };
  const opened: MapPlace[] = [];
  const taken: unknown[] = [];
  const waits: number[] = [];
  const warnings: string[] = [];
  const counts = { full: 0, worlds: 0, legacy: 0 };
  const follower = followMapEvents({
    open: async (p, signal) => {
      opened.push({ ...p });
      const step = steps.shift();
      if (!step) {
        follower.stop();
        throw new Error("no more");
      }
      if (step instanceof Error) throw step;
      return typeof step === "function" ? step(signal) : step;
    },
    place: () => place,
    setPlace: (p) => { place = { ...p }; },
    takeIn: async (maps) => { taken.push(maps); },
    fullCheck: async () => { counts.full++; place = options.fullPlace ?? { epoch: "e2", seq: 9 }; },
    worldsChanged: async () => { counts.worlds++; },
    legacy: () => { counts.legacy++; },
    wait: async (ms) => { waits.push(ms); },
    log: { info: () => {}, warn: (m: string) => warnings.push(m) },
    quietMs: options.quietMs ?? 60000,
  });
  return { done: follower.done, stop: follower.stop, opened, taken, waits, warnings, counts, place: () => place };
}

const first = (extra: Record<string, unknown> = {}) => ({ success: true, epoch: "e1", seq: 4, full: false, maps: [], ...extra });

describe("following the asset server's map changes", () => {
  test("takes in the maps sent at connect, then each pushed map, with no request between", async () => {
    const h = harness([lines([first({ seq: 5, maps: ["m1"] }), { epoch: "e1", from: 5, seq: 6, maps: ["m2"] }])]);
    await h.done;
    expect(h.taken).toEqual([["m1"], ["m2"]]);
    // one connection; the second is made only after the first ended, from the place it reached
    expect(h.opened).toEqual([{ epoch: "e1", seq: 4 }, { epoch: "e1", seq: 6 }]);
    expect(h.place()).toEqual({ epoch: "e1", seq: 6 });
  });

  test("a heartbeat is only kept alive, and nothing is read for it", async () => {
    const h = harness([lines([first(), "\n", "\n", "\n"])]);
    await h.done;
    expect(h.taken).toEqual([[]]);
    expect(h.counts.full).toBe(0);
  });

  test("a pushed change it has already is passed over; one after a gap connects again from its place", async () => {
    const h = harness([lines([first(), { epoch: "e1", from: 3, seq: 4, maps: ["old"] }, { epoch: "e1", from: 6, seq: 7, maps: ["far"] }], true)]);
    await h.done;
    expect(h.taken).toEqual([[]]);
    expect(h.opened).toEqual([{ epoch: "e1", seq: 4 }, { epoch: "e1", seq: 4 }]);
  });

  test("a change from another run connects again", async () => {
    const h = harness([lines([first(), { epoch: "e9", from: 4, seq: 5, maps: ["x"] }], true)]);
    await h.done;
    expect(h.taken).toEqual([[]]);
    expect(h.opened.length).toBe(2);
  });

  test("told full (a place from another run), compares every map once, then follows from the place the compare gave", async () => {
    const h = harness([lines([first({ full: true, epoch: "e2", seq: 9 }), { epoch: "e2", from: 9, seq: 10, maps: ["m"] }])]);
    await h.done;
    expect(h.counts.full).toBe(1);
    expect(h.taken).toEqual([["m"]]);
    expect(h.place()).toEqual({ epoch: "e2", seq: 10 });
  });

  test("with no place yet, compares every map before it connects", async () => {
    const h = harness([lines([first({ epoch: "e2", seq: 9 })])], { epoch: "", seq: 0 });
    await h.done;
    expect(h.counts.full).toBe(1);
    expect(h.opened[0]).toEqual({ epoch: "e2", seq: 9 });
  });

  test("reads the worlds again at each connect and at each world change", async () => {
    const h = harness([lines([first(), { worlds: true }])]);
    await h.done;
    expect(h.counts.worlds).toBe(2);
  });

  test("an asset server without /map-events is polled instead, and not followed", async () => {
    for (const status of [404, 301]) {
      const h = harness([new Response("", { status, headers: status === 301 ? { Location: "/" } : {} })]);
      await h.done;
      expect(h.counts.legacy).toBe(1);
      expect(h.opened.length).toBe(1);
    }
  });

  test("an asset server that is down or loading is tried again, waiting longer each time up to 30 s, with one warning", async () => {
    const down = () => new Error("connection refused");
    const h = harness([down(), down(), new Response("{}", { status: 503 }), down(), down(), down(), down()]);
    await h.done;
    expect(h.waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(h.warnings.length).toBe(1);
    expect(h.counts.legacy).toBe(0);
  });

  test("after a connection ends it connects again in a second, and a later outage is warned again", async () => {
    const h = harness([lines([first()]), new Error("down"), lines([first()]), new Error("down")]);
    await h.done;
    expect(h.waits).toEqual([1000, 1000, 1000, 1000]);
    expect(h.warnings.length).toBe(2);
  });

  test("a connection that goes quiet (no heartbeat) is dropped and made again", async () => {
    const h = harness([lines([first()], true)], { epoch: "e1", seq: 4 }, { quietMs: 20 });
    await h.done;
    expect(h.opened.length).toBe(2);
  });

  test("stop ends it, and closes the connection", async () => {
    let signal: AbortSignal | null = null;
    const h = harness([(s) => { signal = s; return lines([first()], true)(s); }]);
    await Bun.sleep(5);
    h.stop();
    await h.done;
    expect(signal!.aborted).toBe(true);
    expect(h.opened.length).toBe(1);
  });
});
