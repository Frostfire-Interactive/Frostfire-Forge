import { Worker } from "worker_threads";
import os from "node:os";
import log from "../modules/logger.ts";
import { mergeFlushRequests, type MoverSnapshot, type ReceiverDiff, type ReceiverInfo } from "./movement_batch.ts";

export interface WorkerFlushRequest {
  tick: number;
  // Far movers' interval in flushes for this flush (movement_batch farUpdateEvery).
  farEvery?: number;
  movers: MoverSnapshot[];
  receiverIds: string[];
  receiverInfo: Record<string, ReceiverInfo>;
  diffs: ReceiverDiff[];
  // `volume`: the flush's movement volume (movement_batch batchVolume); 0 when the flush failed.
  onBatches: (batches: any[], updatedSeqs?: Record<string, number>, volume?: number) => void;
  layerId?: string;
}

interface PooledWorker {
  worker: Worker;
  flushInFlight: boolean;
  currentFlushRequest: WorkerFlushRequest | null;
  lastUsedAt: number;
  queue: WorkerFlushRequest[];
}

const MAX_WORKERS = Math.max(2, Math.min(8, os.cpus().length - 1));
const workers: PooledWorker[] = [];

const layerAssignment = new Map<string, PooledWorker>();
let nextWorkerIndex = 0;

let onWorkerRetiredCallback: ((layerId: string) => void) | null = null;

export function setOnWorkerRetired(callback: (layerId: string) => void): void {
  onWorkerRetiredCallback = callback;
}

function createWorker(): PooledWorker {
  const worker = new Worker(new URL("./movement_worker.ts", import.meta.url));
  const pooled: PooledWorker = {
    worker,
    flushInFlight: false,
    currentFlushRequest: null,
    lastUsedAt: Date.now(),
    queue: [],
  };

  worker.on("message", (message: any) => {
    if (message.type === "flushResult") {
      finishFlush(pooled, message.batches, message.updatedSeqs, typeof message.volume === "number" ? message.volume : 0);
    } else if (message.type === "flushError") {
      log.warn(`[MOVEMENT WORKER] ${message.error}`);
      finishFlush(pooled, []);
    }
  });
  worker.on("error", (error: Error) => {
    log.error(`[MOVEMENT WORKER] ${error.message}`);
    pooled.queue.length = 0;
    finishFlush(pooled, []);

    const index = workers.indexOf(pooled);
    if (index !== -1) workers.splice(index, 1);

    for (const [assignedLayer, assignedWorker] of layerAssignment.entries()) {
      if (assignedWorker !== pooled) continue;
      layerAssignment.delete(assignedLayer);
      if (onWorkerRetiredCallback) {
        onWorkerRetiredCallback(assignedLayer);
      }
    }
  });

  workers.push(pooled);
  return pooled;
}

function getPooledWorker(layerId: string): PooledWorker {
  const existing = layerAssignment.get(layerId);
  if (existing) return existing;

  let pooled: PooledWorker;
  if (workers.length < MAX_WORKERS) {
    pooled = createWorker();
  } else {
    // Round-robin across the bounded pool.
    pooled = workers[nextWorkerIndex % workers.length];
    nextWorkerIndex++;
  }

  layerAssignment.set(layerId, pooled);
  return pooled;
}

function finishFlush(pooled: PooledWorker, batches: any[], updatedSeqs?: Record<string, number>, volume = 0): void {
  const request = pooled.currentFlushRequest;
  pooled.currentFlushRequest = null;
  pooled.flushInFlight = false;

  if (request) {
    request.onBatches(batches, updatedSeqs, volume);
  }

  const next = pooled.queue.shift();
  if (next) {
    queueFlushOn(pooled, next);
  }
}

function queueFlushOn(pooled: PooledWorker, request: WorkerFlushRequest): void {
  if (pooled.flushInFlight) {
    const queuedIndex = pooled.queue.findIndex((queued) => queued.layerId === request.layerId);
    if (queuedIndex !== -1) {
      pooled.queue[queuedIndex] = mergeFlushRequests(pooled.queue[queuedIndex], request);
    } else {
      pooled.queue.push(request);
    }
    return;
  }

  pooled.flushInFlight = true;
  pooled.currentFlushRequest = request;
  pooled.lastUsedAt = Date.now();

  pooled.worker.postMessage({
    type: "flush",
    tick: request.tick,
    farEvery: request.farEvery,
    movers: request.movers,
    receiverIds: request.receiverIds,
    receiverInfo: request.receiverInfo,
    diffs: request.diffs || [],
  });

  setTimeout(() => {
    if (pooled.currentFlushRequest === request) {
      log.warn("[MOVEMENT WORKER] Flush timed out");
      finishFlush(pooled, []);
    }
  }, 5000);
}

export function queueLayerWorkerFlush(layerId: string, request: WorkerFlushRequest): void {
  request.layerId = layerId;
  queueFlushOn(getPooledWorker(layerId), request);
}

export function postToAllWorkers(message: any): void {
  for (const entry of workers) {
    try {
      entry.worker.postMessage(message);
    } catch {
      // Worker may be mid-termination; ignore
    }
  }
}

const WORKER_IDLE_TIMEOUT_MS = 30000;
setInterval(() => {
  const now = Date.now();

  for (let i = workers.length - 1; i >= 0; i--) {
    const entry = workers[i];
    if (now - entry.lastUsedAt <= WORKER_IDLE_TIMEOUT_MS) continue;
    if (entry.flushInFlight || entry.queue.length > 0) continue;

    try {
      entry.worker.terminate();
    } catch {
      // Ignore termination races
    }

    workers.splice(i, 1);

    for (const [assignedLayer, assignedWorker] of layerAssignment.entries()) {
      if (assignedWorker !== entry) continue;
      layerAssignment.delete(assignedLayer);
      if (onWorkerRetiredCallback) {
        onWorkerRetiredCallback(assignedLayer);
      }
    }
  }
}, 10000);
