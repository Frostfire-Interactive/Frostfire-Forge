import log from "../modules/logger";
import layerManager from "../services/layermanager";
import player from "../systems/player.ts";
import playerCache from "../services/playermanager.ts";
import { getPlayerSpriteSheetData, getMountSpriteUrl } from "../modules/spriteSheetManager";
import { notifyLayerChanged, updatePlayerAOI, findPlayersWithTargetInAOI } from "./aoi";
import { forgetLook } from "./looks";
import { packetManager } from "./packet_manager";
import {
  bumpStateRevision, despawnBatchQueue, destinationLayerFor, getAnimationNameForDirection, resyncNpcChunks,
  sendAnimationTo, sendPacket, spawnBatchQueue, stateRevision, transitionPlayerToMap,
} from "./receiver";

export type SummonSpot = { map: string; x: number; y: number; direction: string };

/**
 * Moves `target` to `to`, across maps or within one. `by` is the admin who summoned it, or null when no admin
 * is involved (a summoning stone): the admin-only parts (seeing the target across maps, its spawn data, its
 * movement) are skipped then. Returns false when the move did not happen. It sends no messages: callers notify.
 */
export async function summonMove(target: any, to: SummonSpot, by: any | null): Promise<boolean> {
  if (target.location.map !== to.map) {
    const result = await player.setLocation(target.id, to.map, { x: to.x, y: to.y, direction: to.direction });
    if (
      !(
        result &&
        typeof result === "object" &&
        "affectedRows" in result &&
        ((result as { affectedRows: number | null; count?: number }).affectedRows ?? (result as { count?: number }).count) != 0
      )
    ) {
      return false;
    }
    if (by) {
      if (!by.forceVisibleTo) by.forceVisibleTo = new Set();
      by.forceVisibleTo.add(target.id);
    }

    playerCache.set(target.id, target);

    if (by) {
      setTimeout(() => {
        const admin = playerCache.get(by.id);
        if (admin?.forceVisibleTo) {
          admin.forceVisibleTo.delete(target.id);
          playerCache.set(admin.id, admin);
        }
      }, 5000);
    }

    await transitionPlayerToMap(
      target,
      to.map,
      { x: to.x, y: to.y, direction: to.direction },
      target.wt,
      spawnBatchQueue,
      despawnBatchQueue
    );
    return true;
  }

  target.location.position = { x: to.x, y: to.y, direction: to.direction };
  const summonedLayerId = destinationLayerFor(
    target,
    by?.aoi?.layerId,
    layerManager.updatePlayerBlock(target.id, target.location.position.x, target.location.position.y)
  );
  if (summonedLayerId) {
    layerManager.movePlayerToLayer(target.id, summonedLayerId);
    target.aoi.layerId = summonedLayerId;
    notifyLayerChanged(target.id);
    log.info(`[SUMMON] ${target.username} moved to layer ${summonedLayerId}`);
  }

  playerCache.set(target.id, target);

  await updatePlayerAOI(target, spawnBatchQueue, despawnBatchQueue);
  if (by) await updatePlayerAOI(by, spawnBatchQueue, despawnBatchQueue);
  await resyncNpcChunks(target, target.wt); // summoned within the map

  if (by) {
    const targetAnimationNameForSprite = getAnimationNameForDirection(
      target.location.position?.direction || "down",
      !!target.moving,
      !!target.mounted,
      target.mount_type,
      !!target.casting
    );
    const targetSpriteData = await getPlayerSpriteSheetData(targetAnimationNameForSprite, target.equipment || null);

    let targetSpritesData = null;
    if (targetSpriteData?.bodySprite || targetSpriteData?.headSprite) {
      targetSpritesData = {
        mountSprite: target.mounted && target.mount_type ? getMountSpriteUrl(target.mount_type) : null,
        bodySprite: targetSpriteData.bodySprite || null,
        headSprite: targetSpriteData.headSprite || null,
        armorHelmetSprite: targetSpriteData.armorHelmetSprite || null,
        armorShoulderguardsSprite: targetSpriteData.armorShoulderguardsSprite || null,
        armorNeckSprite: targetSpriteData.armorNeckSprite || null,
        armorHandsSprite: targetSpriteData.armorHandsSprite || null,
        armorChestSprite: targetSpriteData.armorChestSprite || null,
        armorFeetSprite: targetSpriteData.armorFeetSprite || null,
        armorLegsSprite: targetSpriteData.armorLegsSprite || null,
        armorWeaponSprite: targetSpriteData.armorWeaponSprite || null,
        animationState: targetSpriteData.animationState,
      };
    }

    const targetSpawnData = {
      id: target.id,
      userid: target.userid,
      location: {
        map: target.location.map,
        x: target.location.position.x,
        y: target.location.position.y,
        direction: target.location.position?.direction || "down",
        moving: target.moving || false,
      },
      username: target.username,
      isAdmin: target.isAdmin,
      isGuest: target.isGuest,
      isStealth: target.isStealth,
      isNoclip: target.isNoclip,
      stats: target.stats,
      animation: null,
      spriteData: targetSpritesData,
      mounted: target.mounted,
      guild: target.guild || [],
      guild_name: target.guild_name || null,
    };

    forgetLook(by.wt, String(target.id));
    sendPacket(by.wt, packetManager.loadPlayers({
      players: [targetSpawnData],
      snapshotRevision: stateRevision()
    }));

    const targetAnimationName = getAnimationNameForDirection(
      target.location.position?.direction || "down",
      !!target.moving,
      !!target.mounted,
      target.mount_type || undefined,
      !!target.casting
    );
    await sendAnimationTo(by.wt, targetAnimationName, target.id);
  }

  bumpStateRevision();

  const targetMovementData = {
    i: target.id,
    d: {
      x: Number(target.location.position.x),
      y: Number(target.location.position.y),
      dr: target.location.position.direction
    },
    r: stateRevision(),
    s: target.isStealth ? 1 : 0
  };
  sendPacket(target.wt, packetManager.moveXY(targetMovementData));

  if (by) sendPacket(by.wt, packetManager.moveXY(targetMovementData));

  for (const otherPlayer of findPlayersWithTargetInAOI(target.id)) {
    if (!otherPlayer.wt || otherPlayer.id === target.id || otherPlayer.id === by?.id) continue;

    const canSeeTarget = !target.isStealth || otherPlayer.isAdmin;
    if (canSeeTarget) {
      sendPacket(otherPlayer.wt, packetManager.moveXY(targetMovementData));
    }
  }
  return true;
}
