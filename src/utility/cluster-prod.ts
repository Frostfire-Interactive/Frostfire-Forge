import { isIP } from "node:net";
import path from "node:path";
import { clearClusterState, readRedisUrl } from "./cluster-redis";

const root = path.resolve(import.meta.dir, "..", "..");
const PROJECT = "frostfire-forge-prod-cluster";
const IMAGE = "frostfire-forge-prod-cluster:local";
const MAX_NODES = 16;
const MAX_COORDINATORS = 4;
const PORT_STEP = 10;

const usage = "Usage: bun ./src/utility/cluster-prod.ts <rebuild|down|logs>, with CLUSTER_NODES set in .env.production";

function count(name: string, value: string | undefined, max: number, fallback?: number): number {
  const parsed = value?.trim() ? Number(value) : fallback;
  if (parsed === undefined || !Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    console.error(`${name} in .env.production must be a whole number from 1 to ${max}${fallback === undefined ? "" : ` (default ${fallback})`}.`);
    console.error(usage);
    process.exit(1);
  }
  return parsed;
}

function portFrom(value: string | undefined, fallback: number | null): number | null {
  const parsed = parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const command = process.argv[2];
if (command !== "rebuild" && command !== "down" && command !== "logs") {
  console.error(usage);
  process.exit(1);
}

const nodeCount = count("CLUSTER_NODES", process.env.CLUSTER_NODES, MAX_NODES);
const coordinatorCount = count("CLUSTER_COORDINATORS", process.env.CLUSTER_COORDINATORS, MAX_COORDINATORS, 1);
const regionId = process.env.REGION_ID || "local";

// The same reads as server.ts and cluster-local.ts.
const baseGamePort = portFrom(process.env.WEBSRV_PORTSSL, null) ?? portFrom(process.env.GAME_PORT, 3000)!;
const baseHttpPort = portFrom(process.env.WEBSRV_PORT, null);
const baseInternalPort = portFrom(process.env.WEBSRV_INTERNAL_PORT, 3002)!;
const linksOff = process.env.NODE_LINK_PORT?.trim() === "0";
const baseLinkPort = portFrom(process.env.NODE_LINK_PORT, null) ?? baseGamePort + 5;

const highest = Math.max(baseGamePort, baseHttpPort ?? 0, baseInternalPort, baseLinkPort) + PORT_STEP * nodeCount;
if (highest > 65535) {
  console.error(`Ports would pass 65535 (base ports + ${PORT_STEP * nodeCount}). Lower the base ports in .env.production.`);
  process.exit(1);
}

const clusterEnv = { CLUSTER: "true", CACHE: "redis", REGION_ID: regionId };

const linkName = (process.env.NODE_LINK_HOST || process.env.PUBLIC_HOST || process.env.SERVER_HOST || "").trim();
const linkByName = linkName !== "" && linkName !== "localhost" && isIP(linkName) === 0;
const linkHost = linkByName ? linkName : "127.0.0.1";

const engine = {
  image: IMAGE,
  pull_policy: "never",
  network_mode: "host",
  env_file: [path.join(root, ".env.production")],
  volumes: [
    `${path.join(root, "src", "certs")}:/app/src/certs`,
    `${path.join(root, "src", "logs")}:/app/src/logs`,
    `${path.join(root, "src", "config")}:/app/src/config`,
  ],
  ulimits: { nofile: { soft: 1048576, hard: 1048576 } },
  restart: "always",
  // The engine's shutdown takes up to 9 s (running handoffs, achievement flush, leaving the cluster).
  stop_grace_period: "20s",
};
const afterSetup = { "db-setup": { condition: "service_completed_successfully" } };

const services: Record<string, unknown> = {
  "db-setup": {
    ...engine,
    build: { context: root, dockerfile: "src/docker/Dockerfile.prod" },
    restart: "no",
    command: ["sh", "-c", "bun create-config --environment production && exec bun ./src/utility/database_setup_dispatch.ts"],
    healthcheck: { disable: true },
  },
};
const coordinatorName = (i: number) => (i === 1 ? "coordinator" : `coordinator-${i}`);
for (let i = 1; i <= coordinatorCount; i++) {
  services[coordinatorName(i)] = {
    ...engine,
    command: ["bun", "./src/cluster/coordinator-main.ts"],
    environment: { ...clusterEnv, CLUSTER_EXPECTED_NODES: String(nodeCount) },
    healthcheck: { disable: true },
    depends_on: afterSetup,
  };
}
for (let i = 1; i <= nodeCount; i++) {
  const offset = PORT_STEP * i;
  const gamePort = String(baseGamePort + offset);
  const environment: Record<string, string> = {
    ...clusterEnv,
    NODE_ID: `node-${i}`,
    SERVER_ID: `${regionId}-node-${i}`,
    WEBSRV_PORTSSL: gamePort,
    GAME_PORT: gamePort,
    WEBSRV_INTERNAL_PORT: String(baseInternalPort + offset),
    NODE_LINK_PORT: linksOff ? "0" : String(baseLinkPort + offset),
    NODE_LINK_HOST: linkHost,
    NODE_LINK_BIND_HOST: process.env.NODE_LINK_BIND_HOST?.trim() || "127.0.0.1",
  };
  if (baseHttpPort !== null) environment.WEBSRV_PORT = String(baseHttpPort + offset);
  services[`node-${i}`] = {
    ...engine,
    command: ["bun", "./src/socket/server.ts", "--sql-preconnect"],
    environment,
    ...(linkByName ? { extra_hosts: [`${linkName}:127.0.0.1`] } : {}),
    depends_on: { ...afterSetup, coordinator: { condition: "service_started" } },
  };
}

// JSON is YAML, so compose reads the project as it is.
const project = JSON.stringify({ name: PROJECT, services });

async function compose(args: string[]): Promise<void> {
  const proc = Bun.spawn(["docker", "compose", "-f", "-", ...args], {
    cwd: root,
    stdin: new TextEncoder().encode(project),
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`docker compose ${args.join(" ")} failed (exit ${code}).`);
    process.exit(code);
  }
}

if (command === "down") {
  await compose(["down", "--remove-orphans"]);
  process.exit(0);
}
if (command === "logs") {
  await compose(["logs", "-f"]);
  process.exit(0);
}

const { url } = readRedisUrl(process.env.REDIS_URL);
if (!process.env.CLUSTER_LINK_SECRET) {
  console.error("CLUSTER_LINK_SECRET is not set in .env.production. Set it to a long random value: cluster nodes do not start without it.");
  process.exit(1);
}

console.log(`Region ${regionId}: ${coordinatorCount} coordinator(s) and ${nodeCount} node(s) (CLUSTER_NODES, CLUSTER_COORDINATORS)`);
for (let i = 1; i <= nodeCount; i++) {
  console.log(`  node-${i}: game/WebTransport port ${baseGamePort + PORT_STEP * i}, internal port ${baseInternalPort + PORT_STEP * i}, ${linksOff ? "links off" : `link ${linkHost}:${baseLinkPort + PORT_STEP * i}`}`);
}

await compose(["build"]);

console.log("Stopping the single engine (docker-compose.prod.yml) and the old cluster...");
const single = Bun.spawn(["docker", "compose", "-f", path.join(root, "src", "docker", "docker-compose.prod.yml"), "down"], {
  cwd: root,
  stdio: ["ignore", "inherit", "inherit"],
});
if ((await single.exited) !== 0) {
  console.error("Could not stop the single engine (docker-compose.prod.yml).");
  process.exit(1);
}
await compose(["down", "--remove-orphans"]);

try {
  console.log(`Cleared ${await clearClusterState(url.href)} cells:* key(s) from Redis`);
} catch (error) {
  console.error(`Could not clear the cluster state from Redis: ${error}`);
  process.exit(1);
}

await compose(["up", "-d", "--force-recreate", "--remove-orphans"]);
