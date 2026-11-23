import AOI_CONFIG from "../../config/aoi.json";
import { overriddenSpeed } from "../../systems/speedoverride";
import { slideStep } from "../../systems/stepslide";
import gameLoop from "../../services/gameloop";
import layerManager from "../../services/layermanager";
import log from "../../modules/logger";
import { ghosts } from "../../cluster/ghosts";
import { playerHandoff } from "../../cluster/handoff";
import player from "../../systems/player.ts";
import spatialGrid from "../../services/spatialgrid";
import spellEffects from "../../systems/spelleffects";
import { Events } from "../../systems/events";
import { TICK_MS, cadenceDue, scaledStep } from "../../services/tickrate";
import { listener } from "../../modules/event_bus";
import { packetManager } from "../packet_manager";
import { syncNpcChunks, preloadNpcsAt } from "../../systems/npcStreaming";
import { updatePlayerAOI, shouldUpdateAOI, broadcastToAOI, handleMapChangeAOI } from "../aoi";
import packetReceiver from "../receiver";
import { PROFILE, VALID_DIRECTIONS, WARP_SCAN_MS, applyLateGap, bumpStateRevision, checkGhostReviveProximity, despawnBatchQueue, forceStopPlayerMovement, getDirectionOffsets, getInventorySlots, interruptPlayerCast, isInteriorMap, mapPropertiesCache, maps, movementBatchQueue, prof, queueFinalMovement, resyncNpcChunks, sendPacket, sendPositionAnimation, spawnBatchQueue, stateRevision, subscriptionLocked, transitionPlayerToMap, warpInterceptors } from "../receiver";
import { gapUpdateOf, newerGap, recoverResumedWalk, resumeCatchUpSteps } from "../arrival";
import { dungeonPortalStep, dungeonPortalWalk, portalsOn, stonesOn } from "../dungeons";
import { archBlocksStep, archesOf } from "../../systems/portalarch";
import { stoneBlocksStep, stonesAt } from "../../systems/stoneblock";
import lootChest from "../../systems/lootChest";
import { chestBlocksStep } from "../../systems/chestblock";
import type { PacketContext } from "./context";
import { WARP_COOLDOWN_MS, setWarpReadyIn, warpWait } from "../../systems/warpcooldown";

const withoutJson = (map: unknown): string => String(map ?? "").replace(/\.json$/, "");

// Packet handlers moved from receiver.ts's packetReceiver switch (phase 6, Task 1). The case bodies are unchanged.

export const handles: ReadonlySet<string> = new Set(["MOVEXY", "TELEPORTXY", "MOUNT", "HANDOFF_GAP"]);

// px per 30 Hz tick (180 px a second); scaledStep keeps that speed at any TICK_RATE.
const BASE_SPEED = 6;
const MOUNT_SPEED_MULTIPLIER = 1.35;
const PLAYER_WIDTH = 24;
const PLAYER_HEIGHT = 40;

/** The px a 30 Hz tick of walking takes the player: more mounted or as a ghost, less when slowed. */
function walkSpeedOf(currentPlayer: any): number {
  // An admin's /speed: their whole speed, in place of mount, ghost and slows
  const override = overriddenSpeed(currentPlayer, BASE_SPEED);
  if (override !== null) return override;
  return (currentPlayer.mounted || currentPlayer.isGhost ? BASE_SPEED * MOUNT_SPEED_MULTIPLIER : BASE_SPEED) * (currentPlayer.slowMultiplier || 1);
}

