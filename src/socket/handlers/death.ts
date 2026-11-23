import * as resurrection from "../../systems/resurrection";
import log from "../../modules/logger";
import player from "../../systems/player.ts";
import playerCache from "../../services/playermanager.ts";
import spellEffects from "../../systems/spelleffects";
import { Events } from "../../systems/events";
import { listener } from "../../modules/event_bus";
import { packetManager } from "../packet_manager";
import { relayToMirrorViewers } from "../aoi";
import { GHOST_TELEPORT_DELAY_MS, REVIVE_OFFER_RADIUS, bumpStateRevision, filterPlayersByMap, findGraveyardSpawn, forceStopPlayerMovement, placePlayer, resyncNpcChunks, sendPacket, sendStatsToPartyMembers, stateRevision } from "../receiver";
import { isCopyKey } from "../../systems/dungeons/copykey";
import { releasePlan } from "../../systems/dungeons/rules";
import { copyEntrance, sendToPortal } from "../dungeons";
import type { PacketContext } from "./context";

// Packet handlers moved from receiver.ts's packetReceiver switch (phase 6, Task 1). The case bodies are unchanged.

export const handles: ReadonlySet<string> = new Set(["RELEASE_SPIRIT", "CONFIRM_REVIVE", "CONFIRM_GRAVEYARD_REVIVE"]);

