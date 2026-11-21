import { regionId, nodeId } from "./config";
import { clusterNodes } from "./index";
import { clearOnStart } from "./startclear";

export function clearShared(clear: () => Promise<void>): Promise<boolean> {
  return clearOnStart(clear, clusterNodes(), nodeId(), regionId());
}
