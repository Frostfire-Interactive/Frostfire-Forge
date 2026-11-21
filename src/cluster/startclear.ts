import log from "../modules/logger";
import { clusterEnabled } from "./config";
import type { NodeRegistry } from "./nodes";

export async function clearOnStart(
  clear: () => Promise<void>,
  nodes: NodeRegistry | null,
  self: string,
  region: string
): Promise<boolean> {
  if (!clusterEnabled()) {
    await clear();
    return true;
  }
  let others: string[];
  try {
    if (!nodes) throw new Error("the node registry is not started");
    others = (await nodes.live()).filter((n) => n.nodeId !== self && n.regionId === region).map((n) => n.nodeId);
  } catch (error) {
    log.warn(`The shared state was not cleared at start, as the live nodes could not be read: ${error}`);
    return false;
  }
  if (others.length > 0) {
    log.info(`The shared state was not cleared at start: ${others.join(", ")} of region ${region} ${others.length === 1 ? "is" : "are"} alive`);
    return false;
  }
  await clear();
  return true;
}