function takeStep(currentPlayer: any, direction: string, stepX: number, stepY: number) {
  const tempPosition = { ...currentPlayer.location.position };

  let moveX = scaledStep(stepX, currentPlayer._stepCarry?.x ?? 0);
  let moveY = scaledStep(stepY, currentPlayer._stepCarry?.y ?? 0);
  tempPosition.x = tempPosition.x + moveX.move;
  tempPosition.y = tempPosition.y + moveY.move;

  // Round for collision detection only
  const _profCollStart = PROFILE ? performance.now() : 0;
  const startX = currentPlayer.location.position.x;
  const startY = currentPlayer.location.position.y;
  const bareMap = String(currentPlayer.location.map).replace(".json", "");
  const chestsHere = [...lootChest.getOnMap(bareMap), ...lootChest.getOnMap(`${bareMap}.json`)];
  const archesHere = archesOf(portalsOn(bareMap) ?? []);
  const stonesHere = stonesAt(stonesOn(bareMap) ?? []);
  const checkTiles = (x: number, y: number) => player.checkCollisionSync(
    currentPlayer.location.map,
    {
      x: Math.round(x),
      y: Math.round(y),
      direction,
    },
    {
      width: PLAYER_WIDTH,
      height: PLAYER_HEIGHT,
    }
  );
  // Chests, the arches portals stand in and summoning stones are solid, and block as a wall tile does so the step slides along them.
  const checkAt = (x: number, y: number) => {
    const tiles = checkTiles(x, y);
    if (tiles.value || (chestsHere.length === 0 && archesHere.length === 0 && stonesHere.length === 0)) return tiles;
    const to = { x: Math.round(x), y: Math.round(y) };
    if (chestBlocksStep(chestsHere, { x: startX, y: startY }, to)) return { value: true, reason: "tile_collision" as const };
    if (stoneBlocksStep(stonesHere, { x: startX, y: startY }, to)) return { value: true, reason: "tile_collision" as const };
    return archBlocksStep(archesHere, { x: startX, y: startY }, to) ? { value: true, reason: "tile_collision" as const } : tiles;
  };
  const stepped = slideStep({ x: startX, y: startY }, tempPosition, stepX, stepY, !!currentPlayer.isNoclip, checkAt);
  tempPosition.x = stepped.x;
  tempPosition.y = stepped.y;
  const collision: any = stepped.collision;
  // The blocked axis carries nothing on.
  if (stepped.dropped === "y") moveY = { move: 0, carry: 0 };
  else if (stepped.dropped === "x") moveX = { move: 0, carry: 0 };
  if (PROFILE) prof.collisionMs += performance.now() - _profCollStart;

  const isColliding = collision?.value === true;

  if (PROFILE && isColliding && !currentPlayer.isNoclip) {
    prof.collisionBlocks++;
    prof.collisionReasons[collision?.reason || "unknown"] =
      (prof.collisionReasons[collision?.reason || "unknown"] || 0) + 1;
  }

  if (!isColliding || currentPlayer.isNoclip) {
    currentPlayer.location.position.x = Math.round(tempPosition.x);
    currentPlayer.location.position.y = Math.round(tempPosition.y);
    // A handoff reads how long the walk has stood since (arrival.ts walkIdleMsOf).
    currentPlayer._lastStepAt = performance.now();
    ghosts.touch("player", currentPlayer.id);
    currentPlayer._stepCarry = { x: moveX.carry, y: moveY.carry };
    checkGhostReviveProximity(currentPlayer);
  }

  return { collision, isColliding };
}

/** Replays steps the client walked: whether the player moved, and the points walked through from where the replay starts. */
export async function replayGapSteps(currentPlayer: any, steps: readonly string[], from?: { x: number; y: number; direction: string }): Promise<{ moved: boolean; path: Array<{ x: number; y: number }> }> {
  if (steps.length === 0 && !from) return { moved: false, path: [] };
  await player.preloadMapCollision(currentPlayer.location.map);
  const directionOffsets = getDirectionOffsets(walkSpeedOf(currentPlayer));
  const fromX = currentPlayer.location.position.x;
  const fromY = currentPlayer.location.position.y;
  if (from) {
    currentPlayer.location.position.x = from.x;
    currentPlayer.location.position.y = from.y;
    currentPlayer.location.position.direction = from.direction;
  }
  const path = [{ x: currentPlayer.location.position.x, y: currentPlayer.location.position.y }];
  let last = "";
  for (const direction of steps) {
    const offset = directionOffsets[direction];
    if (!offset) continue;
    // A new direction starts its own sub-px carry, as a MOVEXY's does.
    if (direction !== last) currentPlayer._stepCarry = undefined;
    last = direction;
    takeStep(currentPlayer, direction, offset.dx, offset.dy);
    path.push({ x: currentPlayer.location.position.x, y: currentPlayer.location.position.y });
  }
  if (last && !(currentPlayer.casting && !currentPlayer.castOnSelf)) currentPlayer.location.position.direction = last;
  const moved = currentPlayer.location.position.x !== fromX || currentPlayer.location.position.y !== fromY;
  if (moved && AOI_CONFIG.USE_SPATIAL_GRID && spatialGrid.hasPlayer(currentPlayer.id)) {
    spatialGrid.updatePlayer(
      currentPlayer.id,
      Number(currentPlayer.location.position.x),
      Number(currentPlayer.location.position.y),
      String(currentPlayer.location.map).replaceAll(".json", "")
    );
  }
  return { moved, path };
}

