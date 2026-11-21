import os from "node:os";
import log from "../modules/logger";
import { ClusterBus } from "./bus";
import { requireClusterKeys, type ClusterKeys } from "./clusterkeys";
import { redisUrlProblem } from "./config";
import { Coordinator } from "./coordinator";
import { RedisStore } from "./redisstore";
import { sealStore } from "./storeseal";
import { installUnhandledRejectionHandler } from "../services/unhandled";

installUnhandledRejectionHandler();

// The same checks the engine makes in cluster mode (src/utility/validate_config.ts).
const startUpErrors: string[] = [];
if (!process.env.REDIS_URL) {
  startUpErrors.push("No Redis URL is set, aborting... Please set the REDIS_URL environment variable to suppress this message.");
} else {
  // As a node's: a password (not the example's) or TLS. The block table and the bus live in Redis.
  const problem = redisUrlProblem(process.env.REDIS_URL, process.env.REDIS_PASSWORD);
  if (problem) startUpErrors.push(problem);
}
// The region ends up in Redis channel names, so it is limited to plain characters.
if (!/^[A-Za-z0-9_-]{1,64}$/.test(process.env.REGION_ID ?? "")) {
  startUpErrors.push(
    "The coordinator needs REGION_ID set to 1-64 letters, digits, '_' or '-', aborting... Please set the REGION_ID environment variable to suppress this message."
  );
}
// The coordinator writes the block table and tells the nodes on the bus: its envelopes are signed like a node's.
let keys: ClusterKeys | null = null;
try {
  keys = requireClusterKeys();
} catch (error) {
  startUpErrors.push(`${(error as Error).message}, aborting...`);
}
if (startUpErrors.length > 0 || !keys) {
  for (const error of startUpErrors) log.error(error);
  process.exit(1);
}

function positiveInteger(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (Number.isInteger(value) && value > 0) return value;
  log.warn(`${name} must be a positive integer; "${raw}" is ignored`);
  return undefined;
}
const expectedNodes = positiveInteger("CLUSTER_EXPECTED_NODES");
const settleMs = positiveInteger("CLUSTER_SETTLE_MS");

const host = os.hostname().replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "host";
const store = sealStore(new RedisStore(), keys.store);
const bus = new ClusterBus(store, `coordinator-${process.env.REGION_ID}-${host}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`, keys.bus);
const coordinator = new Coordinator(store, bus, { id: bus.nodeId, expectedNodes, settleMs });
if (expectedNodes !== undefined || settleMs !== undefined) {
  log.info(`Coordinator ${bus.nodeId} splits new maps once ${[
    expectedNodes !== undefined ? `${expectedNodes} nodes are live` : "",
    `${settleMs ?? 60_000} ms have passed since the first node was`,
  ].filter(Boolean).join(", or ")}`);
}

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info(`Coordinator ${bus.nodeId} stopping (${signal})`);
  try {
    await coordinator.stop();
  } catch (error) {
    log.error(`Coordinator ${bus.nodeId} did not stop cleanly: ${error}`);
  }
  store.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

for (let wait = 1000; !stopping; wait = Math.min(wait * 2, 30_000)) {
  try {
    await bus.start();
    break;
  } catch (error) {
    log.error(`Coordinator ${bus.nodeId} could not listen on Redis, trying again in ${wait / 1000} s: ${error}`);
    await Bun.sleep(wait);
  }
}
// The lock and the passes retry on their own while Redis is away (each failure is logged).
if (!stopping) {
  await coordinator.start();
  log.success(`Coordinator ${bus.nodeId} started for region ${process.env.REGION_ID}`);
}
