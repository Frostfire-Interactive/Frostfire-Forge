import log from "../../modules/logger";
import player from "../../systems/player.ts";
import { fencedSaves } from "../../cluster/ownerepoch";
import { playerHandoff } from "../../cluster/handoff";
import { Events } from "../../systems/events";
import { listener } from "../../modules/event_bus";
import { packetManager } from "../packet_manager";
import { ticketAllows } from "../ticket";
import { gapInputOf, newerGap } from "../arrival";
import { authWorker, authentication_queue, authentication_session_queue, loginPrefetch, pendingAuthentications, releaseDraggedBy, sendPacket } from "../receiver";
import type { PacketContext } from "./context";
import { creatureRadiusFor } from "../../systems/creatures/viewradius";
import AOI_CONFIG from "../../config/aoi.json";

// Packet handlers moved from receiver.ts's packetReceiver switch (phase 6, Task 1). The case bodies are unchanged.

export const handles: ReadonlySet<string> = new Set(["BENCHMARK", "PING", "PONG", "LOGIN", "AUTH", "LOGOUT", "DISCONNECT", "CLIENTCONFIG", "VIEW_SIZE"]);

export async function handle(ctx: PacketContext): Promise<unknown> {
  const { currentPlayer, data, parsedMessage, type, wt } = ctx;
  switch (type) {

      case "BENCHMARK": {
        (data as any)["returned_timestamp"] = Date.now();
        sendPacket(wt, packetManager.benchmark(data));
        break;
      }

      case "PING": {
        sendPacket(wt, packetManager.ping(data));
        break;
      }

      case "PONG": {
        sendPacket(wt, packetManager.pong(data));
        break;
      }

      case "LOGIN": {
        sendPacket(wt, packetManager.login(wt));
        break;
      }

      case "AUTH": {
        const token = data?.toString() as string;

        if (!token) {
          sendPacket(wt, packetManager.loginFailed());
          wt.close(1008, "Invalid token");
          break;
        }

        // A handoff arrival's mark; any other connection has no arrival under its ticket and is ignored.
        playerHandoff.landed(String(wt.data?.ticketToken ?? ""), "auth_rx");

        const authGap = gapInputOf(parsedMessage?.gap);
        wt.data.gapUpdate = newerGap(wt.data.gapUpdate, authGap ? { seq: 0, input: authGap } : null) ?? undefined;

        if (!ticketAllows(wt.data?.ticketAccount, token)) {
          log.debug(`Login refused on connection ${wt.data?.id}: the token is not the one its ticket was issued for`);
          sendPacket(wt, packetManager.loginFailed());
          wt.close(1008, "Invalid token");
          break;
        }

        const ticketSpend = wt.data?.ticketSpent ? await wt.data.ticketSpent : null;
        if (ticketSpend !== null && ticketSpend !== "spent") {
          const unchecked = ticketSpend === "unknown";
          log.debug(`Login refused on connection ${wt.data?.id}: its node ticket ${unchecked ? "could not be checked" : "was already used"}`);
          sendPacket(wt, packetManager.loginFailed());
          wt.close(1008, unchecked ? "Ticket could not be checked" : "Ticket already used");
          break;
        }

        if (authentication_queue.has(token)) {
          sendPacket(wt, packetManager.loginFailed());
          wt.close(1008, "Authentication already in progress");
          break;
        }

        if (authentication_session_queue.has(wt.data.id)) {
          sendPacket(wt, packetManager.loginFailed());
          wt.close(1008, "Session authentication already in progress");
          break;
        }

        authentication_queue.add(token);
        authentication_session_queue.add(wt.data.id);

        // A player arriving by handoff whose rows were read already (loginprefetch.ts): the worker only checks the token.
        const prefetched = loginPrefetch.take(String(wt.data?.ticketToken ?? ""));
        pendingAuthentications.set(wt.data.id, { wt, token, language: parsedMessage?.language || "en", prefetched: prefetched?.data });

        const arriving = playerHandoff.arrivingCharacter(String(wt.data?.ticketToken ?? ""));
        authWorker.postMessage({ token, id: wt.data.id, known: prefetched?.characterId, characterId: arriving?.characterId });

        break;
      }


      case "LOGOUT": {
        if (!currentPlayer) return;
        if (fencedSaves(currentPlayer)) {
          void player.saveFenced(currentPlayer, currentPlayer.ownerEpoch, null, currentPlayer.location)
            .catch((error) => log.error(`Fenced save of ${currentPlayer.username} failed: ${error}`));
        } else {
          player.setLocation(
            currentPlayer.id,
            currentPlayer.location.map,
            currentPlayer.location.position,
            currentPlayer
          );
        }
        player.logout(currentPlayer.id);
        listener.emit(Events.PLAYER_LOGOUT, { player: currentPlayer });
        if (wt.readyState === 1) {
          wt.close(1000, "Player logout");
        }
        break;
      }

      case "DISCONNECT": {
        if (!currentPlayer) return;
        if (fencedSaves(currentPlayer)) {
          void player.saveFenced(currentPlayer, currentPlayer.ownerEpoch, null, currentPlayer.location)
            .catch((error) => log.error(`Fenced save of ${currentPlayer.username} failed: ${error}`));
        } else {
          player.setLocation(
            currentPlayer.id,
            currentPlayer.location.map,
            currentPlayer.location.position,
            currentPlayer
          );
        }
        player.clearSessionId(currentPlayer.id);

        // If this admin was dragging any players, release them
        releaseDraggedBy(currentPlayer.id);

        break;
      }

      case "CLIENTCONFIG": {
        if (!currentPlayer) return;
        await player.setConfig(wt.data.id, data);
        break;
      }

      // The client's view, in world pixels: creatures are sent far enough out to cover it. Kept on the connection, as
      // each connection (a handoff's too) sends it after its login.
      case "VIEW_SIZE": {
        if (!wt?.data) return;
        wt.data.creatureRadius = creatureRadiusFor(data, AOI_CONFIG.DEFAULT_RADIUS) ?? undefined;
        break;
      }
  }
}