/** The player's own position, echoed to them as a step's is (the binary moveXY), and to no one else. */
function echoSelf(wt: any, currentPlayer: any): void {
  if (!wt || wt.readyState !== 1) return;
  sendPacket(wt, packetManager.moveXY({
    i: wt.data.id,
    d: {
      x: Number(currentPlayer.location.position.x),
      y: Number(currentPlayer.location.position.y),
      dr: currentPlayer.location.position.direction,
    },
    r: stateRevision(),
    s: currentPlayer.isStealth ? 1 : 0,
  }));
}

export async function handle(ctx: PacketContext): Promise<unknown> {
  const { currentPlayer, data, server, type, wt } = ctx;
  switch (type) {

      case "HANDOFF_GAP": {
        const update = gapUpdateOf(data);
        if (!update) return;
        if (wt.data?.gapApplied) return applyLateGap(wt, update);
        wt.data.gapUpdate = newerGap(wt.data.gapUpdate, update) ?? undefined;
        return;
      }

      case "MOVEXY": {
        if (!currentPlayer) return;

        const moveSeq = ++currentPlayer._moveSeq;

        await player.preloadMapCollision(currentPlayer.location.map);

        const direction = data.toString().toLowerCase();

        // The first move of a player who came by a handoff: the new node says how long taking them in took.
        if (wt.data?.handoffLanding && direction !== "abort") {
          wt.data.handoffLanding = false;
          playerHandoff.firstMove(String(wt.data.ticketToken ?? ""));
        }

        // The first MOVEXY of a resumed handoff walk takes what it makes up (receiver.ts); any other drops it.
        const resumeCatchUp = wt.data?.resumeCatchUp;
        if (resumeCatchUp) wt.data.resumeCatchUp = undefined;
        const missed = resumeCatchUp && direction !== resumeCatchUp.walk
          ? resumeCatchUpSteps(resumeCatchUp, resumeCatchUp.walk, Date.now(), TICK_MS) + 1
          : 0;
        if (missed > 0 && !currentPlayer.isDead && !currentPlayer.ghostTeleportPending && !(currentPlayer.stunnedUntil > Date.now())) {
          const replay = await replayGapSteps(currentPlayer, Array(missed).fill(resumeCatchUp.walk));
          // A catch-up that walked into a dungeon portal took it: this move is not walked on the old map.
          if (await dungeonPortalWalk(currentPlayer, replay.path)) return;
        }

        if (direction === "abort") {
          // The key was let go: the next warp walked into is meant (see _warpHold below).
          currentPlayer._warpHold = undefined;
          await forceStopPlayerMovement(currentPlayer);
          if (missed > 0) echoSelf(wt, currentPlayer);
          return;
        }

        if (currentPlayer.isDead || currentPlayer.ghostTeleportPending) {
          await forceStopPlayerMovement(currentPlayer);
          return;
        }

        if (currentPlayer._moveSeq !== moveSeq) {
          return;
        }

        if (currentPlayer.casting && currentPlayer.interruptableSpell) {
          await interruptPlayerCast(currentPlayer);
        }

        if (!VALID_DIRECTIONS.has(direction)) return;

        // Turning is new input too: a warp may take the player again.
        if (currentPlayer._warpHold && currentPlayer._warpHold !== direction) currentPlayer._warpHold = undefined;

        if (currentPlayer.stunnedUntil && currentPlayer.stunnedUntil > Date.now()) {
          return;
        }

        const facing = currentPlayer.casting && !currentPlayer.castOnSelf
          ? currentPlayer.location.position.direction || direction
          : direction;
        currentPlayer.location.position.direction = facing || "down";
        currentPlayer.moving = true;
        ghosts.touch("player", currentPlayer.id);

        // Track direction changes for smooth transitions
        if (!currentPlayer._movementState) {
          currentPlayer._movementState = {
            currentDirection: direction,
            targetDirection: direction,
            directionChangeTime: 0,
          };
        } else {
          // A new direction starts its own sub-px carry (scaledStep): the old one's would push the first step off.
          if (currentPlayer._movementState.targetDirection !== direction) currentPlayer._stepCarry = undefined;
          currentPlayer._movementState.targetDirection = direction;
          currentPlayer._movementState.directionChangeTime = Date.now();
        }

        bumpStateRevision();
        await sendPositionAnimation(
          wt,
          currentPlayer.location.position.direction,
          true,
          currentPlayer.mounted,
          currentPlayer.mount_type || "unicorn",
          undefined,
          stateRevision(),
          currentPlayer.casting || false
        );

        const wasAlreadyMoving = gameLoop.isPlayerMoving(currentPlayer.id);

        // The steps of a resumed handoff walk's catch-up but the last are taken without the self-echo (below).
        let muteEcho = false;
        const movePlayer = async () => {

          if (!wt || wt.readyState !== 1) {
            gameLoop.unregisterMovingPlayer(currentPlayer.id);
            return;
          }

          if (currentPlayer._moveSeq !== moveSeq) {
            await forceStopPlayerMovement(currentPlayer);
            return;
          }

          if (spellEffects.isStunned(currentPlayer)) {
            await forceStopPlayerMovement(currentPlayer);
            return;
          }

          const directionOffsets = getDirectionOffsets(walkSpeedOf(currentPlayer));

          // This tick's offset, as a 30 Hz tick takes it (scaledStep below makes it this tick's move).
          let stepX = 0;
          let stepY = 0;

          // Handle direction transitions smoothly
          let activeDirection = direction;
          if (currentPlayer._movementState) {
            const timeSinceDirectionChange = Date.now() - currentPlayer._movementState.directionChangeTime;
            const DIRECTION_TRANSITION_TIME = 50; // ms to blend direction changes

            if (timeSinceDirectionChange < DIRECTION_TRANSITION_TIME &&
                currentPlayer._movementState.currentDirection !== currentPlayer._movementState.targetDirection) {
              // During transition: blend between old and new direction
              const transitionProgress = Math.min(1, timeSinceDirectionChange / DIRECTION_TRANSITION_TIME);

              const oldOffset = directionOffsets[currentPlayer._movementState.currentDirection] || directionOffsets.down;
              const newOffset = directionOffsets[currentPlayer._movementState.targetDirection] || directionOffsets.down;

              // Smoothly interpolate between old and new direction offsets
              const blendedOffset = {
                dx: oldOffset.dx + (newOffset.dx - oldOffset.dx) * transitionProgress,
                dy: oldOffset.dy + (newOffset.dy - oldOffset.dy) * transitionProgress,
              };

              stepX = blendedOffset.dx;
              stepY = blendedOffset.dy;
            } else {
              // Direction transition complete, use target direction
              if (currentPlayer._movementState.currentDirection !== currentPlayer._movementState.targetDirection) {
                currentPlayer._movementState.currentDirection = currentPlayer._movementState.targetDirection;
              }
              activeDirection = currentPlayer._movementState.currentDirection;
              const offset = directionOffsets[activeDirection];
              if (offset) {
                stepX = offset.dx;
                stepY = offset.dy;
              }
            }
          } else {
            const offset = directionOffsets[direction];
            if (offset) {
              stepX = offset.dx;
              stepY = offset.dy;
            }
          }

          const before = { x: Number(currentPlayer.location.position.x), y: Number(currentPlayer.location.position.y) };
          const { collision, isColliding } = takeStep(currentPlayer, direction, stepX, stepY);

          if (isColliding && !currentPlayer.isNoclip) {
            queueFinalMovement(currentPlayer);
            gameLoop.unregisterMovingPlayer(currentPlayer.id);
            currentPlayer.moving = false;
            ghosts.touch("player", currentPlayer.id);
            // Clean up movement state on collision
            if (currentPlayer._movementState) {
              currentPlayer._movementState = undefined;
            }
            currentPlayer._stepCarry = undefined;

            bumpStateRevision();
            await sendPositionAnimation(
              wt,
              currentPlayer.location.position.direction || direction,
              false,
              currentPlayer.mounted,
              currentPlayer.mount_type || "unicorn",
              undefined,
              stateRevision(),
              currentPlayer.casting || false
            );

            const reason = collision?.reason;

            if (reason === "tile_collision" && collision?.tile) {
              sendPacket(wt, packetManager.collisionDebug({
                tileX: collision.tile.x,
                tileY: collision.tile.y
              }));
            }

            if (reason === "warp_collision" && collision?.warp) {
              // Corpses and ghosts cannot use warps.
              if (currentPlayer.isDead || currentPlayer.isGhost) {
                return;
              }
              // Players in combat cannot use warps (admin summons bypass this path entirely)
              if (currentPlayer.pvp) {
                const nowTs = performance.now();
                if (!currentPlayer.lastCombatWarpNotify || nowTs - currentPlayer.lastCombatWarpNotify > 2000) {
                  currentPlayer.lastCombatWarpNotify = nowTs;
            sendPacket(
              wt,
              packetManager.inventory(currentPlayer.inventory, await getInventorySlots(currentPlayer))
            );
                }
                return;
              }
              const warp = collision.warp as {
                map: string;
                x: number;
                y: number;
              };

              if (currentPlayer._warpHold === direction) {
                return;
              }

              // A warp to another map waits out the warp cooldown (systems/warpcooldown.ts), as dungeon portals do.
              const otherMap = withoutJson(warp.map) !== withoutJson(currentPlayer.location.map);
              if (otherMap) {
                const waiting = warpWait(currentPlayer);
                if (waiting.wait) {
                  if (waiting.notice) sendPacket(wt, packetManager.notify({ message: waiting.notice }));
                  return;
                }
              }

              for (const interceptor of warpInterceptors) {
                if (await interceptor(warp, wt, currentPlayer, sendPacket)) {
                  return;
                }
              }

              currentPlayer._warpHold = direction;

              const currentMap = currentPlayer.location.map;

              const arrived = await player.arriveAt(
                currentPlayer.id,
                warp.map.replace(".json", ""),
                {
                  x: warp.x || 0,
                  y: warp.y || 0,
                  direction: currentPlayer.location.position?.direction || "down",
                }
              );

              if (arrived) {
                // Before the move: a move to a map on another node takes the cooldown along.
                if (otherMap) setWarpReadyIn(currentPlayer.username, WARP_COOLDOWN_MS);
                const newMap = warp.map.replace(".json", "");
                const newPosition = {
                  x: warp.x || 0,
                  y: warp.y || 0
                };

                if (currentMap !== warp.map) {
                  await transitionPlayerToMap(currentPlayer, newMap, newPosition, wt, spawnBatchQueue, despawnBatchQueue);
                } else {
                  await handleMapChangeAOI(currentPlayer, newMap, newPosition, spawnBatchQueue, despawnBatchQueue);

                  currentPlayer.location.position.direction = currentPlayer.location.position?.direction || "down";

                  bumpStateRevision();

                  const movementData = {
                    i: wt.data.id,
                    d: {
                      x: Number(currentPlayer.location.position.x),
                      y: Number(currentPlayer.location.position.y),
                      dr: currentPlayer.location.position.direction
                    },
                    r: stateRevision(),
                    s: currentPlayer.isStealth ? 1 : 0
                  };
                  sendPacket(wt, packetManager.moveXY(movementData));
                }
              }
            }

            return;
          }

          bumpStateRevision();

          if (await dungeonPortalStep(currentPlayer, before, currentPlayer.location.position, wt)) {
            gameLoop.unregisterMovingPlayer(currentPlayer.id);
            currentPlayer.moving = false;
            currentPlayer._movementState = undefined;
            return;
          }

          const warpScanNow = performance.now();
          if (currentPlayer._warpScanAt === undefined) currentPlayer._warpScanAt = warpScanNow;
          const shouldScanWarps = cadenceDue(warpScanNow - currentPlayer._warpScanAt, WARP_SCAN_MS, TICK_MS);
          if (shouldScanWarps) currentPlayer._warpScanAt = warpScanNow;

          const mapNameWithJson = shouldScanWarps
            ? (currentPlayer.location.map.endsWith('.json')
              ? currentPlayer.location.map
              : `${currentPlayer.location.map}.json`)
            : null;
          const playerMapProperties = shouldScanWarps
            ? mapPropertiesCache.find((m: any) => m.name === mapNameWithJson)
            : null;
          if (playerMapProperties?.warps && Array.isArray(playerMapProperties.warps)) {
            const WARP_PRELOAD_DISTANCE = 100; // pixels
            const now = performance.now();
            const preloadedDestinations = new Set<string>();

            const warpPreloadDistanceSq = WARP_PRELOAD_DISTANCE * WARP_PRELOAD_DISTANCE;

            for (const warp of playerMapProperties.warps) {
              const warpX = warp.position?.x || warp.x;
              const warpY = warp.position?.y || warp.y;
              const warpDx = currentPlayer.location.position.x - warpX;
              const warpDy = currentPlayer.location.position.y - warpY;
              const distanceSq = warpDx * warpDx + warpDy * warpDy;

              if (distanceSq < warpPreloadDistanceSq) {
                const destMapName = warp.map.replace(".json", "");

                if (!currentPlayer._warpPreloadTimes) {
                  currentPlayer._warpPreloadTimes = {};
                }

                // Skip if already preloaded
                if (currentPlayer._warpPreloadTimes[destMapName]) {
                  continue;
                }

                // Skip if already preloaded in this movement frame
                if (preloadedDestinations.has(destMapName)) {
                  continue;
                }

                // Mark as preloaded immediately to prevent re-preloading
                currentPlayer._warpPreloadTimes[destMapName] = now;
                preloadedDestinations.add(destMapName);

                try {
                  // Find the destination map
                  const destMap = maps.find((m: MapData) =>
                    m.name === (warp.map.endsWith('.json') ? warp.map : `${warp.map}.json`)
                  );

                  if (destMap) {
                    // Calculate chunks around the warp destination
                    const tilewidth = destMap.data?.tilewidth || 32;
                    const tileheight = destMap.data?.tileheight || 32;
                    const CHUNK_SIZE_CONFIG: { [key: number]: number } = {
                      16: 64,
                      32: 32,
                      64: 16,
                    };
                    const CHUNK_SIZE = CHUNK_SIZE_CONFIG[tilewidth] || 32;
                    const chunkPixelSize = CHUNK_SIZE * tilewidth;

                    const chunksX = Math.ceil((destMap.data?.width || 0) / CHUNK_SIZE);
                    const chunksY = Math.ceil((destMap.data?.height || 0) / CHUNK_SIZE);

                    // Clamp warp position to valid chunk range
                    let spawnChunkX = Math.floor(warpX / chunkPixelSize);
                    let spawnChunkY = Math.floor(warpY / chunkPixelSize);
                    spawnChunkX = Math.max(0, Math.min(spawnChunkX, Math.max(0, chunksX - 1)));
                    spawnChunkY = Math.max(0, Math.min(spawnChunkY, Math.max(0, chunksY - 1)));

                    const viewportWidth = 1920; // Standard viewport
                    const viewportHeight = 1080;
                    const padding = chunkPixelSize;

                    const chunksNeededX = Math.ceil(
                      (viewportWidth + padding * 2) / chunkPixelSize / 2
                    );
                    const chunksNeededY = Math.ceil(
                      (viewportHeight + padding * 2) / chunkPixelSize / 2
                    );

                    const chunksToPreload: Array<{ x: number; y: number; data?: any }> = [];
                    for (let dy = -chunksNeededY; dy <= chunksNeededY; dy++) {
                      for (let dx = -chunksNeededX; dx <= chunksNeededX; dx++) {
                        const chunkX = spawnChunkX + dx;
                        const chunkY = spawnChunkY + dy;
                        if (chunkX >= 0 && chunkY >= 0 && chunkX < chunksX && chunkY < chunksY) {
                          chunksToPreload.push({ x: chunkX, y: chunkY });
                        }
                      }
                    }

                    // and the NPCs round the arrival point (warp.x / warp.y), held by the client for that map
                    if (Number.isFinite(Number(warp.x)) && Number.isFinite(Number(warp.y))) {
                      const npcPreload = await preloadNpcsAt(currentPlayer, destMapName, Number(warp.x), Number(warp.y));
                      if (npcPreload.length) sendPacket(wt, npcPreload);
                    }

                    if (chunksToPreload.length > 0) {
                      sendPacket(
                        wt,
                        packetManager.preloadMapChunks({
                          mapName: destMapName,
                          chunks: chunksToPreload,
                          tilewidth: tilewidth,
                          tileheight: tileheight,
                          chunkSize: CHUNK_SIZE,
                          width: destMap.data?.width || 0,
                          height: destMap.data?.height || 0,
                          tilesets: destMap.data?.tilesets || [],
                        })
                      );
                    }
                  }
                } catch (err) {
                  log.warn(`Failed to preload warp chunks: ${err}`);
                }
              }
            }
          }

          // NPCs follow the map chunks round the player (npcStreaming); only does work when the player's chunk changed
          if (shouldScanWarps) {
            const npcPackets = await syncNpcChunks(currentPlayer);
            if (npcPackets.length) sendPacket(wt, npcPackets);
          }

          if (AOI_CONFIG.USE_SPATIAL_GRID && spatialGrid.hasPlayer(currentPlayer.id)) {
            spatialGrid.updatePlayer(
              currentPlayer.id,
              Number(currentPlayer.location.position.x),
              Number(currentPlayer.location.position.y),
              String(currentPlayer.location.map).replaceAll(".json", "")
            );
          }

          // Every AOI_UPDATE_MS of walking (10 ticks at 30 Hz), whatever the TICK_RATE.
          if (gameLoop.isAOIUpdateDue(currentPlayer.id) && shouldUpdateAOI(currentPlayer)) {
            if (PROFILE) prof.aoiUpdateCount++;
            await updatePlayerAOI(currentPlayer, spawnBatchQueue, despawnBatchQueue);
          }

          const movementData = {
            i: wt.data.id,
            d: {
              x: Number(currentPlayer.location.position.x),
              y: Number(currentPlayer.location.position.y),
              dr: currentPlayer.location.position.direction
            },
            r: stateRevision(),
            s: currentPlayer.isStealth ? 1 : 0
          };

          if (wt.readyState === 1) {
            if (!muteEcho) sendPacket(wt, packetManager.moveXY(movementData));

            const layerId = currentPlayer.aoi?.layerId || layerManager.getPlayerLayer(currentPlayer.id);
            const groupKey = layerId || currentPlayer.location.map;
            if (!movementBatchQueue.has(groupKey)) {
              movementBatchQueue.set(groupKey, new Map());
            }
            movementBatchQueue.get(groupKey)!.set(currentPlayer.id, movementData);
          }

          if (PROFILE) prof.moveCbCount++;
        };

        if (currentPlayer._moveSeq !== moveSeq) {
          break;
        }

        if (recoverResumedWalk(currentPlayer, wt.data?.walkRecoverUntil, Date.now())) {
          await sendPositionAnimation(
            wt,
            currentPlayer.location.position.direction,
            true,
            currentPlayer.mounted,
            currentPlayer.mount_type || "unicorn",
            undefined,
            stateRevision(),
            currentPlayer.casting || false
          );
          // Another MOVEXY (or an abort) came while the pose was built: it owns the movement now.
          if (currentPlayer._moveSeq !== moveSeq) break;
        }

        gameLoop.registerMovingPlayer(currentPlayer.id, movePlayer);

        if (!wasAlreadyMoving) {
          const catchUp = resumeCatchUpSteps(resumeCatchUp, direction, Date.now(), TICK_MS);
          try {
            muteEcho = catchUp > 0;
            await movePlayer();
            for (let i = 0; i < catchUp && currentPlayer._moveSeq === moveSeq && gameLoop.isPlayerMoving(currentPlayer.id); i++) {
              muteEcho = i < catchUp - 1;
              await movePlayer();
            }
          } finally {
            muteEcho = false;
          }
        }
        break;
      }

      case "TELEPORTXY": {
        if (!currentPlayer?.isAdmin) return;
        const prevDirection = currentPlayer.location.position?.direction;
        currentPlayer.location.position = data;
        currentPlayer.location.position.direction =
          (data as any).direction || prevDirection || "down";

        currentPlayer.location.position.x = Math.round(
          Number(currentPlayer.location.position.x)
        );
        currentPlayer.location.position.y = Math.round(
          Number(currentPlayer.location.position.y)
        );
        bumpStateRevision();
        ghosts.touch("player", currentPlayer.id);

        if (shouldUpdateAOI(currentPlayer)) {
          await updatePlayerAOI(currentPlayer, spawnBatchQueue, despawnBatchQueue);
        }

        const movementData = {
          i: wt.data.id,
          d: {
            x: Number(currentPlayer.location.position.x),
            y: Number(currentPlayer.location.position.y),
            dr: currentPlayer.location.position.direction
          },
          r: stateRevision(),
          s: currentPlayer.isStealth ? 1 : 0
        };
        broadcastToAOI(currentPlayer, packetManager.moveXY(movementData), true);
        // a teleport skips the walk that would stream in the NPCs round the new spot (npcStreaming)
        await resyncNpcChunks(currentPlayer, wt);
        break;
      }

      case "MOUNT": {
        if (!currentPlayer) return;

        // Dismounting if mounted is already true
        const dismounting = currentPlayer.mounted === true;
        // Getting off stays allowed: only mounting is locked.
        if (!dismounting && subscriptionLocked(wt, currentPlayer, "mount")) return;


        // Prevent mounting while casting
        if (currentPlayer.casting && !dismounting) {
          sendPacket(
            wt,
            packetManager.notify({ message: "Cannot mount while casting." })
          );
          return;
        }

        // Prevent mounting when PvP flag is enabled or vanished
        if ((currentPlayer.pvp || currentPlayer.isVanished) && !dismounting) {
          sendPacket(
            wt,
            packetManager.notify({ message: "Cannot mount while in PvP." })
          );
          return;
        }

        // Corpses and ghosts cannot mount.
        if ((currentPlayer.isDead || currentPlayer.isGhost) && !dismounting) {
          return;
        }

        // No mount is ridden inside a building.
        if (!dismounting && isInteriorMap(currentPlayer.location?.map)) {
          sendPacket(
            wt,
            packetManager.notify({ message: "Cannot mount indoors." })
          );
          return;
        }

        const canMount = player.canMount(currentPlayer);
        const mount = (data as any).mount;
        if (!mount) {
          sendPacket(
            wt,
            packetManager.notify({ message: "No mount type specified." })
          );
          break;
        }

        if (!canMount) {
          sendPacket(
            wt,
            packetManager.notify({
              message: "Mount feature is currently locked.",
              })
            );

            break;
          }

        if (!dismounting) {
          const hasMount = currentPlayer.collectables.some((c: any) => c.type === "mount" && c.item === mount);
          if (!hasMount) {
            sendPacket(
              wt,
              packetManager.notify({ message: "You do not have the specified mount." })
            );
            break;
          }
        }

        currentPlayer.mounted = !currentPlayer.mounted;

        if (currentPlayer.mounted) {
          currentPlayer.mount_type = mount;
        } else {
          currentPlayer.mount_type = null;
        }

        const direction = currentPlayer.location.position?.direction || "down";
        const walking = currentPlayer.moving || false;
        const mounted = currentPlayer.mounted;

        bumpStateRevision();

        await sendPositionAnimation(
          wt,
          direction,
          walking,
          mounted,
          currentPlayer.mount_type,
          currentPlayer.id,
          stateRevision(),
          currentPlayer.casting || false
        );

        if (gameLoop.isPlayerMoving(currentPlayer.id)) {

          const moveDirection = currentPlayer.location.position?.direction || "down";

          await packetReceiver(server, wt, JSON.stringify({ type: "MOVEXY", data: moveDirection }));
        }
        listener.emit(Events.PLAYER_MOUNT, { player: currentPlayer, mounted: currentPlayer.mounted, mountType: currentPlayer.mount_type });
        break;
      }
  }
}
