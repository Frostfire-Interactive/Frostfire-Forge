import path from "node:path";
import { readRedisUrl, startLocalRedis } from "./cluster-redis";

const root = path.resolve(import.meta.dir, "..", "..");
const harness = path.join(root, "src", "utility", "cluster-local.ts");

const usage = "Usage: bun cluster <nodes> [--coordinators <n>]";

const args = process.argv.slice(2);
const nodes = Number(args.find((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--coordinators"));
if (!Number.isInteger(nodes) || nodes < 1) {
  console.error(usage);
  process.exit(1);
}

const { url, password } = readRedisUrl(process.env.REDIS_URL);
if (!process.env.CLUSTER_LINK_SECRET) {
  console.error("CLUSTER_LINK_SECRET is not set in .env.production. Set it to a long random value: cluster nodes do not start without it.");
  process.exit(1);
}

await startLocalRedis(url, password);

const cluster = Bun.spawn([process.execPath, harness, ...args], {
  cwd: root,
  env: process.env,
  stdio: ["inherit", "inherit", "inherit"],
});

process.on("SIGINT", () => {});
process.on("SIGTERM", () => {
  try { cluster.kill("SIGTERM"); } catch { /* already gone */ }
});

process.exit(await cluster.exited);
