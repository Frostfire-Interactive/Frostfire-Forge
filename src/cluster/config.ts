export function clusterEnabled(): boolean {
  return process.env.CLUSTER === "true";
}

/** This process's name in the cluster: NODE_ID, else the realm's SERVER_ID. */
export function nodeId(): string {
  return process.env.NODE_ID || process.env.SERVER_ID || "default";
}

/** The UDP port of this node's link listener: NODE_LINK_PORT, else the game port + 1. 0 turns links off. */
export function nodeLinkPort(gamePort: number): number {
  const raw = process.env.NODE_LINK_PORT;
  const text = raw?.trim() ?? "";
  // Digits only: Number() would also take "1e3", "0x10" and " 3 ".
  if (!/^\d+$/.test(text)) return gamePort + 1;
  const port = Number(text);
  return port <= 65535 ? port : gamePort + 1;
}

/** The host neighbours dial for links: NODE_LINK_HOST, else SERVER_HOST. "localhost" is dialled as 127.0.0.1 (QUIC over IPv4). */
export function nodeLinkHost(): string {
  const host = process.env.NODE_LINK_HOST || process.env.SERVER_HOST || "127.0.0.1";
  return host === "localhost" ? "127.0.0.1" : host;
}

export function nodeLinkBindHost(): string {
  return process.env.NODE_LINK_BIND_HOST?.trim() || "0.0.0.0";
}

/** Addresses that bind every interface. */
const EVERY_INTERFACE = new Set(["0.0.0.0", "::", "[::]"]);

export function nodeLinkBindWarning(host: string, port: number): string | null {
  if (!EVERY_INTERFACE.has(host)) return null;
  return `Node links listen on every interface (${host}). Set NODE_LINK_BIND_HOST to this node's private address, `
    + `or firewall UDP port ${port} so that only the other nodes can reach it.`;
}

export function nodeLinkBindError(): string | null {
  if (!clusterEnabled()) return null;
  if (process.env.NODE_LINK_PORT?.trim() === "0") return null;
  // Set on purpose (even to every interface, as in a container whose networks are private) is the operator's choice.
  if (process.env.NODE_LINK_BIND_HOST?.trim()) return null;
  return "Cluster mode needs NODE_LINK_BIND_HOST set (node links would listen on every interface, "
    + `${nodeLinkBindHost()}), aborting... Please set the NODE_LINK_BIND_HOST environment variable to suppress this message.`;
}

/** The password the cluster's example files ship with: a copied example must not run. */
const EXAMPLE_REDIS_PASSWORD = "change-me";

export function redisUrlProblem(url: string, redisPassword?: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Cluster mode needs REDIS_URL to be a valid redis:// or rediss:// URL, aborting... Please fix the REDIS_URL environment variable to suppress this message.";
  }
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    return "Cluster mode needs REDIS_URL to be a redis:// or rediss:// URL, aborting... Please fix the REDIS_URL environment variable to suppress this message.";
  }
  let password = parsed.password;
  try { password = decodeURIComponent(password); } catch {}
  if (password === EXAMPLE_REDIS_PASSWORD || redisPassword === EXAMPLE_REDIS_PASSWORD) {
    return "Cluster mode refuses the example Redis password from cluster.env.example (REDIS_URL or REDIS_PASSWORD), aborting... Please set a long random password in the REDIS_PASSWORD and REDIS_URL environment variables to suppress this message.";
  }
  if (!password && parsed.protocol !== "rediss:") {
    return "Cluster mode needs a password in REDIS_URL (redis://:password@host:port) or a rediss:// URL (the cluster's grants and snapshots live in Redis and are not signed), aborting... Please set the REDIS_URL environment variable to suppress this message.";
  }
  return null;
}

/** The region this node serves (US, EU, ...): the whole cluster shares it. */
export function regionId(): string {
  return process.env.REGION_ID || process.env.SERVER_ID || "default";
}
