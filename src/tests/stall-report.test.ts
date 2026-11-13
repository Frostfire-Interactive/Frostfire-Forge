import { describe, expect, test } from "bun:test";
import path from "path";
import { StallReporter, placesOf } from "../modules/stallreport";

const root = path.resolve("src");
const at = (name: string, file: string, line: number) => ({ name, sourceURL: path.join(root, file), line });
const native = (name: string) => ({ name, line: 4294967295 });

describe("placesOf", () => {
  test("names the project code each sample was in, and the project code that started it", () => {
    const traces = [
      { frames: [native("statSync"), at("calculateFileChecksum", "modules/checksums.ts", 24), at("calculateAllMapChecksums", "modules/checksums.ts", 53), at("", "socket/receiver.ts", 2433)] },
      { frames: [at("calculateFileChecksum", "modules/checksums.ts", 24), at("", "socket/receiver.ts", 2433)] },
      { frames: [native("parse"), at("tick", "systems/creatures/index.ts", 90)] },
      { frames: [native("gc")] },
    ];
    expect(placesOf(traces, root)).toEqual({
      samples: 4,
      busiest: [
        ["calculateFileChecksum (modules/checksums.ts:24)", 2],
        ["tick (systems/creatures/index.ts:90)", 1],
      ],
      from: [
        ["<anonymous> (socket/receiver.ts:2433)", 2],
        ["tick (systems/creatures/index.ts:90)", 1],
      ],
    });
  });

  test("leaves out code outside the project", () => {
    const traces = [{ frames: [{ name: "x", sourceURL: path.resolve("node_modules/lib/index.js"), line: 1 }] }];
    expect(placesOf(traces, root)).toEqual({ samples: 1, busiest: [], from: [] });
  });
});

describe("StallReporter", () => {
  const traces = [{ frames: [at("calculateFileChecksum", "modules/checksums.ts", 24), at("poll", "socket/receiver.ts", 2433)] }];

  function reporter(quietMs = 60_000) {
    let clock = 0;
    let finish: (() => void) | null = null;
    const lines: string[] = [];
    const sampled: number[] = [];
    const subject = new StallReporter({
      thresholdMs: 1000,
      windowMs: 30_000,
      quietMs,
      root,
      report: (line) => lines.push(line),
      now: () => clock,
      sample: async (windowMs) => {
        sampled.push(windowMs);
        await new Promise<void>((resolve) => (finish = resolve));
        return traces;
      },
    });
    return {
      subject,
      lines,
      sampled,
      advance: (ms: number) => (clock += ms),
      endWindow: async () => {
        finish!();
        await Bun.sleep(0);
      },
    };
  }

  test("a late timer under the threshold is left alone", () => {
    const { subject, sampled } = reporter();
    subject.late(999);
    expect(sampled).toEqual([]);
  });

  test("a block samples the thread for a while, then names where the time went", async () => {
    const { subject, lines, sampled, endWindow } = reporter();
    subject.late(4000);
    expect(sampled).toEqual([30_000]);
    subject.late(3500);
    subject.late(200);
    await endWindow();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("blocked 2 time(s) for up to 4000 ms");
    expect(lines[0]).toContain("calculateFileChecksum (modules/checksums.ts:24) 100%");
    expect(lines[0]).toContain("poll (socket/receiver.ts:2433) 100%");
  });

  test("one window at a time, and none again until the quiet time has passed", async () => {
    const { subject, sampled, advance, endWindow } = reporter(60_000);
    subject.late(4000);
    subject.late(4000);
    expect(sampled).toHaveLength(1);
    await endWindow();
    advance(59_999);
    subject.late(4000);
    expect(sampled).toHaveLength(1);
    advance(1);
    subject.late(4000);
    expect(sampled).toHaveLength(2);
  });

  test("a sampler that fails is reported once and does not stop the next window", async () => {
    const lines: string[] = [];
    let clock = 0;
    let calls = 0;
    const subject = new StallReporter({
      thresholdMs: 1000, windowMs: 10, quietMs: 5, root, now: () => clock, report: (line) => lines.push(line),
      sample: async () => { calls++; throw new Error("no profiler"); },
    });
    subject.late(2000);
    await Bun.sleep(0);
    expect(lines).toEqual([expect.stringContaining("no profiler")]);
    clock = 10;
    subject.late(2000);
    await Bun.sleep(0);
    expect(calls).toBe(2);
  });
});
