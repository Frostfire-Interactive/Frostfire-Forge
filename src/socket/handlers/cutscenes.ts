import * as cutscenePlayer from "../../systems/cutsceneplayer";
import type { PacketContext } from "./context";

// The packets a player's client sends about the scene it is showing. The editor's packets are in editors.ts.

export const handles: ReadonlySet<string> = new Set(["CUTSCENE_STARTED", "CUTSCENE_END"]);

export async function handle(ctx: PacketContext): Promise<unknown> {
  const { currentPlayer, data, type } = ctx;
  switch (type) {

      case "CUTSCENE_STARTED": {
        // The client has begun the scene it was sent: the session's clock becomes the scene's length. A token that is
        // not the session's (a scene already over, or never sent) is ignored.
        if (!currentPlayer) return;
        cutscenePlayer.onStarted(currentPlayer, (data as any)?.token);
        break;
      }

      case "CUTSCENE_END": {
        // The scene ran its course or the player skipped it; whether a skip is taken is the session's to say.
        if (!currentPlayer) return;
        await cutscenePlayer.onEnd(currentPlayer, (data as any)?.token, (data as any)?.skipped === true);
        break;
      }
  }
}
