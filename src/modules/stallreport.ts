import path from "path";

/** One frame of a sampled stack, innermost first, as JavaScriptCore's sampling profiler gives it (bun:jsc profile). */
export type SampledFrame = { name?: string; sourceURL?: string; line?: number };
export type SampledTrace = { frames: SampledFrame[] };

type Count = [place: string, samples: number];

function placeOf(frame: SampledFrame, root: string): string | null {
  if (!frame.sourceURL) return null;
  const file = path.relative(root, frame.sourceURL);
  if (!file || file.startsWith("..") || path.isAbsolute(file)) return null;
  return `${frame.name || "<anonymous>"} (${file.split(path.sep).join("/")}:${frame.line})`;
}

function ranked(counts: Map<string, number>, top: number): Count[] {
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, top);
}

/**
 * Where the sampled time went in this project's code (`root`): `busiest` counts each sample at the innermost project
 * function on its stack (time in native code, such as JSON.parse or a file read, counts at the function that called
 * it), `from` at the outermost, the timer or handler that started the work.
 */
export function placesOf(traces: SampledTrace[], root: string, top = 5): { samples: number; busiest: Count[]; from: Count[] } {
  const busiest = new Map<string, number>();
  const from = new Map<string, number>();
  for (const trace of traces) {
    const places = trace.frames.map((frame) => placeOf(frame, root)).filter((place): place is string => place !== null);
    if (places.length === 0) continue;
    busiest.set(places[0]!, (busiest.get(places[0]!) ?? 0) + 1);
    from.set(places.at(-1)!, (from.get(places.at(-1)!) ?? 0) + 1);
  }
  return { samples: traces.length, busiest: ranked(busiest, top), from: ranked(from, top) };
}

/** Samples the stack of the thread while it runs code, for `windowMs` (bun:jsc profile, about one sample a millisecond). */
async function sampleThread(windowMs: number): Promise<SampledTrace[]> {
  const { profile } = await import("bun:jsc");
  const result = (await profile(() => Bun.sleep(windowMs), 1000)) as unknown as { stackTraces?: { traces?: SampledTrace[] } };
  return result.stackTraces?.traces ?? [];
}

export type StallReporterOptions = {
  /** A timer this late means the thread was blocked. */
  thresholdMs: number;
  /** How long the thread is sampled after a block. */
  windowMs: number;
  /** The least time between the starts of two windows. */
  quietMs: number;
  /** The project's source folder: only code in it is named. */
  root: string;
  report: (line: string) => void;
  now?: () => number;
  sample?: (windowMs: number) => Promise<SampledTrace[]>;
};

/**
 * Names the code that blocks the event loop. The loop probe tells it how late each of its timers fired (late); the
 * first block over the threshold starts a window in which every stack the thread runs is sampled, and at its end one
 * line says how often the loop was blocked in it and which functions the time went to.
 */
export class StallReporter {
  private sampling = false;
  private lastWindow = -Infinity;
  private blocks = 0;
  private worstMs = 0;
  private readonly now: () => number;
  private readonly sample: (windowMs: number) => Promise<SampledTrace[]>;

  constructor(private readonly options: StallReporterOptions) {
    this.now = options.now ?? (() => performance.now());
    this.sample = options.sample ?? sampleThread;
  }

  late(lagMs: number): void {
    if (lagMs < this.options.thresholdMs) return;
    if (this.sampling) {
      this.blocks++;
      this.worstMs = Math.max(this.worstMs, lagMs);
      return;
    }
    if (this.now() - this.lastWindow < this.options.quietMs) return;
    this.sampling = true;
    this.lastWindow = this.now();
    this.blocks = 1;
    this.worstMs = lagMs;
    void this.sampleWindow();
  }

  private async sampleWindow(): Promise<void> {
    try {
      const traces = await this.sample(this.options.windowMs);
      const { samples, busiest, from } = placesOf(traces, this.options.root);
      const share = (counts: Count[]) =>
        counts.map(([place, n]) => `${place} ${Math.round((n / Math.max(samples, 1)) * 100)}%`).join(", ") || "no project code";
      const memory = process.memoryUsage();
      this.options.report(
        `Event loop blocked ${this.blocks} time(s) for up to ${Math.round(this.worstMs)} ms; ` +
          `${samples} samples of the thread in the ${Math.round(this.options.windowMs / 1000)} s after the first. ` +
          `Busiest: ${share(busiest)}. Started by: ${share(from)}. ` +
          `Heap ${Math.round(memory.heapUsed / 1048576)} MB, RSS ${Math.round(memory.rss / 1048576)} MB.`
      );
    } catch (error: any) {
      this.options.report(`Event loop blocked for up to ${Math.round(this.worstMs)} ms; the thread could not be sampled: ${error?.message ?? error}`);
    } finally {
      this.sampling = false;
    }
  }
}