export async function handle(ctx: PacketContext): Promise<unknown> {
  const { currentPlayer, type } = ctx;
  switch (type) {

      case "RELEASE_SPIRIT": {
        if (!currentPlayer) return;
        // Only a corpse awaiting release can release. Ghosts are already out.
        if (!currentPlayer.isDead || currentPlayer.isGhost || currentPlayer.ghostTeleportPending) return;

        if (isCopyKey(currentPlayer.location.map)) {
          const entrance = await copyEntrance(currentPlayer.location.map).catch((e: any) => {
            log.error(`Copy entrance for ${currentPlayer.username} could not be read: ${e?.message || e}`);
            return null;
          });
          const plan = releasePlan(currentPlayer.location.map, entrance);
          currentPlayer.ghostTeleportPending = true;
          try {
            // The revive below must happen: a release that failed before it would leave the corpse until the next one.
            await forceStopPlayerMovement(currentPlayer).catch((e: any) => {
              log.warn(`Movement of ${currentPlayer.username} could not be stopped on release: ${e?.message || e}`);
            });
            const synced = await player.synchronizeStats(currentPlayer.username).catch((e: any) => {
              log.warn(`Stats of ${currentPlayer.username} could not be read on release: ${e?.message || e}`);
              return null;
            });
            if (synced) currentPlayer.stats = synced;
            currentPlayer.stats.health = currentPlayer.stats.total_max_health;
            currentPlayer.stats.stamina = currentPlayer.stats.total_max_stamina;
            currentPlayer.slowPercent = 0;
            currentPlayer.slowMultiplier = 1;
            currentPlayer.stunnedUntil = 0;
            currentPlayer.isDead = false;
            currentPlayer.isGhost = false;
            currentPlayer.corpse = null;
            currentPlayer.reviveOffered = false;
            currentPlayer.ghostTeleportPending = false;
            playerCache.set(currentPlayer.id, currentPlayer);
            try {
              await player.setDeadState(currentPlayer.username, 0, null);
            } catch (e: any) {
              log.error(`Failed to clear death state for ${currentPlayer.username}: ${e?.message || e}`);
            }
            bumpStateRevision();
            const ghostPacket = packetManager.playerGhost({ id: currentPlayer.id, ghost: false });
            const revivePacket = packetManager.revive({ id: currentPlayer.id, target: currentPlayer.id, stats: currentPlayer.stats });
            filterPlayersByMap(currentPlayer.location.map).forEach((p) => {
              sendPacket(p.wt, ghostPacket);
              sendPacket(p.wt, revivePacket);
            });
            relayToMirrorViewers(currentPlayer, [...ghostPacket, ...revivePacket], false);
            spellEffects.broadcastEffectsUpdate(currentPlayer);
            sendStatsToPartyMembers(currentPlayer.username, currentPlayer.id, currentPlayer.stats);
            listener.emit(Events.PLAYER_REVIVED, { player: currentPlayer });
            if (plan.kind === "entrance") await placePlayer(currentPlayer, currentPlayer.location.map, plan.x, plan.y);
            else await sendToPortal(currentPlayer);
          } catch (e: any) {
            log.error(`Release in a copy for ${currentPlayer.username} failed: ${e?.message || e}`);
            if (!currentPlayer.isDead) await sendToPortal(currentPlayer).catch(() => {});
          } finally {
            currentPlayer.ghostTeleportPending = false;
          }
          break;
        }

        const spawn = findGraveyardSpawn(
          currentPlayer.location.map,
          currentPlayer.location.position.x,
          currentPlayer.location.position.y
        );
        currentPlayer.stats.health = 0;
        currentPlayer.stats.stamina = 0;
        currentPlayer.slowPercent = 0;
        currentPlayer.slowMultiplier = 1;
        currentPlayer.stunnedUntil = 0;
        currentPlayer.isDead = false;
        currentPlayer.isGhost = true;
        currentPlayer.reviveOffered = false;
        currentPlayer.ghostTeleportPending = true;
        await forceStopPlayerMovement(currentPlayer);
        currentPlayer.location.position = { x: spawn.x, y: spawn.y, direction: "down" };
        playerCache.set(currentPlayer.id, currentPlayer);
        try {
          await player.setDeadState(currentPlayer.username, 2, currentPlayer.corpse);
        } catch (e: any) {
          log.error(`Failed to persist ghost state for ${currentPlayer.username}: ${e?.message || e}`);
        }

        bumpStateRevision();
        const releaseMap = currentPlayer.location.map;
        const releaseId = currentPlayer.id;
        const releasePacket = packetManager.playerGhost({ id: releaseId, ghost: true, x: spawn.x, y: spawn.y, map: releaseMap, pendingTeleport: true });
        filterPlayersByMap(releaseMap).forEach((p) => {
          sendPacket(p.wt, releasePacket);
        });
        // Cluster mode: the viewers of the player's mirrors on neighbouring nodes see the release too.
        relayToMirrorViewers(currentPlayer, releasePacket, false);
        listener.emit(Events.PLAYER_GHOST_RELEASED, { player: currentPlayer });

        setTimeout(() => {
          const p = playerCache.get(releaseId);
          if (!p || !p.isGhost || !p.ghostTeleportPending) return;
          p.ghostTeleportPending = false;
          playerCache.set(p.id, p);
          void resyncNpcChunks(p, p.wt); // the graveyard's NPCs
          bumpStateRevision();
          const arrivalMove = packetManager.moveXY({
            i: p.id,
            d: { x: spawn.x, y: spawn.y, dr: "down" },
            r: stateRevision(),
            s: p.isStealth ? 1 : 0
          });
          // Ghost spawn signal: render from here, at the graveyard.
          const arrivalGhost = packetManager.playerGhost({ id: p.id, ghost: true, x: spawn.x, y: spawn.y, map: p.location.map });
          filterPlayersByMap(p.location.map).forEach((v) => {
            sendPacket(v.wt, arrivalMove);
            sendPacket(v.wt, arrivalGhost);
          });
          relayToMirrorViewers(p, [...arrivalMove, ...arrivalGhost], false);
        }, GHOST_TELEPORT_DELAY_MS);
        break;
      }

      case "CONFIRM_REVIVE": {
        if (!currentPlayer) return;
        const denyRevive = () => {
          currentPlayer.reviveOffered = false;
          if (currentPlayer.wt) {
            sendPacket(currentPlayer.wt, packetManager.reviveOffer({ revoked: true }));
          }
        };
        // Only a ghost standing at its own corpse can revive.
        if (!currentPlayer.isGhost) return;
        if (!currentPlayer.corpse) {
          denyRevive();
          return;
        }
        if (currentPlayer.corpse.map !== currentPlayer.location.map) {
          denyRevive();
          return;
        }
        const dx = currentPlayer.location.position.x - currentPlayer.corpse.x;
        const dy = currentPlayer.location.position.y - currentPlayer.corpse.y;
        if (dx * dx + dy * dy > REVIVE_OFFER_RADIUS * REVIVE_OFFER_RADIUS) {
          denyRevive();
          return;
        }

        currentPlayer.stats.health = Math.round(currentPlayer.stats.total_max_health * 0.5);
        currentPlayer.stats.stamina = Math.round(currentPlayer.stats.total_max_stamina * 0.5);
        currentPlayer.isDead = false;
        currentPlayer.isGhost = false;
        currentPlayer.corpse = null;
        currentPlayer.reviveOffered = false;
        playerCache.set(currentPlayer.id, currentPlayer);
        try {
          await player.setDeadState(currentPlayer.username, 0, null);
        } catch (e: any) {
          log.error(`Failed to clear death state for ${currentPlayer.username}: ${e?.message || e}`);
        }

        bumpStateRevision();
        const ghostPacket = packetManager.playerGhost({ id: currentPlayer.id, ghost: false });
        const revivePacket = packetManager.revive({ id: currentPlayer.id, target: currentPlayer.id, stats: currentPlayer.stats });
        const playersInMap = filterPlayersByMap(currentPlayer.location.map);
        playersInMap.forEach((p) => {
          sendPacket(p.wt, ghostPacket);
          sendPacket(p.wt, revivePacket);
        });
        relayToMirrorViewers(currentPlayer, [...ghostPacket, ...revivePacket], false);
        sendStatsToPartyMembers(currentPlayer.username, currentPlayer.id, currentPlayer.stats);
        listener.emit(Events.PLAYER_REVIVED, { player: currentPlayer });
        break;
      }

      case "CONFIRM_GRAVEYARD_REVIVE": {
        if (!currentPlayer) return;
        if (!currentPlayer.isGhost || currentPlayer.isDead) return;

        resurrection.applySickness(currentPlayer);
        const synced = await player.synchronizeStats(currentPlayer.username);
        if (synced) {
          currentPlayer.stats = synced;
        }
        currentPlayer.stats.health = Math.round(currentPlayer.stats.total_max_health * 0.5);
        currentPlayer.stats.stamina = Math.round(currentPlayer.stats.total_max_stamina * 0.5);
        currentPlayer.isDead = false;
        currentPlayer.isGhost = false;
        currentPlayer.corpse = null;
        currentPlayer.reviveOffered = false;
        currentPlayer.ghostTeleportPending = false;
        playerCache.set(currentPlayer.id, currentPlayer);
        try {
          await player.setDeadState(currentPlayer.username, 0, null);
        } catch (e: any) {
          log.error(`Failed to clear death state for ${currentPlayer.username}: ${e?.message || e}`);
        }

        bumpStateRevision();
        const ghostPacket = packetManager.playerGhost({ id: currentPlayer.id, ghost: false });
        const revivePacket = packetManager.revive({ id: currentPlayer.id, target: currentPlayer.id, stats: currentPlayer.stats });
        filterPlayersByMap(currentPlayer.location.map).forEach((p) => {
          sendPacket(p.wt, ghostPacket);
          sendPacket(p.wt, revivePacket);
        });
        relayToMirrorViewers(currentPlayer, [...ghostPacket, ...revivePacket], false);
        spellEffects.broadcastEffectsUpdate(currentPlayer);
        sendStatsToPartyMembers(currentPlayer.username, currentPlayer.id, currentPlayer.stats);
        sendPacket(
          currentPlayer.wt,
          packetManager.notify({ message: "You have been resurrected with Resurrection Sickness (15 min)." })
        );
        listener.emit(Events.PLAYER_REVIVED, { player: currentPlayer });
        break;
      }
  }
}
