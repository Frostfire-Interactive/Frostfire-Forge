import packet from "../modules/packet";
import type { TradeView } from "../systems/trades";
import type { NodeTicket } from "./ticket";
import type { MapZone } from "../modules/zones";
import type { PortalPreviewData } from "../systems/dungeons/types";
import { TICK_RATE } from "../services/tickrate";
import { clientSettings } from "../systems/gamesettings/store";
import { shownStats, withShownStats } from "../systems/xpshown";
import { joinCreatureMoves } from "./creature_move_codec";
import { clientMapName } from "../systems/dungeons/copykey";

// A copy's players, chests and ghosts are on the template map as the client knows it.
const forClient = <T>(map: T): T => (typeof map === "string" ? clientMapName(map) as T : map);
const corpseForClient = (corpse: any) => (corpse && typeof corpse === "object" ? { ...corpse, map: forClient(corpse.map) } : corpse);

export const packetManager = {
  disconnect: (id: string) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "DISCONNECT_MALIFORMED",
          data: {
            id: id
          },
        })
      )
    ] as any[];
  },
  reconnect: () => {
    return [
      packet.encode(
        JSON.stringify({
          type: "RECONNECT",
          data: null,
        })
      )
    ] as any[];
  },
  ping: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "PONG", data: data })),
    ] as any[];
  },
  pong: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "PONG", data: data })),
    ] as any[];
  },
  benchmark: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "BENCHMARK", data: data })),
    ] as any[];
  },
  login: (wt: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "LOGIN_SUCCESS",
          data: wt.data.id,
          secret: wt.data.secret,
          chatDecryptionKey: wt.data.chatDecryptionKey,
          // The movement loop's ticks a second, which the client's movement smoothing is timed by.
          tickRate: TICK_RATE,
          // The live game settings the client mirrors (movement speeds, chat length).
          settings: clientSettings(),
        })
      )
    ] as any[];
  },
  gameSettings: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "GAME_SETTINGS", data })),
    ] as any[];
  },
  loginFailed: () => {
    return [
      packet.encode(JSON.stringify({ type: "LOGIN_FAILED", data: null })),
    ] as any[];
  },
  inventory: (data: InventoryItem[], slots?: number) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "INVENTORY",
          data,
          slots: slots ?? 30,
        }),
      )
    ] as any[];
  },
  equipment: (data: Equipment) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "EQUIPMENT",
          data,
        }),
      )
    ] as any[];
  },
  collectables: (data: Collectable[]) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "COLLECTABLES",
          data,
          slots: 20,
        }),
      )
    ] as any[];
  },
  spells: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "SPELLS",
          data,
        }),
      )
    ] as any[];
  },
  learnSpell: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "LEARN_SPELL",
          data,
        }),
      )
    ] as any[];
  },
  unlearnSpell: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "UNLEARN_SPELL",
          data,
        }),
      )
    ] as any[];
  },
  addInventoryItem: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "ADD_INVENTORY_ITEM",
          data,
        }),
      )
    ] as any[];
  },
  removeInventoryItem: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "REMOVE_INVENTORY_ITEM",
          data,
        }),
      )
    ] as any[];
  },
  addCollectable: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "ADD_COLLECTABLE",
          data,
        }),
      )
    ] as any[];
  },
  removeCollectable: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "REMOVE_COLLECTABLE",
          data,
        }),
      )
    ] as any[];
  },
  effects: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "EFFECTS",
          data,
        }),
      )
    ] as any[];
  },
  loadHotBar: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "LOAD_HOTBAR",
          data,
        }),
      )
    ] as any[];
  },
  questLog: (data: { active: QuestLogEntry[]; completed: number[]; definitions: Quest[] }) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "QUEST_LOG",
          data,
        })
      )
    ] as any[];
  },
  questLogEntry: (data: { entry: QuestLogEntry | null; quest: Quest; removed?: boolean }) => {
    return [
      packet.encode(JSON.stringify({ type: "QUEST_LOG_ENTRY", data })),
    ] as any[];
  },
  questProgress: (data: { questId: number; updates: ObjectiveUpdate[] }) => {
    return [
      packet.encode(JSON.stringify({ type: "QUEST_PROGRESS", data })),
    ] as any[];
  },
  questOffer: (data: { npcId: number; quest: Quest; canAccept: boolean; reason?: QuestEligibility }) => {
    return [
      packet.encode(JSON.stringify({ type: "QUEST_OFFER", data })),
    ] as any[];
  },
  questIncomplete: (data: { npcId: number; quest: Quest; progress: ObjectiveUpdate[] }) => {
    return [
      packet.encode(JSON.stringify({ type: "QUEST_INCOMPLETE", data })),
    ] as any[];
  },
  questTurnInOffer: (data: { npcId: number; quest: Quest }) => {
    return [
      packet.encode(JSON.stringify({ type: "QUEST_TURN_IN_OFFER", data })),
    ] as any[];
  },
  questCompleted: (data: { questId: number; xp: number; copper: number; items: Array<{ name: string; quantity: number }>; nextQuestId: Nullable<number> }) => {
    return [
      packet.encode(JSON.stringify({ type: "QUEST_COMPLETED", data })),
    ] as any[];
  },
  questError: (data: { code: string; message: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "QUEST_ERROR", data })),
    ] as any[];
  },
  questMarkers: (data: { map: string; markers: Record<number, QuestMarkerState> }) => {
    return [
      packet.encode(JSON.stringify({ type: "QUEST_MARKERS", data: { ...data, map: forClient(data.map) } })),
    ] as any[];
  },
  npcGossip: (data: { npcId: number; name: string | null; gossipText: string | null; quests: QuestOffer[]; vendor?: boolean; innkeeper?: boolean }) => {
    return [
      packet.encode(JSON.stringify({ type: "NPC_GOSSIP", data })),
    ] as any[];
  },
  itemCooldown: (data: { kind: "consumable" | "home"; remaining: number; total: number }) => {
    return [
      packet.encode(JSON.stringify({ type: "ITEM_COOLDOWN", data })),
    ] as any[];
  },
  /** Where the inns, merchants, caves and houses of the map the player is on are (map px), for their minimap and world map. Sent on entering a map, and again when an NPC changes. */
  mapMarkers: (data: { map: string; markers: Array<{ kind: "inn" | "merchant" | "cave" | "house"; x: number; y: number; name: string | null }> }) => {
    return [
      packet.encode(JSON.stringify({ type: "MAP_MARKERS", data: { ...data, map: forClient(data.map) } })),
    ] as any[];
  },
  /** Every cooldown of the player is over (an admin reset them): spells, the spell lockout and items. */
  cooldownsReset: () => {
    return [
      packet.encode(JSON.stringify({ type: "COOLDOWNS_RESET", data: null })),
    ] as any[];
  },
  /** What a vendor stocks (each item with what it is, and its price there in copper) and what the player can buy back from it. */
  vendorStock: (data: { npcId: number; name: string | null; items: Array<Item & { price: number }>; buyback: Array<Record<string, unknown>> }) => {
    return [
      packet.encode(JSON.stringify({ type: "VENDOR_STOCK", data })),
    ] as any[];
  },
  /** The player may no longer deal with the vendor (they walked off, say): their vendor window closes. */
  vendorClosed: (data: { message: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "VENDOR_CLOSED", data })),
    ] as any[];
  },
  questEditorData: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "QUEST_EDITOR_DATA", data })),
    ] as any[];
  },
  questEditorResults: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "QUEST_EDITOR_RESULTS", data })),
    ] as any[];
  },
  questEditorResult: (data: { ok: boolean; errors: string[]; id?: number; action?: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "QUEST_EDITOR_RESULT", data })),
    ] as any[];
  },
  questEditorUpdated: (data: { by: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "QUEST_EDITOR_UPDATED", data })),
    ] as any[];
  },
  stats: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "STATS",
          data: shownStats(data),
        })
      )
    ] as any[];
  },
  clientConfig: (data: any) => {
    const config = Array.isArray(data)
      ? data.map((entry) => entry && typeof entry === "object" && "auto_loot" in entry
        ? { ...entry, auto_loot: entry.auto_loot === true || Number(entry.auto_loot) === 1 }
        : entry)
      : data;
    return [
      packet.encode(
        JSON.stringify({
          type: "CLIENTCONFIG",
          data: config,
        })
      )
    ] as any[];
  },
  createNpc: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "CREATE_NPC",
          data: {
            id: data.id,
            last_updated: data.last_updated,
            name: data.name || null,
            location: {
              x: data.position.x,
              y: data.position.y,
              direction: data.location?.direction || data.position?.direction || "down",
            },
            script: data.script,
            hidden: data.hidden,
            dialog: data.dialog,
            gossip: data.gossip || null,
            particles: data.particles,
            map: forClient(data.map),
            position: data.position,
            sprite_type: data.sprite_type || 'animated',
            spriteLayers: data.spriteLayers || null,
            // Whether it sells things, so it can be talked to (see systems/npcStreaming.ts).
            vendor: data.vendor === true || (Array.isArray(data.vendor_items) && data.vendor_items.length > 0),
            // Whether it keeps an inn, which is a reason to talk to it too.
            innkeeper: data.innkeeper === true,
          },
        })
      )
    ] as any[];
  },
  loadNpcs: (npcs: any[]) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "LOAD_NPCS",
          data: { npcs },
        })
      )
    ] as any[];
  },
  /** NPCs whose map chunks left the player's range (systems/npcStreaming.ts): the client drops them. */
  unloadNpcs: (ids: number[]) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "UNLOAD_NPCS",
          data: { ids },
        })
      )
    ] as any[];
  },
  loadMap: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "LOAD_MAP",
          data
        })
      )
    ] as any[];
  },
  preloadMapChunks: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "PRELOAD_MAP_CHUNKS",
          data
        })
      )
    ] as any[];
  },
  spawnPlayer: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "SPAWN_PLAYER",
          data: {
            id: data.id,
            userid: data.userid,
            location: {
              map: forClient(data.location.map),
              x: data.location.x || 0,
              y: data.location.y || 0,
              direction: data.location.direction,
            },
            username: data.username,
            isAdmin: data.isAdmin,
            isGuest: data.isGuest,
            isStealth: data.isStealth,
            isVanished: data.isVanished,
            isNoclip: data.isNoclip,
            isDead: data.isDead || false,
            isGhost: data.isGhost || false,
            ghostTeleportPending: data.ghostTeleportPending || false,
            ...(data.arrived ? { arrived: true } : {}),
            corpse: corpseForClient(data.corpse || null),
            stats: shownStats(data.stats),
            sprite: data.sprite,
            mounted: data.mounted,
            spriteData: data.spriteData || null,
            ...(data.friends ? { friends: data.friends } : {}),
            ...(data.party ? { party: data.party } : {}),
            ...(data.party_raid !== undefined ? { party_raid: !!data.party_raid } : {}),
            ...(data.effects ? { effects: data.effects } : {}),
            guild: data.guild ?? [],
            guild_name: data.guild_name ?? null,
            ...(data.currency ? { currency: data.currency } : { copper: 0, silver: 0, gold: 0 }),
          },
        })
      )
    ] as any[];
  },
  loadPlayers: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "LOAD_PLAYERS",
          data: Array.isArray(data?.players) ? { ...data, players: data.players.map(withShownStats) } : data,
        })
      )
    ] as any[];
  },
  loadPlayersJson: (playersJson: string[], snapshotRevision: number | null) => {
    return [
      packet.encode(
        `{"type":"LOAD_PLAYERS","data":{"players":[${playersJson.join(",")}],"snapshotRevision":${JSON.stringify(snapshotRevision)}}}`
      )
    ] as any[];
  },
  moveXY: (data: any) => {
    const HEADER_BYTE = 0x02;
    const DIRECTION_MAP: Record<string, number> = {
      up: 0, down: 1, left: 2, right: 3,
      upleft: 4, upright: 5, downleft: 6, downright: 7
    };

    const playerId = typeof data.i === "number" ? data.i : parseInt(data.i, 10) || 0;
    const x = typeof data.d?.x === "number" ? Math.round(data.d.x) : 0;
    const y = typeof data.d?.y === "number" ? Math.round(data.d.y) : 0;
    const direction = DIRECTION_MAP[data.d?.dr as string] ?? 1;
    const stealth = data.s === 1 ? 1 : 0;

    const packetData = new Uint8Array(21);
    const view = new DataView(packetData.buffer);

    packetData[0] = HEADER_BYTE;
    view.setUint32(1, playerId, true);
    view.setInt32(5, x, true);
    view.setInt32(9, y, true);
    packetData[13] = direction | (stealth << 4);

    const serverSendTime = Date.now();
    view.setUint32(15, Math.floor(serverSendTime / 1000), true);
    view.setUint16(19, serverSendTime % 1000, true);

    return [packetData];
  },
  batchMoveXY: (movements: any[]) => {
    const HEADER_BYTE = 0x01;
    const DIRECTION_MAP: Record<string, number> = {
      up: 0, down: 1, left: 2, right: 3,
      upleft: 4, upright: 5, downleft: 6, downright: 7
    };

    const chunks: number[][] = [];

    chunks.push([HEADER_BYTE]);

    const countBytes = new Uint8Array(2);
    const dataView = new DataView(countBytes.buffer);
    dataView.setUint16(0, movements.length, true);
    chunks.push(Array.from(countBytes));

    for (const m of movements) {
      const playerId = typeof m.i === "number" ? m.i : parseInt(m.i, 10) || 0;

      const idBytes = new Uint8Array(4);
      const idView = new DataView(idBytes.buffer);
      idView.setUint32(0, playerId, true);
      chunks.push(Array.from(idBytes));

      const x = typeof m.d?.x === "number" ? Math.round(m.d.x) : 0;
      const y = typeof m.d?.y === "number" ? Math.round(m.d.y) : 0;
      const direction = DIRECTION_MAP[m.d?.dr as string] ?? 1;
      const stealth = m.s === 1 ? 1 : 0;

      const moveData = new Uint8Array(9);
      const moveView = new DataView(moveData.buffer);

      moveView.setInt32(0, x, true);
      moveView.setInt32(4, y, true);
      moveData[8] = direction | (stealth << 4);

      chunks.push(Array.from(moveData));
    }

    const flatLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(flatLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return [result];
  },
  chat: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "CHAT",
          data,
        })
      )
    ] as any[];
  },
  whisper: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "WHISPER",
          data,
        })
      )
    ] as any[];
  },
  partyChat: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "PARTY_CHAT",
          data,
        })
      )
    ] as any[];
  },
  guildChat: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "GUILD_CHAT",
          data,
        })
      )
    ] as any[];
  },
  officerChat: (data: any) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "OFFICER_CHAT",
          data,
        })
      )
    ] as any[];
  },
  selectPlayer: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "SELECTPLAYER", data })),
    ] as any[];
  },
  inspectPlayer: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "INSPECTPLAYER", data })),
    ] as any[];
  },
  stealth: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "STEALTH", data })),
    ] as any[];
  },
  noclip: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "NOCLIP", data })),
    ] as any[];
  },
  dragPlayerStart: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "DRAG_PLAYER_START", data })),
    ] as any[];
  },
  dragPlayerStop: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "DRAG_PLAYER_STOP", data })),
    ] as any[];
  },
  revive: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "REVIVE", data: withShownStats(data) })),
    ] as any[];
  },
  updateStats: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "UPDATESTATS", data: withShownStats(data) })),
    ] as any[];
  },
  toggleQuestEditor: () => {
    return [
      packet.encode(JSON.stringify({ type: "TOGGLE_QUEST_EDITOR", data: null })),
    ] as any[];
  },
  notify: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "NOTIFY", data })),
    ] as any[];
  },
  typing: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "TYPING", data })),
    ] as any[];
  },
  stopTyping: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "STOPTYPING", data })),
    ] as any[];
  },
  editorTileEdit: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "EDITOR_TILE_EDIT", data })),
    ] as any[];
  },
  editorLayerLock: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "EDITOR_LAYER_LOCK", data })),
    ] as any[];
  },
  /** The map editor's New map was refused, and why (systems/mapcreate.ts). */
  createMapFailed: (data: { message: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "CREATE_MAP_FAILED", data })),
    ] as any[];
  },
  /** The footstep sounds the map editor has set on tiles, all of them (systems/tilesounds.ts). */
  tileSounds: (data: { tilesets: Record<string, Record<string, string>> }) => {
    return [
      packet.encode(JSON.stringify({ type: "TILE_SOUNDS", data })),
    ] as any[];
  },
  fishing: (data: { id: string; state: "cast" | "bite" | "reel" | "escape" | "catch" | "end"; x?: number; y?: number; item?: string; icon?: string | null; quality?: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "FISHING", data })),
    ] as any[];
  },
  /** Which tiles are fishable, by tileset key: sent at login and after every save. */
  fishingTiles: (data: { tilesets: Record<string, number[]> }) => {
    return [
      packet.encode(JSON.stringify({ type: "FISHING_TILES", data })),
    ] as any[];
  },
  /** The map editor's Fishing tab: every fishable tile with what it gives, and the material items to pick from. */
  fishingEditorData: (data: { tiles: Record<string, Record<string, Array<{ item: string; chance: number }>>>; items: Array<{ name: string; image: string | null; quality: string | null }> }) => {
    return [
      packet.encode(JSON.stringify({ type: "FISHING_EDITOR_DATA", data })),
    ] as any[];
  },
  /** The footprints the map editor has set on tiles, all of them (systems/footprints.ts): sent at login and after a save. */
  tileFootprints: (data: { tilesets: Record<string, Record<string, { style: string; color: string; opacity: number; fade: number }>> }) => {
    return [
      packet.encode(JSON.stringify({ type: "TILE_FOOTPRINTS", data })),
    ] as any[];
  },
  editorSyncReady: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "EDITOR_SYNC_READY", data })),
    ] as any[];
  },
  mapZones: (data: { mapName: string, zones: MapZone[] }) => {
    return [
      packet.encode(JSON.stringify({ type: "MAP_ZONES", data })),
    ] as any[];
  },
  mapRebase: (data: { shiftX: number, shiftY: number, width: number, height: number }) => {
    return [
      packet.encode(JSON.stringify({ type: "MAP_REBASE", data })),
    ] as any[];
  },
  updateXp: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "UPDATE_XP", data: shownStats(data) })),
    ] as any[];
  },
  animation: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "ANIMATION", data })),
    ] as any[];
  },
  spriteSheetAnimation: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "SPRITE_SHEET_ANIMATION", data })),
    ] as any[];
  },
  spriteSheetPose: (data: { id: string; animationState: string; poseRev?: number }) => {
    return [
      packet.encode(JSON.stringify({ type: "SPRITE_SHEET_POSE", data })),
    ] as any[];
  },
  batchSpriteSheetAnimation: (animations: any[]) => {
    return [
      packet.encode(JSON.stringify({ type: "BATCH_SPRITE_SHEET_ANIMATION", data: animations })),
    ] as any[];
  },
  batchSpriteSheetAnimationJson: (animationsJson: string[]) => {
    return [
      packet.encode(`{"type":"BATCH_SPRITE_SHEET_ANIMATION","data":[${animationsJson.join(",")}]}`),
    ] as any[];
  },
  updateFriends: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "UPDATE_FRIENDS", data })),
    ] as any[];
  },
  updateIgnores: (data: { ignored: string[] }) => {
    return [
      packet.encode(JSON.stringify({ type: "UPDATE_IGNORES", data })),
    ] as any[];
  },
  /** A player's trade as it stands: both sides, and who has accepted. */
  tradeState: (data: TradeView) => {
    return [
      packet.encode(JSON.stringify({ type: "TRADE_STATE", data })),
    ] as any[];
  },
  /** A player's trade ended: whether the offers changed hands, and what they are told. */
  tradeClosed: (data: { completed: boolean; message: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "TRADE_CLOSED", data })),
    ] as any[];
  },
  invitation: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "INVITATION", data })),
    ] as any[];
  },
  updateOnlineStatus: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "UPDATE_ONLINE_STATUS", data })),
    ] as any[];
  },
  /** The party as its members see it: the list (leader first), who leads, and whether it is a raid group. */
  updateParty: (data: { members: string[]; leader?: string | null; raid?: boolean }) => {
    return [
      packet.encode(JSON.stringify({ type: "UPDATE_PARTY", data: { members: data.members, leader: data.leader ?? null, raid: !!data.raid } })),
    ] as any[];
  },
  updateGuild: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "UPDATE_GUILD", data })),
    ] as any[];
  },
  currency: (data: Currency) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "CURRENCY",
          data,
        })
      )
    ] as any[];
  },
  consoleMessage: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "CONSOLE_MESSAGE", data })),
    ] as any[];
  },
  serverTime: (utcOffset?: number | null) => {
    return [
      packet.encode(JSON.stringify({ type: "SERVER_TIME", data: Date.now(), ...(utcOffset != null ? { utcOffset } : {}) })),
    ] as any[];
  },
  weather: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "WEATHER", data })),
    ] as any[];
  },
  changeWeather: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "CHANGE_WEATHER", data })),
    ] as any[];
  },
  lightning: (data: { x: number; y: number; map: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "LIGHTNING", data: { ...data, map: forClient(data.map) } })),
    ] as any[];
  },
  tornadoes: (data: { map: string; tornadoes: Array<{ id: string; x: number; y: number }> }) => {
    return [
      packet.encode(JSON.stringify({ type: "TORNADOES", data: { ...data, map: forClient(data.map) } })),
    ] as any[];
  },
  collisionDebug: (data: { tileX: number; tileY: number }) => {
    return [
      packet.encode(JSON.stringify({ type: "COLLISION_DEBUG", data })),
    ] as any[];
  },
  toggleTileEditor: () => {
    return [
      packet.encode(JSON.stringify({ type: "TOGGLE_TILE_EDITOR", data: null })),
    ] as any[];
  },
  toggleParticleEditor: () => {
    return [
      packet.encode(JSON.stringify({ type: "TOGGLE_PARTICLE_EDITOR", data: null })),
    ] as any[];
  },
  toggleNpcEditor: () => {
    return [
      packet.encode(JSON.stringify({ type: "TOGGLE_NPC_EDITOR", data: null })),
    ] as any[];
  },
  npcList: (npcs: any[], quests?: Array<{ id: number; name: string }>, assets?: { spriteSheets: Record<string, Array<{ name: string; image: string | null }>>; icons: Array<{ name: string; image: string | null }>; items?: Array<{ name: string; icon: string | null; quality: string; sell_price: number; buy_price: number }> }) => {
    return [
      packet.encode(JSON.stringify({ type: "NPC_LIST", data: npcs, quests: quests || [], spriteSheets: assets?.spriteSheets || {}, icons: assets?.icons || [], items: assets?.items || [] })),
    ] as any[];
  },
  npcUpdated: (npc: any) => {
    return [
      packet.encode(JSON.stringify({ type: "NPC_UPDATED", data: npc })),
    ] as any[];
  },
  npcRemoved: (id: number) => {
    return [
      packet.encode(JSON.stringify({ type: "NPC_REMOVED", data: { id } })),
    ] as any[];
  },
  saveParticle: (particle: any) => {
    return [
      packet.encode(JSON.stringify({ type: "SAVE_PARTICLE", data: particle })),
    ] as any[];
  },
  deleteParticle: (particleName: string) => {
    return [
      packet.encode(JSON.stringify({ type: "DELETE_PARTICLE", data: { name: particleName } })),
    ] as any[];
  },
  listParticles: () => {
    return [
      packet.encode(JSON.stringify({ type: "LIST_PARTICLES", data: null })),
    ] as any[];
  },
  testParticle: (particle: any, testType: string, data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "TEST_PARTICLE", data: { particle, testType, data } })),
    ] as any[];
  },
  particleUpdated: (particle: any) => {
    return [
      packet.encode(JSON.stringify({ type: "PARTICLE_UPDATED", data: particle })),
    ] as any[];
  },
  reloadChunks: () => {
    return [
      packet.encode(JSON.stringify({ type: "RELOAD_CHUNKS", data: null })),
    ] as any[];
  },
  updateChunks: (data: { chunks: Array<{chunkX: number, chunkY: number}>, width?: number, height?: number, rebased?: boolean }) => {
    return [
      packet.encode(JSON.stringify({ type: "UPDATE_CHUNKS", data })),
    ] as any[];
  },
  chunkData: (chunkX: number, chunkY: number, width: number, height: number, layers: any[], tilewidth?: number, tileheight?: number, startX?: number, startY?: number) => {
    return [
      packet.encode(JSON.stringify({
        type: "CHUNK_DATA",
        data: { chunkX, chunkY, width, height, layers, tilewidth, tileheight, startX, startY }
      })),
    ] as any[];
  },
  custom: (data: any) => {
    return [
      packet.encode(JSON.stringify(data)),
    ] as any[];
  },
  mount: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "MOUNT", data })),
    ] as any[];
  },
  castSpell: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "CAST_SPELL", data })),
    ] as any[];
  },
  spellLockout: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "SPELL_LOCKOUT", data })),
    ] as any[];
  },
  projectile: (data: any) => {
    // Projectiles are only meaningful with an icon or particles to render
    if (!data?.icon && !Array.isArray(data?.particles)) return [];
    return [
      packet.encode(JSON.stringify({ type: "PROJECTILE", data })),
    ] as any[];
  },
  groundAoeCasting: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "GROUND_AOE_CASTING", data })),
    ] as any[];
  },
  groundAoeSpawn: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "GROUND_AOE_SPAWN", data })),
    ] as any[];
  },
  groundAoeDespawn: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "GROUND_AOE_DESPAWN", data })),
    ] as any[];
  },
  bags: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "BAGS", data })),
    ] as any[];
  },
  despawnPlayer: (playerId: string, reason?: string) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "DESPAWN_PLAYER",
          data: {
            id: playerId,
            reason: reason
          }
        })
      )
    ] as any[];
  },
  batchDisconnectPlayer: (despawnData: Array<{ id: string; reason: string }>) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "BATCH_DISCONNECT_PLAYER",
          data: despawnData
        })
      )
    ] as any[];
  },
  getOnlinePlayers: () => {
    return [
      packet.encode(
        JSON.stringify({
          type: "GET_ONLINE_PLAYERS",
          data: null
        })
      )
    ] as any[];
  },
  onlinePlayersList: (players: Array<{ username: string; map: string; isAdmin: boolean }>) => {
    return [
      packet.encode(
        JSON.stringify({
          type: "ONLINE_PLAYERS_LIST",
          data: players.map((p) => ({ ...p, map: forClient(p.map) }))
        })
      )
    ] as any[];
  },
  lootSpawn: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "LOOT_SPAWN", data })),
    ] as any[];
  },
  loadLoot: (lootItems: any[]) => {
    return [
      packet.encode(JSON.stringify({ type: "LOAD_LOOT", data: { loot: lootItems } })),
    ] as any[];
  },
  lootDespawn: (id: string) => {
    return [
      packet.encode(JSON.stringify({ type: "LOOT_DESPAWN", data: { id } })),
    ] as any[];
  },
  skeletonSpawn: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "ADD_SKELETON", data: data && { ...data, map: forClient(data.map) } })),
    ] as any[];
  },
  loadSkeletons: (skeletonItems: any[]) => {
    return [
      packet.encode(JSON.stringify({ type: "LOAD_SKELETONS", data: { skeletons: skeletonItems.map((s) => s && { ...s, map: forClient(s.map) }) } })),
    ] as any[];
  },
  skeletonDespawn: (id: string) => {
    return [
      packet.encode(JSON.stringify({ type: "REMOVE_SKELETON", data: { id } })),
    ] as any[];
  },
  playerDied: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "PLAYER_DIED", data: data && { ...data, ...(data.corpse ? { corpse: corpseForClient(data.corpse) } : {}) } })),
    ] as any[];
  },
  playerGhost: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "PLAYER_GHOST", data: data && "map" in data ? { ...data, map: forClient(data.map) } : data })),
    ] as any[];
  },
  reviveOffer: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "REVIVE_OFFER", data })),
    ] as any[];
  },
  lootChestSpawn: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "LOOT_CHEST_SPAWN", data: data && { ...data, map: forClient(data.map) } })),
    ] as any[];
  },
  lootChestDespawn: (chestId: string) => {
    return [
      packet.encode(JSON.stringify({ type: "LOOT_CHEST_DESPAWN", data: { id: chestId } })),
    ] as any[];
  },
  lootChestContents: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "LOOT_CHEST_CONTENTS", data })),
    ] as any[];
  },
  /** The mailboxes of the map the player is on (map px, the middle of each one's foot), and the picture they are drawn with. Sent with the map's markers. */
  mailboxes: (data: { map: string; mailboxes: Array<{ id: string; x: number; y: number }>; iconUrl: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "MAILBOXES", data: { ...data, map: forClient(data.map) } })),
    ] as any[];
  },
  /** A player's mail, the newest first: this opens their mail window, or brings it up to date. */
  mailInbox: (data: { mail: any[]; postage: number; itemsMax: number; subjectMax: number; bodyMax: number }) => {
    return [
      packet.encode(JSON.stringify({ type: "MAIL_INBOX", data })),
    ] as any[];
  },
  /** What became of a mail the player sent. */
  mailSent: (data: { ok: boolean; message: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "MAIL_SENT", data })),
    ] as any[];
  },
  /** How many of the player's mails are unread. */
  mailNotice: (data: { unread: number }) => {
    return [
      packet.encode(JSON.stringify({ type: "MAIL_NOTICE", data })),
    ] as any[];
  },
  /** The player's mail window is closed: they are no longer at a mailbox. */
  mailClosed: (data: { message: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "MAIL_CLOSED", data })),
    ] as any[];
  },
  /** Opens the mailbox editor (/mailbox), or closes it. */
  toggleMailboxEditor: () => {
    return [
      packet.encode(JSON.stringify({ type: "TOGGLE_MAILBOX_EDITOR", data: null })),
    ] as any[];
  },
  mailboxEditorData: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "MAILBOX_EDITOR_DATA", data })),
    ] as any[];
  },
  mailboxEditorResult: (data: { ok: boolean; errors: string[]; fields?: Record<string, string>; name?: string | null; notes: string[]; action?: string; data: any }) => {
    return [
      packet.encode(JSON.stringify({ type: "MAILBOX_EDITOR_RESULT", data })),
    ] as any[];
  },
  mailboxEditorUpdated: (data: { by: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "MAILBOX_EDITOR_UPDATED", data })),
    ] as any[];
  },
  /** Gathering nodes coming into view (systems/gathering). */
  gatherNodeSpawn: (nodes: Array<{ id: number; x: number; y: number; item: string; icon: string | null; size: number }>) => {
    return [
      packet.encode(JSON.stringify({ type: "GATHER_NODE_SPAWN", data: { nodes } })),
    ] as any[];
  },
  gatherNodeDespawn: (ids: number[]) => {
    return [
      packet.encode(JSON.stringify({ type: "GATHER_NODE_DESPAWN", data: { ids } })),
    ] as any[];
  },
  /** Opens the gathering editor (/gathering), or closes it. */
  toggleGatheringEditor: () => {
    return [
      packet.encode(JSON.stringify({ type: "TOGGLE_GATHERING_EDITOR", data: null })),
    ] as any[];
  },
  gatheringEditorData: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "GATHERING_EDITOR_DATA", data })),
    ] as any[];
  },
  gatheringEditorPreview: (data: { spots: Array<{ x: number; y: number }>; wanted: number; note: string | null }) => {
    return [
      packet.encode(JSON.stringify({ type: "GATHERING_EDITOR_PREVIEW_SPOTS", data })),
    ] as any[];
  },
  gatheringEditorResult: (data: { ok: boolean; errors: string[]; fields?: Record<string, string>; id: number | null; notes: string[]; action?: string; data: any }) => {
    return [
      packet.encode(JSON.stringify({ type: "GATHERING_EDITOR_RESULT", data })),
    ] as any[];
  },
  gatheringEditorUpdated: (data: { by: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "GATHERING_EDITOR_UPDATED", data })),
    ] as any[];
  },
  /** An achievement was just earned (systems/achievements): the earner's popup. */
  achievementEarned: (data: { id: number; name: string; description: string; icon: string | null; rewardItem: string | null; rewardQuantity: number; rewardMount: string | null; mailed: boolean }) => {
    return [
      packet.encode(JSON.stringify({ type: "ACHIEVEMENT_EARNED", data })),
    ] as any[];
  },
  /** Every enabled achievement with the player's progress: their achievements window. */
  achievements: (data: { achievements: any[] }) => {
    return [
      packet.encode(JSON.stringify({ type: "ACHIEVEMENTS", data })),
    ] as any[];
  },
  /** Opens the achievement editor (/achievements), or closes it. */
  toggleAchievementEditor: () => {
    return [
      packet.encode(JSON.stringify({ type: "TOGGLE_ACHIEVEMENT_EDITOR", data: null })),
    ] as any[];
  },
  achievementEditorData: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "ACHIEVEMENT_EDITOR_DATA", data })),
    ] as any[];
  },
  achievementEditorResult: (data: { ok: boolean; errors: string[]; fields?: Record<string, string>; id: number | null; notes: string[]; action?: string; data: any }) => {
    return [
      packet.encode(JSON.stringify({ type: "ACHIEVEMENT_EDITOR_RESULT", data })),
    ] as any[];
  },
  achievementEditorUpdated: (data: { by: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "ACHIEVEMENT_EDITOR_UPDATED", data })),
    ] as any[];
  },
  toggleLootEditor: () => {
    return [
      packet.encode(JSON.stringify({ type: "TOGGLE_LOOT_EDITOR", data: null })),
    ] as any[];
  },
  lootTableList: (tables: any[], items: Array<{ name: string; quality: string; iconUrl: string }> = []) => {
    return [
      packet.encode(JSON.stringify({ type: "LOOT_TABLE_LIST", data: { tables, items } })),
    ] as any[];
  },
  lootEditorResult: (data: { ok: boolean; errors: string[]; action?: string; request?: number; id?: number; tables: any[] | null }) => {
    return [
      packet.encode(JSON.stringify({ type: "LOOT_EDITOR_RESULT", data })),
    ] as any[];
  },
  creatureSpawn: (creatures: any[]) => {
    return [
      packet.encode(JSON.stringify({ type: "CREATURE_SPAWN", data: { creatures } })),
    ] as any[];
  },
  creatureDespawn: (ids: number[]) => {
    return [
      packet.encode(JSON.stringify({ type: "CREATURE_DESPAWN", data: { ids } })),
    ] as any[];
  },
  creatureMove: (entries: any[]) => {
    return [
      packet.encode(JSON.stringify({ type: "CREATURE_MOVE", data: { c: entries } })),
    ] as any[];
  },
  creatureMoveJson: (entriesJson: string[]) => {
    return [
      packet.encode(`{"type":"CREATURE_MOVE","data":{"c":[${entriesJson.join(",")}]}}`),
    ] as any[];
  },
  // CREATURE_MOVE as one binary datagram of records made by encodeCreatureMove (socket/creature_move_codec.ts).
  creatureMoveBinary: (records: readonly Uint8Array[]) => {
    return [joinCreatureMoves(records)] as any[];
  },
  creatureState: (data: { id: number; state: string; victimId: string | null }) => {
    return [
      packet.encode(JSON.stringify({ type: "CREATURE_STATE", data })),
    ] as any[];
  },
  creatureHealth: (data: { id: number; health: number; maxHealth: number }) => {
    return [
      packet.encode(JSON.stringify({ type: "CREATURE_HEALTH", data })),
    ] as any[];
  },
  creatureCombatText: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "CREATURE_COMBAT_TEXT", data })),
    ] as any[];
  },
  creatureTap: (data: { id: number; tap: "none" | "mine" | "other" }) => {
    return [
      packet.encode(JSON.stringify({ type: "CREATURE_TAP", data })),
    ] as any[];
  },
  creatureLootable: (data: { id: number; lootable: boolean }) => {
    return [
      packet.encode(JSON.stringify({ type: "CREATURE_LOOTABLE", data })),
    ] as any[];
  },
  creatureLootContents: (data: { id: number; items: any[]; copper: number }) => {
    return [
      packet.encode(JSON.stringify({ type: "CREATURE_LOOT_CONTENTS", data })),
    ] as any[];
  },
  /** An item taken from a corpse: the client says so with the name in its quality's colour. */
  lootReceived: (data: { itemName: string; quantity: number; quality: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "LOOT_RECEIVED", data })),
    ] as any[];
  },
  creatureXp: (data: { creatureId: number; amount: number }) => {
    return [
      packet.encode(JSON.stringify({ type: "CREATURE_XP", data })),
    ] as any[];
  },
  creatureCast: (data: { id: number; spell: string; durationMs: number; targetId: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "CREATURE_CAST", data })),
    ] as any[];
  },
  creatureCastEnd: (data: { id: number; spell: string; result: "success" | "interrupted" | "failed" }) => {
    return [
      packet.encode(JSON.stringify({ type: "CREATURE_CAST_END", data })),
    ] as any[];
  },
  creatureAuras: (data: { id: number; auras: any[] }) => {
    return [
      packet.encode(JSON.stringify({ type: "CREATURE_AURAS", data })),
    ] as any[];
  },
  toggleCreatureEditor: () => {
    return [
      packet.encode(JSON.stringify({ type: "TOGGLE_CREATURE_EDITOR", data: null })),
    ] as any[];
  },
  creatureEditorData: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "CREATURE_EDITOR_DATA", data })),
    ] as any[];
  },
  creatureEditorResult: (data: { ok: boolean; errors: string[]; id?: number; action?: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "CREATURE_EDITOR_RESULT", data })),
    ] as any[];
  },
  creatureEditorUpdated: (data: { by: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "CREATURE_EDITOR_UPDATED", data })),
    ] as any[];
  },
  toggleItemEditor: () => {
    return [
      packet.encode(JSON.stringify({ type: "TOGGLE_ITEM_EDITOR", data: null })),
    ] as any[];
  },
  itemEditorData: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "ITEM_EDITOR_DATA", data })),
    ] as any[];
  },
  itemEditorResults: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "ITEM_EDITOR_RESULTS", data })),
    ] as any[];
  },
  itemEditorResult: (data: { ok: boolean; errors: string[]; name?: string; action?: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "ITEM_EDITOR_RESULT", data })),
    ] as any[];
  },
  itemEditorUpdated: (data: { by: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "ITEM_EDITOR_UPDATED", data })),
    ] as any[];
  },
  /** Opens the mount editor (/mounteditor), or closes it. */
  toggleMountEditor: () => {
    return [
      packet.encode(JSON.stringify({ type: "TOGGLE_MOUNT_EDITOR", data: null })),
    ] as any[];
  },
  mountEditorData: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "MOUNT_EDITOR_DATA", data })),
    ] as any[];
  },
  mountEditorResult: (data: { ok: boolean; errors: string[]; fields?: Record<string, string>; name: string | null; action?: string; data: any }) => {
    return [
      packet.encode(JSON.stringify({ type: "MOUNT_EDITOR_RESULT", data })),
    ] as any[];
  },
  mountEditorUpdated: (data: { by: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "MOUNT_EDITOR_UPDATED", data })),
    ] as any[];
  },
  /** Opens the game settings editor (/gamesettings), or closes it. */
  toggleGameSettingsEditor: () => {
    return [
      packet.encode(JSON.stringify({ type: "TOGGLE_GAME_SETTINGS_EDITOR", data: null })),
    ] as any[];
  },
  gameSettingsEditorData: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "GAME_SETTINGS_EDITOR_DATA", data })),
    ] as any[];
  },
  gameSettingsEditorResult: (data: { ok: boolean; errors: string[]; fields?: Record<string, string>; name: string | null; action?: string; data: any }) => {
    return [
      packet.encode(JSON.stringify({ type: "GAME_SETTINGS_EDITOR_RESULT", data })),
    ] as any[];
  },
  gameSettingsEditorUpdated: (data: { by: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "GAME_SETTINGS_EDITOR_UPDATED", data })),
    ] as any[];
  },
  /** Opens the cutscene editor (/cutsceneeditor, /cse), or closes it. */
  toggleCutsceneEditor: () => {
    return [
      packet.encode(JSON.stringify({ type: "TOGGLE_CUTSCENE_EDITOR", data: null })),
    ] as any[];
  },
  cutsceneEditorData: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "CUTSCENE_EDITOR_DATA", data })),
    ] as any[];
  },
  cutsceneEditorResult: (data: { ok: boolean; errors: string[]; fields?: Record<string, string>; name: string | null; action?: string; doc?: any }) => {
    return [
      packet.encode(JSON.stringify({ type: "CUTSCENE_EDITOR_RESULT", data })),
    ] as any[];
  },
  cutsceneEditorResolved: (data: { doc: any }) => {
    return [
      packet.encode(JSON.stringify({ type: "CUTSCENE_EDITOR_RESOLVED", data })),
    ] as any[];
  },
  cutsceneEditorUpdated: (data: { by: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "CUTSCENE_EDITOR_UPDATED", data })),
    ] as any[];
  },
  /** A scene for a player to watch: `doc` is resolved and has no triggers. `token` marks this showing of it. */
  cutscenePlay: (data: { token: string; doc: any }) => {
    return [
      packet.encode(JSON.stringify({ type: "CUTSCENE_PLAY", data })),
    ] as any[];
  },
  /** The showing with this token is over: the client drops the scene wherever it is. */
  cutsceneStop: (data: { token: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "CUTSCENE_STOP", data })),
    ] as any[];
  },
  toggleSpellEditor: () => {
    return [
      packet.encode(JSON.stringify({ type: "TOGGLE_SPELL_EDITOR", data: null })),
    ] as any[];
  },
  spellEditorData: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "SPELL_EDITOR_DATA", data })),
    ] as any[];
  },
  spellEditorResults: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "SPELL_EDITOR_RESULTS", data })),
    ] as any[];
  },
  spellEditorResult: (data: { ok: boolean; errors: string[]; fields?: Record<string, string>; name?: string; action?: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "SPELL_EDITOR_RESULT", data })),
    ] as any[];
  },
  spellEditorUpdated: (data: { by: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "SPELL_EDITOR_UPDATED", data })),
    ] as any[];
  },
  toggleWeatherEditor: () => {
    return [
      packet.encode(JSON.stringify({ type: "TOGGLE_WEATHER_EDITOR", data: null })),
    ] as any[];
  },
  weatherEditorData: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "WEATHER_EDITOR_DATA", data })),
    ] as any[];
  },
  weatherEditorResult: (data: { ok: boolean; errors: string[]; fields?: Record<string, string>; name?: string; notes: string[]; action?: string; data: any }) => {
    return [
      packet.encode(JSON.stringify({ type: "WEATHER_EDITOR_RESULT", data })),
    ] as any[];
  },
  weatherEditorUpdated: (data: { by: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "WEATHER_EDITOR_UPDATED", data })),
    ] as any[];
  },
  // The account has no character yet: the client goes to the gateway's character page (systems/classes.ts).
  characterRequired: () => {
    return [
      packet.encode(JSON.stringify({ type: "CHARACTER_REQUIRED", data: null })),
    ] as any[];
  },
  switchNode: (node: { nodeId: string; publicHost: string; port: number; wtPort: number; useSSL: boolean }, ticket: NodeTicket, handoff?: { resume: boolean }) => {
    const { nodeId, publicHost, port, wtPort, useSSL } = node;
    return [
      packet.encode(JSON.stringify({ type: "SWITCH", data: { nodeId, publicHost, port, wtPort, useSSL, ticket, ...(handoff ? { handoff: true, resume: handoff.resume, report: true, gapUpdates: true } : {}) } })),
    ] as any[];
  },
  handoffPrepare: (node: { nodeId: string; publicHost: string; port: number; wtPort: number; useSSL: boolean }) => {
    const { nodeId, publicHost, port, wtPort, useSSL } = node;
    return [packet.encode(JSON.stringify({ type: "HANDOFF_PREPARE", data: { nodeId, publicHost, port, wtPort, useSSL } }))] as any[];
  },
  // The handoff the client was prepared for will not happen soon: it closes the session it opened.
  handoffAbort: () => {
    return [packet.encode(JSON.stringify({ type: "HANDOFF_ABORT", data: null }))] as any[];
  },
  handoffBegin: (at: { x: number; y: number } | null) => {
    return [packet.encode(JSON.stringify({ type: "HANDOFF_BEGIN", data: { report: true, gapUpdates: true, ...(at ?? {}) } }))] as any[];
  },
  // The handoff was given up after HANDOFF_BEGIN: the node keeps the player, standing at this point (null: not known).
  handoffStay: (at: { x: number; y: number } | null) => {
    return [packet.encode(JSON.stringify({ type: "HANDOFF_STAY", data: at }))] as any[];
  },
  handoffDone: (data: { map: string; x: number; y: number; direction: string; walk?: string | null; catchUpMs?: number; gapSeq?: number }) => {
    return [packet.encode(JSON.stringify({ type: "HANDOFF_DONE", data: { ...data, map: forClient(data.map) } }))] as any[];
  },
  /** The answer to a gap report that came after HANDOFF_DONE (receiver.ts applyLateGap): where the player is now, as at DONE. */
  handoffGapDone: (data: { seq: number; x: number; y: number; direction: string; walk: string | null; catchUpMs: number; t: number }) => {
    return [packet.encode(JSON.stringify({ type: "HANDOFF_GAP_DONE", data }))] as any[];
  },
  toggleClassEditor: () => {
    return [
      packet.encode(JSON.stringify({ type: "TOGGLE_CLASS_EDITOR", data: null })),
    ] as any[];
  },
  classEditorData: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "CLASS_EDITOR_DATA", data })),
    ] as any[];
  },
  classEditorResult: (data: { ok: boolean; errors: string[]; fields?: Record<string, string>; name?: string; notes: string[]; action?: string; data: any }) => {
    return [
      packet.encode(JSON.stringify({ type: "CLASS_EDITOR_RESULT", data })),
    ] as any[];
  },
  classEditorUpdated: (data: { by: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "CLASS_EDITOR_UPDATED", data })),
    ] as any[];
  },
  toggleDungeonEditor: () => {
    return [
      packet.encode(JSON.stringify({ type: "TOGGLE_DUNGEON_EDITOR", data: null })),
    ] as any[];
  },
  mapObjectOptions: (data: { dungeons: Array<{ id: number; name: string }>; lootTables: Array<{ id: number; name: string }>; message?: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "MAP_OBJECT_OPTIONS_DATA", data })),
    ] as any[];
  },
  /** The answer to the map editor's SAVE_MAP: its saveId as it came (none from an older editor), and whether the save worked. */
  mapSaveResult: (data: { saveId?: unknown; mapName?: unknown; ok: boolean }) => {
    return [
      packet.encode(JSON.stringify({ type: "MAP_SAVE_RESULT", data })),
    ] as any[];
  },
  dungeonEditorData: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "DUNGEON_EDITOR_DATA", data })),
    ] as any[];
  },
  dungeonEditorResult: (data: { ok: boolean; errors: string[]; fields?: Record<string, string>; name?: string; id?: number; notes: string[]; action?: string; data: any }) => {
    return [
      packet.encode(JSON.stringify({ type: "DUNGEON_EDITOR_RESULT", data })),
    ] as any[];
  },
  dungeonSizeChoice: (data: { dungeonId: number; name: string; sizes: number[]; authorization: string; expiresInMs: number }) => {
    return [
      packet.encode(JSON.stringify({ type: "DUNGEON_SIZE_CHOICE", data })),
    ] as any[];
  },
  dungeonPortalPreview: (data: PortalPreviewData) => {
    return [
      packet.encode(JSON.stringify({ type: "DUNGEON_PORTAL_PREVIEW_DATA", data })),
    ] as any[];
  },
  dungeonPortalPeek: (data: { portal: string; players: Array<{ i: string; x: number; y: number; d: string; m: 0 | 1 }>; looks: Array<{ i: string; s: any }> }) => {
    return [
      packet.encode(JSON.stringify({ type: "DUNGEON_PORTAL_PEEK_DATA", data })),
    ] as any[];
  },
  dungeonPortalsChanged: () => {
    return [
      packet.encode(JSON.stringify({ type: "DUNGEON_PORTALS_CHANGED", data: {} })),
    ] as any[];
  },
  portalEditorData: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "PORTAL_EDITOR_DATA", data })),
    ] as any[];
  },
  portalEditorResult: (data: { ok: boolean; errors: string[]; fields?: Record<string, string>; name?: string; notes: string[]; action?: string; data: any }) => {
    return [
      packet.encode(JSON.stringify({ type: "PORTAL_EDITOR_RESULT", data })),
    ] as any[];
  },
  /** A map's portals after a save in the portal or dungeon editor: its players draw them at once. */
  mapPortals: (data: { mapName: string; portals: any[] }) => {
    return [
      packet.encode(JSON.stringify({ type: "MAP_PORTALS", data })),
    ] as any[];
  },
  stoneEditorData: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "SUMMON_STONE_EDITOR_DATA", data })),
    ] as any[];
  },
  stoneEditorResult: (data: { ok: boolean; errors: string[]; fields?: Record<string, string>; name?: string; action?: string; data: any }) => {
    return [
      packet.encode(JSON.stringify({ type: "SUMMON_STONE_EDITOR_RESULT", data })),
    ] as any[];
  },
  /** A map's summoning stones after a save in the stone editor: its players draw them at once. */
  mapSummoningStones: (data: { mapName: string; stones: any[] }) => {
    return [
      packet.encode(JSON.stringify({ type: "MAP_SUMMONING_STONES", data })),
    ] as any[];
  },
  dungeonEditorUpdated: (data: { by: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "DUNGEON_EDITOR_UPDATED", data })),
    ] as any[];
  },
  playerEditorOpen: (data: { target: string }) => {
    return [
      packet.encode(JSON.stringify({ type: "PLAYER_EDITOR_OPEN", data })),
    ] as any[];
  },
  playerEditorData: (data: { options: PlayerEditorOptions; snapshot: PlayerEditorSnapshot }) => {
    return [
      packet.encode(JSON.stringify({ type: "PLAYER_EDITOR_DATA", data })),
    ] as any[];
  },
  playerEditorResults: (data: any) => {
    return [
      packet.encode(JSON.stringify({ type: "PLAYER_EDITOR_RESULTS", data })),
    ] as any[];
  },
  playerEditorResult: (data: { ok: boolean; errors: string[]; action?: string; snapshot?: PlayerEditorSnapshot | null }) => {
    return [
      packet.encode(JSON.stringify({ type: "PLAYER_EDITOR_RESULT", data })),
    ] as any[];
  },
  /** The tools the player may open (systems/stafftools.ts): the game's staff bar shows a button for each. */
  staffTools: (data: { tools: string[] }) => {
    return [
      packet.encode(JSON.stringify({ type: "STAFF_TOOLS", data })),
    ] as any[];
  },
  toggleControlPanel: () => {
    return [
      packet.encode(JSON.stringify({ type: "TOGGLE_CONTROL_PANEL", data: null })),
    ] as any[];
  },
  controlPanelData: (data: ControlPanelData) => {
    return [
      packet.encode(JSON.stringify({ type: "CONTROL_PANEL_DATA", data })),
    ] as any[];
  },
  controlPanelResults: (data: ControlPanelResults) => {
    return [
      packet.encode(JSON.stringify({ type: "CONTROL_PANEL_RESULTS", data })),
    ] as any[];
  },
  controlPanelResult: (data: ControlPanelResult) => {
    return [
      packet.encode(JSON.stringify({ type: "CONTROL_PANEL_RESULT", data })),
    ] as any[];
  },
  creatureDebug: (data: { creatures: any[] }) => {
    return [
      packet.encode(JSON.stringify({ type: "CREATURE_DEBUG", data })),
    ] as any[];
  },
  clusterDebugData: (data: Record<string, unknown>) => {
    return [
      packet.encode(JSON.stringify({ type: "CLUSTER_DEBUG_DATA", data })),
    ] as any[];
  },
  creatureTargeted: (data: { id: number }) => {
    return [
      packet.encode(JSON.stringify({ type: "CREATURE_TARGETED", data })),
    ] as any[];
  },
};
export function observerStats(stats: any): Record<string, number> {
  const out: Record<string, number> = {
    health: stats.health,
    stamina: stats.stamina,
    total_max_health: stats.total_max_health,
    total_max_stamina: stats.total_max_stamina,
  };
  for (const key of ["level", "stat_damage", "stat_armor", "stat_critical_chance", "stat_critical_damage", "stat_avoidance", "absorbtion"]) {
    if (stats[key] !== undefined) out[key] = stats[key];
  }
  return out;
}

export function regenStatsFrames(player: { id: string; username?: string }, stats: any): { full: Uint8Array; frameFor: (viewer: { party?: string[] }) => Uint8Array } {
  const full = packetManager.updateStats({ id: player.id, target: player.id, stats })[0];
  let trimmed: Uint8Array | null = null;
  return {
    full,
    frameFor: (viewer) =>
      viewer.party?.includes(player.username as string)
        ? full
        : (trimmed ??= packetManager.updateStats({ target: player.id, stats: observerStats(stats) })[0]),
  };
}
