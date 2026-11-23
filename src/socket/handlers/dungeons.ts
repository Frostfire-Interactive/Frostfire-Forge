import { pickDungeonSize, portalPeek, portalPreview, portalPreviewFor } from "../dungeons";
import { packetManager } from "../packet_manager";
import { sendPacket } from "../receiver";
import type { PacketContext } from "./context";

export const handles: ReadonlySet<string> = new Set(["DUNGEON_SIZE_PICK", "DUNGEON_PORTAL_PREVIEW", "DUNGEON_PORTAL_PEEK"]);

export async function handle(ctx: PacketContext): Promise<unknown> {
  const { currentPlayer, type, data } = ctx;
  switch (type) {

      case "DUNGEON_SIZE_PICK": {
        if (!currentPlayer) return;
        await pickDungeonSize(currentPlayer, data);
        break;
      }
      // What a portal leads to, for the picture of it drawn inside the portal.
      case "DUNGEON_PORTAL_PREVIEW": {
        if (!currentPlayer) return;
        // A portal on the viewer's map, by name: what it shows depends on its kind and the viewer.
        if (typeof (data as any)?.portal === "string") {
          sendPacket(currentPlayer.wt, packetManager.dungeonPortalPreview(await portalPreviewFor(currentPlayer, (data as any).portal)));
          break;
        }
        const dungeonId = Number((data as any)?.dungeonId);
        sendPacket(currentPlayer.wt, packetManager.dungeonPortalPreview((await portalPreview(dungeonId)) ?? { dungeonId, map: null }));
        break;
      }
      // Start or stop the live feed of the players behind a portal.
      case "DUNGEON_PORTAL_PEEK": {
        if (!currentPlayer) return;
        portalPeek(currentPlayer, data);
        break;
      }
  }
}
