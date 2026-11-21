import { packetTypes } from "./types";
import { packetManager } from "./packet_manager";
import { forgetLook, lookSignature, noteLook } from "./looks";
import { frameLimitFor } from "./framing";
import { nodeTicket } from "./ticket";
import { atomically, nothingWritten } from "../services/batch";
import { deferredStep } from "../services/deferredstep";
import log from "../modules/logger";
import { StallReporter } from "../modules/stallreport";
import path from "path";
import player, { clearMapCache } from "../systems/player.ts";
// Keeps the startup load order: the handler modules, which import these, load at the first packet.
import "../systems/permissions";
import "../systems/tilesounds";
import "../systems/mapcreate";
import { getAuthPool } from "./authentication_pool.ts";
import { LoginPrefetch } from "./loginprefetch.ts";
import { listener } from "../modules/event_bus";
import { Events, setPlayerPvp } from "../systems/events";
import { afterTickFlush, batchVolume, collectGroupReceivers, collectReceiverEntries, encodeBatch, farUpdateEvery, indexMovers, MovementVolume, NEAR_TIER_DISTANCE, type EntryTally, MoverSnapshot, ReceiverDiff, ReceiverInfo } from "./movement_batch.ts";
import * as aoiReverse from "../services/aoiReverseIndex";
import { queueLayerWorkerFlush, postToAllWorkers, setOnWorkerRetired } from "./movement_worker_pool.ts";
import { requeueSpawnBatch, claimDespawnEntry, requeueDespawnEntry, setBounded, spawnsPerFlush, SPAWN_FLUSH_CONCURRENCY, flushSpawnQueue } from "./batch_queue_utils.ts";
export const authentication_queue = new Set<string>();
export const authentication_session_queue = new Set<string>();

/** `prefetched`: the player's rows, read before the AUTH (loginprefetch.ts); the worker only checks the token. */
export const pendingAuthentications = new Map<string, { wt: any; token: string; language: string; prefetched?: Promise<PlayerData | null> }>();

// Track current target for target cycling
export const currentTargetMap = new Map<string, string | null>();

// Track who is being dragged by whom (draggedPlayerId -> adminId)
export const draggedPlayersMap = new Map<number, number>();

// Track active tile editors per map (mapName -> Set<playerId>)
export const chatRateLimit = new Map<number, number[]>();

/** Player-triggered NPC/quest packets share the chat-style rate limit bucket. */
const questRateLimit = new Map<string, number[]>();
const QUEST_RATE_MAX = 5;
const QUEST_RATE_WINDOW = 3000;
/** Must be within this distance (px) to talk to an NPC. Matches loot chests. */
export const NPC_INTERACT_RADIUS = 120;

registerExploreHooks();
registerLevelUpHook();

export function isQuestRateLimited(id: string): boolean {
  const now = Date.now();
  const hits = questRateLimit.get(id) || [];
  const fresh = hits.filter((t) => now - t < QUEST_RATE_WINDOW);
  fresh.push(now);
  questRateLimit.set(id, fresh);
  return fresh.length > QUEST_RATE_MAX;
}

/** Gathering clears a patch of nodes in quick presses, so it has its own, wider limit than the quest packets. */
const gatherRateLimit = new Map<string, number[]>();
const GATHER_RATE_WINDOW = 2000;
const GATHER_RATE_MAX = 10;

export function isGatherRateLimited(id: string): boolean {
  const now = Date.now();
  const fresh = (gatherRateLimit.get(id) || []).filter((t) => now - t < GATHER_RATE_WINDOW);
  fresh.push(now);
  gatherRateLimit.set(id, fresh);
  // drop the players whose last press is outside the window, so the map does not grow with every connection
  if (gatherRateLimit.size > 256) {
    for (const [key, hits] of gatherRateLimit) {
      if (now - hits[hits.length - 1]! >= GATHER_RATE_WINDOW) gatherRateLimit.delete(key);
    }
  }
  return fresh.length > GATHER_RATE_MAX;
}

const guildEditTimes = new Map<number, Map<string, number>>();
const GUILD_EDIT_INTERVAL = 1000;

/** Whether this player may make a guild edit of this kind now. A repeat inside the second is dropped without a word. */
export function guildEditOk(wt: any, kind: string): boolean {
  const id = Number(wt.data.id);
  const now = Date.now();
  let times = guildEditTimes.get(id);
  if (!times) guildEditTimes.set(id, (times = new Map()));
  if (now - (times.get(kind) ?? 0) < GUILD_EDIT_INTERVAL) return false;
  times.set(kind, now);
  return true;
}

export async function chatHearing(sender: string, channel: "party" | "guild", message: string, members: string[]): Promise<Set<string> & { muted: boolean }> {
  const me = sender.toLowerCase();
  const others = members.map((member) => String(member).toLowerCase()).filter((member) => member !== me);
  const reached = await chatAudience(sender, channel, message, others);
  return Object.assign(new Set([me, ...reached.recipients]), { muted: reached.muted });
}

/** Every online member of the guild gets the guild as their rank may see it. */
export async function pushGuild(guildId: number | null | undefined): Promise<void> {
  if (!guildId) return;
  try {
    const members = await guilds.getGuildMembers(guildId);
    const guildName = await guilds.getGuildName(guildId);
    const online: string[] = [];
    for (const member of members) {
      if (await isOnline(member)) online.push(member);
    }
    // Built once for all of them; only officer notes and each one's own rank differ.
    const packets = await guilds.packetsFor(guildId, online);
    for (const member of online) {
      await runOnPlayer(member, "guild-update", { guildId, members, guildName, packet: packets.get(member) ?? null });
    }
  } catch (error) {
    log.error(`The guild ${guildId} could not be sent to its members: ${error}`);
  }
}

/** After a kick went through: the kicked player, when online, holds no guild and is told. */
export async function kickedFromGuild(actor: any, guildId: number, kickedUsername: string): Promise<void> {
  await runOnPlayer(kickedUsername, "guild-kicked");
  listener.emit(Events.GUILD_CHANGED, { type: "kick", guildId, guildName: actor.guild_name, playerUsername: actor.username, kickedUsername });
}

registerPlayerAction("guild-update", (p, { guildId, members, guildName, packet }) => {
  // A join made on another node (the player editor): the guild name over their head changes for those who see them.
  const joined = p.guild_id !== guildId || p.guild_name !== guildName;
  p.guild_id = guildId;
  p.guild = members;
  p.guild_name = guildName;
  playerCache.set(p.id, p);
  if (packet) sendPacket(p.wt, packetManager.updateGuild(packet));
  if (joined) broadcastPlayerUpdate(p);
});
registerPlayerAction("guild-kicked", (p) => {
  sendPacket(p.wt, packetManager.updateGuild({ members: [] }));
  sendPacket(p.wt, packetManager.notify({ message: "You have been kicked from the guild" }));
  p.guild_id = null;
  p.guild = [];
  p.guild_name = null;
  playerCache.set(p.id, p);
  broadcastPlayerUpdate(p);
});
/** The guild was disbanded: `notice` for everyone but the leader who did it. */
registerPlayerAction("guild-disbanded", (p, { notice }) => {
  sendPacket(p.wt, packetManager.updateGuild({ members: [] }));
  if (notice) sendPacket(p.wt, packetManager.notify({ message: "The guild has been disbanded" }));
  p.guild_id = null;
  p.guild = [];
  p.guild_name = null;
  playerCache.set(p.id, p);
  broadcastPlayerUpdate(p);
});
/** The member is in no party now (disbanded, kicked), and told why. */
registerPlayerAction("party-cleared", async (p, { message }) => {
  sendPacket(p.wt, packetManager.updateParty({ members: [] }));
  sendPacket(p.wt, packetManager.notify({ message }));
  await partyViewChanged(p, () => {
    if (clusterEnabled()) clearParty(p);
    else p.party = [];
    playerCache.set(p.id, p);
  });
});
/** The party's members as they now are, with a notice when there is one for this member. */
registerPlayerAction("party-update", async (p, { members, notice }) => {
  sendPacket(p.wt, packetManager.updateParty({ members }));
  if (notice) sendPacket(p.wt, packetManager.notify({ message: notice }));
  await partyViewChanged(p, async () => {
    if (clusterEnabled()) {
      await trackPacket(String(p.id), () => applyPartyMembers(p, Array.isArray(members) ? members : [], (username) => parties.getPartyId(username)));
      cacheIfHeld(playerCache, p);
    } else {
      p.party = members;
      playerCache.set(p.id, p);
    }
  });
});
/** An admin disconnected (/kick) or banned (/ban) the player: their session ends and their connection is closed. */
registerPlayerAction("admin-kick", (p) => player.kick(p.username, p.wt));
async function inspectAskerAdmin(asker: unknown): Promise<boolean | null> {
  if (typeof asker !== "string" || !asker) return null;
  if (!(await isOnline(asker))) return null;
  try {
    return !!(await player.isAdmin(asker));
  } catch (error) {
    log.error(`The role of ${asker} could not be read for an inspect: ${error}`);
    return false;
  }
}
registerPlayerAction("cells-inspect", async (p, args) => {
  const asker = args?.asker;
  // The asker's own account says whether they are an admin: the asking node's word is not taken.
  const admin = await inspectAskerAdmin(asker);
  if (admin === null) return;
  // A stealthed admin is not there to anyone but admins.
  if (p.isStealth && !admin) return;
  await deliverToPlayer(String(asker), packetManager.inspectPlayer(inspectPlayerData(p, !!admin)));
});
serveItems("LOOT_OPEN", (actor, body) => {
  const opened = creatures.openCorpseFor(actor, Number(body.creatureId));
  return typeof opened === "string" ? { ok: false, reason: opened } : { ok: true, items: opened.items, copper: opened.copper };
});
/** The most places on a corpse or in a chest, and the most names of what the bags hold, that a call from a neighbouring node is believed to carry. */
const MAX_TAKE_INDICES = 64;
const MAX_HELD_NAMES = 64;
/** The most free slots a call may claim. */
const MAX_FREE_SLOTS = 1000;
/** The places a call asks to take: whole numbers from 0, each once, at most MAX_TAKE_INDICES. Null when it gives no list (it asks for all). */
function takeIndices(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const places = new Set<number>();
  for (const value of raw) {
    // A number, or the text of one: null, true and "" are not places (Number turns them into 0 and 1).
    if (typeof value !== "number" && !(typeof value === "string" && value.trim() !== "")) continue;
    const place = Number(value);
    if (Number.isInteger(place) && place >= 0) places.add(place);
    if (places.size >= MAX_TAKE_INDICES) break;
  }
  return [...places];
}
function bagRoomOf(raw: any): { free: number; held: string[] } | null {
  if (!raw || typeof raw !== "object" || !Number.isInteger(raw.free) || !Array.isArray(raw.held)) return null;
  const held = raw.held.filter((name: unknown) => typeof name === "string").slice(0, MAX_HELD_NAMES);
  return { free: Math.min(Math.max(raw.free, 0), MAX_FREE_SLOTS), held };
}
serveItems("LOOT_TAKE", async (actor, body) => {
  const room = bagRoomOf(body.room);
  if (!room) return { ok: false, reason: "failed" };
  const taken = await creatures.takeCorpseLootFor(actor, Number(body.creatureId), takeIndices(body.indices), room);
  if (typeof taken === "string") return { ok: false, reason: taken };
  return { ok: true, items: taken.taken, copper: taken.copper, empty: taken.empty, full: taken.full, remaining: taken.remaining };
});
serveItems("PICKUP_REQUEST", (actor, body) => {
  const picked = loot.pickup(actor, String(body.lootId));
  return picked.success && picked.item ? { ok: true, item: picked.item } : { ok: false, reason: picked.message };
});
serveItems("CHEST_OPEN", async (actor, body) => {
  const chestId = String(body.chestId);
  const chest = lootChest.getChest(chestId);
  if (!chest) return { ok: false, reason: "Chest not found." };
  if (bareMap(chest.map) !== bareMap(actor.location?.map)) return { ok: false, reason: "Chest is on a different map." };
  const position = actor.location.position;
  if (!lootChest.isWithinRange(chestId, position.x, position.y)) return { ok: false, reason: "You are too far from the chest." };
  const opened = await lootChest.open(chestId, String(actor.id));
  return opened ? { ok: true, items: opened.items } : { ok: false, reason: "Could not open chest." };
});
serveItems("CHEST_TAKE", async (actor, body) => {
  const chestId = String(body.chestId);
  const indices = takeIndices(body.indices);
  // write = false: the items are marked taken here and written on the player's node.
  const taken = indices
    ? await lootChest.takeItems(chestId, String(actor.id), actor.username, indices, false)
    : await lootChest.takeAllItems(chestId, String(actor.id), actor.username, false);
  if (!taken) return { ok: false, reason: "Could not take items." };
  return { ok: true, items: taken.taken, remaining: "remaining" in taken ? taken.remaining : [], allTaken: taken.allTaken };
});
/** The player logged in on another node: this old session is told and closed, and the disconnect path cleans up and saves it. */
registerPlayerAction("displaced-login", (p, args) => {
  if (p.wt?.readyState !== 1) return;
  // A login of this account elsewhere: the account is checked first, as the id may be another player's by now.
  if (args?.accountId !== undefined && Number(p.accountId) !== Number(args.accountId)) return;
  sendPacket(p.wt, packetManager.notify({ message: "You have been logged in from another location." }));
  // drain: the notice may sit in the outbox behind a write in flight; a plain close would drop it (the close is still bounded).
  p.wt.close(1000, "Logged in from another location", { drain: true });
});
/** A player on this node was changed or read in the player editor of an admin on another node. */
registerPlayerAction("cells-editor", (p, args) => trackPacket(String(p.id), () => playerEditor.ownerNodeEdit(args)));
/** The player editor took the player out of their guild, from another node. */
registerPlayerAction("guild-cleared", (p, { message }) => playerEditor.clearLiveGuild(p, message));

export const busyNote = (name: string) => packetManager.notify({ message: `${shownName(name)} is changing server node; try again` });

/** A remote admin action that never throws back to the delivery: what fails is logged here. */
export function guardedAction(name: string, action: (target: any, args: any) => Promise<void>): (target: any, args: any) => Promise<void> {
  return async (target, args) => {
    try {
      await action(target, args);
    } catch (error) {
      log.error(`The remote admin action "${name}" on ${target?.username} failed: ${error}`);
    }
  };
}

registerPlayerAction("cells-revive", guardedAction("cells-revive", (target, args) => trackPacket(String(target.id), async () => {
  const by = remoteAdminOf(args);
  if (by === null) {
    log.warn(`A remote revive of ${target.username} was dropped: it names no admin`);
    return;
  }
  if (target.handoff) {
    void deliverToPlayer(by, busyNote(target.username));
    return;
  }
  // The REVIVE command's body (src/socket/revive.ts): in place at full health, corpse, ghost and sickness cleared.
  const revived = await revivePlayer(target, reviveDeps(), () => {
    void deliverToPlayer(by, packetManager.notify({ message: `Revived ${shownName(target.username)}` }));
  });
  if (revived === "not-dead") {
    void deliverToPlayer(by, packetManager.notify({ message: `${shownName(target.username)} is not dead` }));
  }
})));

registerPlayerAction("cells-summon", guardedAction("cells-summon", (target, args) => trackPacket(String(target.id), async () => {
  const move = adminMoveOf(args, ((await assetCache.get("maps")) || []) as MapData[]);
  if (typeof move === "string") {
    log.warn(`A remote summon of ${target.username} was dropped: it brought ${move}`);
    return;
  }
  const { by, map, x, y } = move;
  const teleport = move.why === "teleport";
  if (target.handoff) {
    void deliverToPlayer(by, busyNote(target.username));
    return;
  }
  if (move.why === "summon" && target.isAdmin && !move.admins) {
    void deliverToPlayer(by, packetManager.notify({ message: "You cannot summon other admins" }));
    return;
  }
  // A /goto moves the admin who sent it, so it is they who are told; a summon is refused to the admin who asked.
  if (isHeld(target)) {
    if (!teleport) void deliverToPlayer(by, packetManager.notify({ message: heldNote(target, by) }));
    else if (target.wt) sendPacket(target.wt, packetManager.notify({ message: heldNote(target, target.username) }));
    return;
  }
  if (target.wt) {
    sendPacket(target.wt, packetManager.notify({
      message: teleport ? `Teleported to ${shownName(by)}'s location` : "You have been summoned by an admin",
    }));
  }
  await teleportPlayerWrapper(target, map, x, y);
  if (!teleport) void deliverToPlayer(by, packetManager.notify({ message: `Summoned ${shownName(target.username)} to your location` }));
})));

registerPlayerAction("cells-teleport-to", guardedAction("cells-teleport-to", (target, args) => trackPacket(String(target.id), async () => {
  const by = remoteAdminOf(args);
  if (by === null) {
    log.warn(`A remote teleport to ${target.username} was dropped: it names no admin`);
    return;
  }
  if (target.handoff) {
    void deliverToPlayer(by, busyNote(target.username));
    return;
  }
  const pos = target.location?.position;
  // The admin is moved by their own node (Deviation 21): the summon runs there with this player's point.
  const sent = await runOnPlayer(by, "cells-summon", {
    by: target.username, map: target.location.map, x: Math.round(Number(pos?.x) || 0), y: Math.round(Number(pos?.y) || 0),
    why: "teleport", admins: reverseSummonAdmins(args),
  });
  if (!sent) log.debug(`Teleport of ${by} to ${target.username}: ${by} is no longer online`);
})));

/** Says why a guild action was refused. Answers whether it went through; `changed: false` on it is a save of what was there. */
export function guildDone(wt: any, result: GuildResult): result is Extract<GuildResult, { ok: true }> {
  if (result.ok) return true;
  sendPacket(wt, packetManager.notify({ message: refusalText[result.reason] }));
  return false;
}

/** A guild or officer line's listeners and its sender, who sees their own line even when their rank may not listen. */
export function withSender(listeners: string[], sender: string): string[] {
  const me = sender.toLowerCase();
  return listeners.some((name) => String(name).toLowerCase() === me) ? listeners : [...listeners, sender];
}

/** A line to the guild's officers: everyone whose rank may listen to officer chat. */
export async function officerChat(wt: any, currentPlayer: any, message: unknown): Promise<void> {
  if (subscriptionLocked(wt, currentPlayer, "guild_chat")) return;
  if (!channelLineOk(wt, message)) return;
  const guildId = currentPlayer.guild_id;
  if (!guildId) {
    sendPacket(wt, packetManager.notify({ message: "You are not in a guild" }));
    return;
  }
  if (!(await guilds.can(currentPlayer.username, GuildPermission.OFFICER_CHAT_SPEAK))) {
    sendPacket(wt, packetManager.notify({ message: refusalText.no_permission }));
    return;
  }
  const officers = await guilds.listeners(guildId, GuildPermission.OFFICER_CHAT_LISTEN);
  const hearing = await chatHearing(currentPlayer.username, "guild", message, officers);
  const line = await chatLinksOf(message);
  for (const officer of withSender(officers, currentPlayer.username)) {
    if (!hearing.has(String(officer).toLowerCase())) continue;
    await deliverToPlayer(officer, packetManager.officerChat({
      id: wt.data.id,
      message: line.message,
      ...(line.links.length > 0 ? { links: line.links } : {}),
      username: currentPlayer.username.charAt(0).toUpperCase() + currentPlayer.username.slice(1),
    }));
  }
  if (!hearing.muted) listener.emit(Events.OFFICER_CHAT, { player: currentPlayer, message, officers, guildId } as any);
}

async function sendInvitation(from: any, toUsername: string, invitation: any): Promise<boolean> {
  // An ignore list that cannot be read holds nothing back.
  if (await ignores.blocks(toUsername, from.username).catch(() => false)) return true;
  return await deliverToPlayer(toUsername, packetManager.invitation(invitation));
}

export async function offerInvitation(from: any, toUsername: string, invitation: { action: string; message: string; originator: string; authorization: string }): Promise<boolean> {
  await invitations.add({
    action: invitation.action,
    originator: invitation.originator,
    originatorName: from.username,
    authorization: invitation.authorization,
    target: toUsername,
  });
  if (await sendInvitation(from, toUsername, invitation)) return true;
  await invitations.take(invitation.authorization);
  return false;
}

/** What /ignore and /unignore answered, sent on: the message, the list when it changed, and both friends lists when a friendship ended. */
export async function sendIgnoreAnswer(wt: any, answer: moderation.IgnoreAnswer): Promise<void> {
  sendPacket(wt, packetManager.notify({ message: answer.message }));
  if (answer.ignored) sendPacket(wt, packetManager.updateIgnores({ ignored: answer.ignored }));
  if (!answer.unfriended) return;
  const me = playerCache.get(wt.data.id);
  if (me) {
    me.friends = answer.unfriended.mine;
    playerCache.set(me.id, me);
  }
  sendPacket(wt, packetManager.updateFriends({ friends: answer.unfriended.mine }));
  await sendFriends(answer.unfriended.target, answer.unfriended.theirs);
}

/** Who a notice is for: the players on a map, its admins only, or the players who hold a permission. */
export type NoticeAudience = { map?: string; admins?: boolean; permission?: string };

/** Shows a notice to this node's players the audience names. */
function noticeHere(message: string, audience: NoticeAudience): void {
  const players = audience.map ? filterPlayersByMap(audience.map) : Object.values(playerCache.list() as Record<string, any>);
  const packet = packetManager.notify({ message });
  for (const player of players) {
    if (!player?.wt) continue;
    if (audience.admins && !player.isAdmin) continue;
    if (audience.permission && !moderation.can(player, audience.permission)) continue;
    sendPacket(player.wt, packet);
  }
}

/** Shows a notice to the players the audience names, on this node and (cluster mode) the region's other nodes. */
export function noticeRegion(message: string, audience: NoticeAudience): void {
  noticeHere(message, audience);
  void tellPeers("notice", { message, ...audience });
}

// Cluster mode: a notice sent from another node of the region, for this node's players it names.
onPeerNews("notice", (news: { message?: unknown; map?: unknown; admins?: unknown; permission?: unknown }) => {
  const message = typeof news?.message === "string" ? news.message : "";
  const map = typeof news?.map === "string" && news.map ? news.map : undefined;
  const permission = typeof news?.permission === "string" && news.permission ? news.permission : undefined;
  // A notice for everyone goes by broadcastWorld, never by this news.
  if (!message || (!map && !permission)) return;
  noticeHere(message, { map, admins: news.admins === true, permission });
});

/** Files a report from a player and answers them. The staff online who handle reports are told of one that was filed. */
export async function sendReport(wt: any, reporter: any, name: unknown, category: unknown, details: unknown): Promise<void> {
  const answer = await moderation.report(reporter, name, category, details);
  sendPacket(wt, packetManager.notify({ message: answer.message }));
  if (!answer.report) return;
  // On every node of the region: the staff may be anywhere in it.
  const notice = moderation.staffNotice(answer.report);
  noticeRegion(notice, { permission: "admin.reports" });
}

const traderNamed = (username: string) =>
  playerCache.getByUsername(username) ?? (tradeLink.partnerPeer(username) ? mirrorByUsername(username) : undefined);
export const shownName = (username: string) => username.charAt(0).toUpperCase() + username.slice(1);

const inHandoff = (player: any): boolean => !!(player?.handoff || player?.wt?.data?.handedOff);

function knownDotCaster(id: string, username: string): boolean {
  const player = playerCache.get(id) ?? mirrorPlayers.get(id);
  return !!player && typeof player.username === "string" && player.username.toLowerCase() === username.toLowerCase();
}

export function tradeRefusal(asker: any, asked: any): string | null {
  for (const player of [asker, asked]) {
    if (player?.handoff || player?.wt?.data?.handedOff) return "That player is busy.";
  }
  const reason = cannotTrade(asker, asked);
  if (reason) return reason;
  const unsubscribed = subscriptionRefusal(asker, "trade");
  if (unsubscribed) return unsubscribed;
  return busyRefusal(asker, asked);
}

/** Whether a player of this node is in a trade: one held here, or one held on a neighbouring node (cluster/tradelink.ts). */
export function isTrading(username: string): boolean {
  return trades.of(username) !== null || tradeLink.hostOf(username) !== null;
}

/** Why `asker` cannot start a trade with `asked` because one of them already trades, in words for `asker`. Null when neither does. */
function busyRefusal(asker: any, asked: any): string | null {
  if (isTrading(asker.username)) return "You are already trading.";
  if (isTrading(asked.username)) return `${shownName(asked.username)} is already trading.`;
  return null;
}

/** True, once the player has been told, when a subscription lock keeps them from `id` (systems/subscriptions.ts). */
export function subscriptionLocked(wt: any, who: any, id: string): boolean {
  const message = subscriptionRefusal(who, id);
  if (!message) return false;
  sendPacket(wt, packetManager.notify({ message }));
  return true;
}

/** Sends one of a trade's players the trade as it stands for them: here, or through the node they are on. */
async function sendTradeViewTo(trade: Trade, name: string, now = Date.now()): Promise<void> {
  const online = playerCache.getByUsername(name);
  if (online?.wt) sendPacket(online.wt, packetManager.tradeState(await trades.view(trade, name, now)));
  else if (!online && tradeLink.partnerPeer(name)) tradeLink.sendState(name, await trades.view(trade, name, now));
}

/** Sends each of a trade's players the trade as it stands for them. */
export async function sendTradeState(trade: Trade): Promise<void> {
  const now = Date.now();
  for (const name of trade.players) await sendTradeViewTo(trade, name, now);
}

function sendTradeClosed(trade: Trade, completed: boolean, messages: Record<string, string>, reload = false): void {
  for (const name of trade.players) {
    const online = playerCache.getByUsername(name);
    if (online?.wt) sendPacket(online.wt, packetManager.tradeClosed({ completed, message: messages[name] ?? "" }));
    else if (!online && tradeLink.partnerPeer(name)) tradeLink.sendClosed(name, { completed, message: messages[name] ?? "", reload });
    // The trade is over: a player of a neighbouring node is no longer a partner here.
    tradeLink.dropPartner(name);
  }
}

export async function sendBelongingsOf(online: any, fromDatabase = false): Promise<void> {
  if (!online) return;
  if (fromDatabase) await Promise.all([dropRows("inventory", online.username), dropRows("currency", online.username)]);
  online.inventory = await patchInventoryBagSlots(await inventory.get(online.username), online.username);
  online.currency = await currencySystem.get(online.username);
  playerCache.set(online.id, online);
  if (!online.wt) return;
  sendPacket(online.wt, packetManager.inventory(online.inventory, await getInventorySlots(online)));
  sendPacket(online.wt, packetManager.currency(online.currency));
}

/** After a trade's offers changed hands: each player's bags and coins as they now are. */
async function sendBelongingsAfterTrade(trade: Trade): Promise<void> {
  for (const name of trade.players) await sendBelongingsOf(playerCache.getByUsername(name));
}

async function offerInTrade(username: string, raw: unknown, tell: (message: string) => void): Promise<void> {
  const offered = await trades.offer(username, raw);
  if (offered.ok && offered.changed) {
    await sendTradeState(offered.trade);
    return;
  }
  if (!offered.ok) tell(offered.message);
  // Nothing changed: the player is sent the trade as it stands, which puts back what their window showed.
  const standing = trades.of(username);
  if (standing) await sendTradeViewTo(standing, username);
}

/** A player accepts the trade held here: from their TRADE_ACCEPT, or from their node (TP_UPDATE). */
async function acceptTrade(username: string, tell: (message: string) => void): Promise<void> {
  const accepted = await trades.accept(username, traderNamed);
  if (accepted.state === "wait") {
    tell(accepted.message);
  } else if (accepted.state === "accepted") {
    await sendTradeState(accepted.trade);
  } else if (accepted.state === "failed") {
    sendTradeClosed(accepted.trade, false, accepted.reasons);
  } else if (accepted.state === "completed") {
    const { trade, record } = accepted;
    // The swap is made: whatever happens to the reload, the windows are closed and the event is told.
    if (record) {
      try {
        await sendBelongingsAfterTrade(trade);
      } catch (error) {
        log.error(`The bags and coins of ${trade.players.join(" and ")} could not be read again after their trade: ${error}`);
      }
    }
    const said = record ? "Trade complete." : "Nothing was traded.";
    sendTradeClosed(trade, record !== null, Object.fromEntries(trade.players.map((name) => [name, said])), record !== null);
    if (record) listener.emit(Events.TRADE_COMPLETED, { trade: record });
  }
}

/** A player cancels the trade held here: from their TRADE_CANCEL, or from their node (TP_UPDATE). */
function cancelTrade(username: string): void {
  const cancelled = trades.cancel(username);
  if (!cancelled) return;
  const me = username.toLowerCase();
  sendTradeClosed(cancelled, false, Object.fromEntries(cancelled.players.map((name) =>
    [name, name === me ? "You cancelled the trade." : `${shownName(username)} cancelled the trade.`]
  )));
}

/** Ends the trade held here of a player who left: both players are told they are gone. */
function endTradeOf(username: string): void {
  const ended = trades.cancel(username);
  if (!ended) return;
  const gone = `${shownName(username)} is no longer online.`;
  sendTradeClosed(ended, false, Object.fromEntries(ended.players.map((name) => [name, gone])));
}

async function answerTradeHere(body: TradeAnswer, from: string): Promise<TradeReply> {
  const inviter = playerCache.get(String(body?.askerId ?? ""));
  if (!inviter || inviter.username.toLowerCase() !== String(body.asker).toLowerCase()) {
    return { ok: false, reason: "Unable to process invitation - user not found or has disconnected" };
  }
  const notFound: TradeReply = { ok: false, reason: "Invitation not found or has already been processed" };
  const partner = entityById(String(body.partnerId ?? ""));
  // Only the node the one who answered is on speaks for them, and nobody who is a player of this node.
  if (!partner?.remote || mirrorOwner(partner.id) !== from || String(partner.username).toLowerCase() !== String(body.partner).toLowerCase()) return notFound;
  if (playerCache.getByUsername(partner.username)) return notFound;

  const invite = inviter.invitations.find((inv: any) => inv.authorization === body.authorization);
  if (!invite || invite.action !== "TRADE_REQUEST" || invite.originator !== String(inviter.id)) return notFound;
  inviter.invitations = inviter.invitations.filter((inv: any) => inv.authorization !== body.authorization);
  playerCache.set(inviter.id, inviter);

  // Answered by someone it was not sent to: it is spent, and nothing comes of it.
  if (invite.target !== String(partner.id)) return { ok: true };
  if (!body.accepted) {
    if (inviter.wt) sendPacket(inviter.wt, packetManager.notify({ message: `${shownName(partner.username)} declined your trade request` }));
    return { ok: true };
  }
  // Things may have changed since it was asked: one walked off, or began another trade.
  const refusal = cannotTrade(partner, inviter) ?? busyRefusal(partner, inviter);
  const trade = refusal ?? trades.open(inviter, partner);
  if (typeof trade === "string") return { ok: false, reason: trade };
  tradeLink.setPartner(partner.username, from, body.stamp);
  await sendTradeState(trade);
  return { ok: true, opened: true };
}

/** Host side: what a player of a neighbouring node did to their trade held here (TP_UPDATE). */
async function updateTradeHere(body: TradeUpdate): Promise<TradeReply> {
  const told: string[] = [];
  const tell = (message: string) => {
    told.push(message);
  };
  try {
    if (body.op === "offer") await offerInTrade(body.username, body.offer, tell);
    else if (body.op === "accept") await acceptTrade(body.username, tell);
    else if (body.op === "cancel") {
      // A trade that is being swapped is not cancelled: its node is told, and waits for the end of it.
      if (trades.of(body.username)?.settling) return { ok: false, settling: true };
      cancelTrade(body.username);
    } else if (body.op === "leave") endTradeOf(body.username);
    else return { ok: false, reason: "That is not a trade action." };
  } catch (error) {
    // The link would only answer "failed" and say nothing here.
    log.error(`The trade update "${body.op}" of ${body.username} from a neighbouring node failed: ${error}`);
    return { ok: false, reason: "The trade could not be completed." };
  }
  return told.length > 0 ? { ok: false, reason: told.join(" ") } : { ok: true };
}

/** Partner side: the trade of a player of this node, as the node that holds it sent it (TP_STATE). */
function showTradeFromHost(body: TradeStateCast): void {
  const online = playerCache.getByUsername(body.username);
  if (online?.wt) sendPacket(online.wt, packetManager.tradeState(body.state as TradeView));
}

/** Partner side: the trade of a player of this node ended (TP_CLOSED). After a swap, their bags and coins are read again. */
async function closeTradeFromHost(body: TradeClosedCast): Promise<void> {
  const online = playerCache.getByUsername(body.username);
  if (!online) return;
  // Their window is closed whether or not the reload worked.
  try {
    // The host wrote these rows on its node: the copies held here are dropped before they are read again.
    if (body.reload) await sendBelongingsOf(online, true);
  } catch (error) {
    log.error(`The bags and coins of ${body.username} could not be read again after a trade: ${error}`);
  }
  if (online.wt) sendPacket(online.wt, packetManager.tradeClosed({ completed: body.completed, message: body.message }));
}

function reloadWhenSettled(username: string): void {
  if (tradeSettle.unsettledUntil(username) === null) return;
  void settled(username)
    .then(() => sendBelongingsOf(playerCache.getByUsername(username), true))
    .catch((error) => log.error(`The bags and coins of ${username} could not be read again after their lost trade settled: ${error}`));
}

async function loseTrade(body: TradeLost): Promise<void> {
  if (body.role === "host") {
    endTradeOf(body.username);
    return;
  }
  const online = playerCache.getByUsername(body.username);
  if (!online) return;
  try {
    await sendBelongingsOf(online, true);
  } catch (error) {
    log.error(`The bags and coins of ${body.username} could not be read again after a lost trade: ${error}`);
  }
  if (online.wt) sendPacket(online.wt, packetManager.tradeClosed({ completed: false, message: TRADE_UNREACHABLE }));
  reloadWhenSettled(body.username);
}

// Cluster mode: trades between a player of this node and a player of a neighbouring node (cluster/tradelink.ts).
tradeLink.setHandlers({ answer: answerTradeHere, update: updateTradeHere, state: showTradeFromHost, closed: closeTradeFromHost, lost: loseTrade });

function endSessionOf(row: any, why: string): void {
  try {
    row?.wt?.close?.(1000, why);
  } catch (error) {
    log.error(`Could not end the session of ${row?.username}: ${error}`);
  }
}

useEngineHooks({
  claimed: (p, entry, directory) => adoptOwnerEpoch(p, entry.epoch, {
    directory,
    kick: (refused) => {
      // The refused epoch is below the one the database holds, so the save at disconnect writes nothing.
      refused.ownerEpoch = entry.epoch;
      endSessionOf(refused, "Logged in from another location");
    },
  }),
  kick: (p) => endSessionOf(p, "Server is restarting"),
  lost: (p) => void tellContactsOffline(p),
});

/** How often the watch looks for players who crossed into another node's block. */
export const HANDOFF_WATCH_MS = 250;

/** The links of the running cluster while they are attached; null otherwise. */
let handoffCtx: LinkContext | null = null;

function storeUp(ctx: LinkContext | null): boolean {
  return ctx?.store?.isUp?.() !== false;
}

const handoffChecks: HandoffChecks = {
  trading: (username) => isTrading(username),
  dragged: draggedCheck(draggedPlayersMap),
  pending: (username) => playerHandoff.pending(username),
  coolingDown: (username) => playerHandoff.coolingDown(username),
  linkUp: (peer) => (handoffCtx?.calls.isUp(peer) ?? false) && storeUp(handoffCtx),
  dwellingFrom: (username, peer) => playerHandoff.dwellingFrom(username, peer),
};

export function handoffRecheck(player: any, target: string): string | null {
  return handoffBlocked(player, target, { ...handoffChecks, pending: () => false, coolingDown: () => false }, { draining: true });
}

onLinksAttached((ctx) => {
  handoffCtx = ctx;
  const watch = setInterval(() => {
    try {
      const players = Object.values(playerCache.list()) as any[];
      const picks = pickHandoffs(players, ctx.ownerAt, ctx.self, handoffChecks);
      for (const { player: p, target } of picks) {
        void playerHandoff.handOff(p, target).catch((error) => log.error(`Handoff of ${p.username} to ${target} failed: ${error}`));
      }
      prepareWalkers(players, picks, ctx.ownerAt, ctx.self, handoffChecks, walkOf, playerHandoff);
    } catch (error) {
      log.error(`Handoff watch: ${error}`);
    }
  }, HANDOFF_WATCH_MS);
  (watch as any).unref?.();
  return () => {
    clearInterval(watch);
    handoffCtx = null;
  };
});

export async function requestTrade(wt: any, asker: any, askedId: unknown): Promise<void> {
  const asked = entityById(askedId as string);
  const refusal = tradeRefusal(asker, asked);
  if (refusal) {
    sendPacket(wt, packetManager.notify({ message: refusal }));
    return;
  }

  const invite_data = {
    action: "TRADE_REQUEST",
    message: `${shownName(asker.username)} wants to trade with you`,
    originator: asker.id.toString(),
    authorization: randomBytes(16).toString(),
  };
  // One request at a time: asking again, or someone else, takes back the one before.
  asker.invitations = asker.invitations.filter((inv: any) => inv.action !== "TRADE_REQUEST");
  asker.invitations.push({
    action: invite_data.action,
    originator: invite_data.originator,
    authorization: invite_data.authorization,
    // Who it was sent to: nobody else can answer it.
    target: asked.id.toString(),
  });
  playerCache.set(asker.id, asker);

  await sendInvitation(asker, asked.username, invite_data);
  sendPacket(wt, packetManager.notify({ message: `Trade request sent to ${shownName(asked.username)}` }));
}

export async function tradeAction(wt: any, player: any, op: "offer" | "accept" | "cancel", offer?: unknown): Promise<void> {
  if (tradeLink.hostOf(player.username)) {
    if (isQuestRateLimited(`trade-relay:${player.id}`)) {
      sendPacket(wt, packetManager.notify({ message: "You are doing that too fast. Try again in a moment." }));
      const held = tradeLink.lastState(player.username);
      if (held) sendPacket(wt, packetManager.tradeState(held as TradeView));
      return;
    }
    await relayTradeUpdate(wt, player.username, op, offer);
    return;
  }
  const tell = (message: string) => sendPacket(wt, packetManager.notify({ message }));
  if (op === "offer") await offerInTrade(player.username, offer, tell);
  else if (op === "accept") await acceptTrade(player.username, tell);
  else cancelTrade(player.username);
}

/** Partner side: a player of this node acts on their trade held on a neighbouring node. What they are told comes back from it. */
async function relayTradeUpdate(wt: any, username: string, op: TradeOp, offer?: unknown): Promise<void> {
  // Read before the call: a lost trade is no longer held by then.
  const peer = tradeLink.hostOf(username);
  const reply = await tradeLink.sendUpdate(username, op, offer);
  if (!reply || reply.ok) return;
  // The end of the trade arrived while it was waited for: it was shown, and the bags were read again, as it came.
  if (reply.closed) return;
  if (reply.gone) {
    await unsettle(username, `their trade update "${op}" came back gone`, peer ?? "the node that held their trade");
    reloadWhenSettled(username);
    // Whatever became of the trade there (a swap may have been made before the link failed), the bags and coins shown are the database's.
    try {
      await sendBelongingsOf(playerCache.getByUsername(username), true);
    } catch (error) {
      log.error(`The bags and coins of ${username} could not be read again after their trade was lost: ${error}`);
    }
    sendPacket(wt, packetManager.tradeClosed({ completed: false, message: reply.reason ?? TRADE_UNREACHABLE }));
  } else if (reply.reason) sendPacket(wt, packetManager.notify({ message: reply.reason }));
}

export async function answerTradeIfAcross(wt: any, answerer: any, originator: unknown, authorization: string, response: unknown): Promise<boolean> {
  const across = entityById(originator as string);
  if (!across?.remote || !answerer) return false;
  // Each answer across is a call to another node: a client cannot send them without limit. Over the limit, it is dropped.
  if (isQuestRateLimited(String(answerer.id))) return true;
  await answerTradeAcross(wt, answerer, across, authorization, String(response).toUpperCase() === "ACCEPT");
  return true;
}

async function answerTradeAcross(wt: any, answerer: any, inviter: any, authorization: string, accepted: boolean): Promise<void> {
  const tell = (message: string) => {
    sendPacket(wt, packetManager.notify({ message }));
  };
  if (accepted) {
    const refusal = subscriptionRefusal(answerer, "trade") ?? (isTrading(answerer.username) ? "You are already trading." : null);
    if (refusal) {
      tell(refusal);
      return;
    }
  }
  const owner = mirrorOwner(inviter.id);
  if (!owner) {
    tell("Unable to process invitation - user not found or has disconnected");
    return;
  }
  const reply = await tradeLink.sendAnswer(owner, {
    asker: inviter.username,
    askerId: String(inviter.id),
    authorization: String(authorization),
    partner: answerer.username,
    partnerId: String(answerer.id),
    accepted,
  });
  if (!reply.ok && reply.reason) tell(reply.reason);
}

export async function vendorFor(wt: any, shopper: any, npcId: unknown): Promise<Npc | null> {
  const npc = (await readNpcList()).find((held) => Number(held.id) === Number(npcId));
  const reason = isTrading(shopper.username) ? "You cannot use a vendor while trading." : cannotShop(shopper, npc);
  if (reason) {
    sendPacket(wt, packetManager.vendorClosed({ message: reason }));
    return null;
  }
  return npc!;
}

export async function chatLinksOf(text: string): Promise<{ message: string; links: ChatLink[] }> {
  if (typeof text !== "string" || text.length > MAX_CHAT_LENGTH || !text.includes("[")) return { message: text, links: [] };
  const items = ((await assetCache.get("items")) || []) as Item[];
  const links = await findChatLinks(text, items, achievementDefinitions, MAX_ITEM_LINKS, getIconUrl);
  return { message: canonicalLinks(text, links), links };
}

export async function vendorStockFrom(wt: any, sent: unknown): Promise<VendorItem[]> {
  const names = (((await assetCache.get("items")) || []) as Item[]).map((item) => item.name);
  const read = readVendorItems(sent, names);
  if (read.errors.length > 0) sendPacket(wt, packetManager.notify({ message: `Vendor stock: ${read.errors.join(" ")}` }));
  return read.items;
}

/** Sends a player what a vendor stocks and what they can buy back: this opens their vendor window, or brings it up to date. */
export async function sendVendorStock(wt: any, shopper: any, npc: Npc): Promise<void> {
  sendPacket(wt, packetManager.vendorStock({
    npcId: Number(npc.id),
    name: npc.name || null,
    items: await vendors.stock(npc),
    buyback: await vendors.buybackList(shopper.username),
  }));
}

/** What a deal with a vendor answered, sent on: the player's bags, coins and vendor window when it was made, and why not when it was not. */
export async function sendVendorAnswer(wt: any, shopper: any, npc: Npc, answer: VendorAnswer, event: string): Promise<void> {
  if (!answer.ok) {
    sendPacket(wt, packetManager.notify({ message: answer.message }));
    return;
  }
  await sendBelongingsOf(shopper);
  await sendVendorStock(wt, shopper, npc);
  listener.emit(event, { player: shopper, npcId: Number(npc.id), item: answer.item, quantity: answer.quantity, coins: answer.coins });
}

listener.on(Events.SERVER_TICK, () => {
  if (trades.count === 0) return;
  for (const { trade, reasons } of trades.sweep(traderNamed)) sendTradeClosed(trade, false, reasons);
});

function endTradeOfLeaver(event: { player?: any }): void {
  const username = event?.player?.username;
  if (!username) return;
  // What they sold to vendors can no longer be bought back.
  vendors.forget(String(username));
  const peer = tradeLink.hostOf(String(username));
  if (peer) {
    const shown = tradeLink.lastState(String(username)) as Partial<TradeView> | null;
    const accepted = shown?.accepted?.mine === true || shown?.accepted?.theirs === true;
    const sent = !accepted && tradeLink.acceptSent(String(username));
    const linkDown = !(handoffCtx?.calls.isUp(peer) ?? false);
    const marked = accepted || sent || linkDown;
    if (marked) {
      const why = linkDown ? "they left their trade while the link to it was down"
        : sent ? "they left their trade with an accept on its way" : "they left their trade after an accept";
      void unsettle(String(username), why, peer)
        .catch((error) => log.error(`The bags and coins of ${username} could not be marked unsettled: ${error}`));
    }
    void tradeLink.sendUpdate(String(username), "leave")
      .then((reply) => (reply?.gone ? unsettle(String(username), "their leave from the trade came back gone", peer) : undefined))
      .catch((error) => log.error(`The leave from the trade of ${username} failed: ${error}`));
  }
  endTradeOf(String(username));
}
listener.on(Events.PLAYER_DISCONNECT, endTradeOfLeaver);
listener.on(Events.PLAYER_LOGOUT, endTradeOfLeaver);

/** Where the world's players start: the spawn the settings name, else the default map's own, else its middle. */
function worldSpawn(): { map: string; x: number; y: number } {
  const properties: any = mapPropertiesCache.find((m: any) => m.name === `${defaultMap}.json`);
  const middle = (tiles: unknown, size: unknown) => (properties ? (Number(tiles) * Number(size)) / 2 : 0);
  return {
    map: defaultMap,
    x: Number((settings as any).spawn_x ?? properties?.spawn?.x ?? middle(properties?.width, properties?.tileWidth)),
    y: Number((settings as any).spawn_y ?? properties?.spawn?.y ?? middle(properties?.height, properties?.tileHeight)),
  };
}

export function startArea(): Record<string, unknown> | null {
  const spawn = worldSpawn();
  const map = (maps as MapData[] | null)?.find((m: MapData) => m.name === `${spawn.map}.json`);
  if (!map?.data) return null;
  return {
    name: spawn.map,
    assetServerUrl: process.env.ASSET_SERVER_URL || "http://localhost:8081",
    width: map.data.width || 0,
    height: map.data.height || 0,
    tilewidth: map.data.tilewidth || 32,
    tileheight: map.data.tileheight || 32,
    tilesets: map.data.tilesets || [],
    spawnX: spawn.x,
    spawnY: spawn.y,
    // changes when the map is saved: the page's picture of the area is made again
    version: String((mapPropertiesCache as any[])?.find((m: any) => m.name === `${spawn.map}.json`)?.version ?? ""),
  };
}

/** Whether a player is casting their home item now: its cast is the one they are in. */
const castingHome = (player: any) => !!player?.casting && player.homeCastId !== undefined && player.homeCastId === player.castId;

export async function castHome(caster: any, itemName: string): Promise<void> {
  const wt = caster.wt;
  if (!wt) return;
  // Already casting: nothing happens, and nothing is said.
  if (caster.casting || playerCache.get(caster.id)?.casting) return;
  // A step breaks the cast, but a player already walking takes none.
  if (caster.moving) {
    sendPacket(wt, packetManager.notify({ message: "You must stand still to use that." }));
    return;
  }

  const from = { map: String(caster.location?.map), x: Number(caster.location?.position?.x), y: Number(caster.location?.position?.y) };
  caster.casting = true;
  caster.castOnSelf = true;
  // Broken by a step, as a spell that cannot be cast on the move is.
  caster.interruptableSpell = true;
  caster.castingSpellId = undefined;
  caster.castId = (caster.castId || 0) + 1;
  caster.homeCastId = caster.castId;
  caster.mounted = false;
  playerCache.set(caster.id, caster);
  const thisCast = caster.castId;

  globalStateRevision++;
  await sendPositionAnimation(wt, caster.location.position?.direction || "down", false, false, caster.mount_type || "unicorn", undefined, globalStateRevision, true);
  broadcastCastToAOI(caster, packetManager.castSpell({ id: caster.id, spell: itemName, time: HOME_CAST_MS / 1000 }));
  await new Promise((resolve) => setTimeout(resolve, HOME_CAST_MS));

  // Broken (they are no longer in this cast), or they left.
  const after = playerCache.get(caster.id);
  if (!after || after.castId !== thisCast || !after.casting) return;

  const here = after.location?.position;
  const moved = String(after.location?.map) !== from.map || Number(here?.x) !== from.x || Number(here?.y) !== from.y;
  if (moved || after.isDead || after.isGhost || spellEffects.isStunned(after)) {
    await interruptPlayerCast(after);
    return;
  }
  for (const held of new Set([caster, after])) {
    held.casting = false;
    held.interruptableSpell = false;
    held.homeCastId = undefined;
  }
  playerCache.set(after.id, after);
  const live = after.wt;
  if (!live) return;
  globalStateRevision++;
  await sendPositionAnimation(live, here?.direction || "down", false, false, after.mount_type || "unicorn", undefined, globalStateRevision, false);

  let to;
  try {
    to = (await homes.where(after.username)) ?? worldSpawn();
    await player.setLocation(after.id, to.map, { x: to.x, y: to.y, direction: here?.direction || "down" });
    await teleportPlayerWrapper(after, to.map, to.x, to.y);
  } catch (error) {
    log.error(`${after.username} could not be taken home: ${error}`);
    sendPacket(live, packetManager.notify({ message: "You could not be taken home. Try again." }));
    return;
  }
  // The hour starts once they are home, not before: a move that failed must not cost them the hour.
  try {
    await homes.arrive(after.username);
    sendPacket(live, packetManager.itemCooldown({ kind: "home", remaining: HOME_COOLDOWN_MS, total: HOME_COOLDOWN_MS }));
  } catch (error) {
    log.error(`The home cooldown of ${after.username} could not be started: ${error}`);
  }
  listener.emit(Events.ITEM_USED, { player: after, item: itemName, health: 0, stamina: 0, home: to });
}

/** Whether a player is gathering now: its cast is the one they are in. */
const castingGather = (player: any) => !!player?.casting && player.gatherCastId !== undefined && player.gatherCastId === player.castId;

export async function castGather(caster: any, nodeId: unknown): Promise<void> {
  const wt = caster.wt;
  if (!wt) return;
  // A node of a neighbouring node is checked there (GATHER_REQUEST); the cast still runs here.
  const started = await gathering.startGather(caster.id, nodeId);
  if (!started.ok) {
    // Already casting: nothing happens, and nothing is said.
    if (started.reason !== GATHER_REASONS.casting)sendPacket(wt, packetManager.notify({ message: started.reason }));
    return;
  }
  // a cast that began while the checks were awaited is not overwritten
  if (caster.casting || playerCache.get(caster.id)?.casting) return;

  const from = { map: String(caster.location?.map), x: Number(caster.location?.position?.x), y: Number(caster.location?.position?.y) };
  caster.casting = true;
  caster.castOnSelf = true;
  caster.interruptableSpell = true;
  caster.castingSpellId = undefined;
  caster.castId = (caster.castId || 0) + 1;
  caster.gatherCastId = caster.castId;
  caster.mounted = false;
  playerCache.set(caster.id, caster);
  const thisCast = caster.castId;

  globalStateRevision++;
  await sendPositionAnimation(wt, caster.location.position?.direction || "down", false, false, caster.mount_type || "unicorn", undefined, globalStateRevision, true);
  broadcastCastToAOI(caster, packetManager.castSpell({ id: caster.id, spell: "Gathering", time: gathering.GATHER_CAST_MS / 1000 }));
  await new Promise((resolve) => setTimeout(resolve, gathering.GATHER_CAST_MS));

  const after = playerCache.get(caster.id);
  if (!after || after.castId !== thisCast || !after.casting) return;
  const here = after.location?.position;
  const moved = String(after.location?.map) !== from.map || Number(here?.x) !== from.x || Number(here?.y) !== from.y;
  if (moved || after.isDead || after.isGhost || spellEffects.isStunned(after)) {
    await interruptPlayerCast(after);
    return;
  }
  for (const held of new Set([caster, after])) {
    held.casting = false;
    held.interruptableSpell = false;
    held.gatherCastId = undefined;
  }
  playerCache.set(after.id, after);
  const live = after.wt;
  if (!live) return;
  globalStateRevision++;
  await sendPositionAnimation(live, here?.direction || "down", false, false, after.mount_type || "unicorn", undefined, globalStateRevision, false);

  const outcome = await gathering.finishGather(after.id, started.node.id);
  if (!outcome.ok) {
    sendPacket(live, packetManager.notify({ message: outcome.reason }));
    return;
  }
  // the items are in the bags: achievements count the gather (systems/achievements), whatever the re-read below does
  listener.emit(Events.GATHER_COMPLETED, { player: after, item: outcome.item, quantity: outcome.quantity });
  // Re-read the bags, as a loot pickup does: a new item needs its full details on the client.
  after.inventory = await patchInventoryBagSlots(await inventory.get(after.username), after.username);
  playerCache.set(after.id, after);
  sendPacket(live, packetManager.inventory(after.inventory, await getInventorySlots(after)));
}

/** Breaks a player's cast home, when they are in one. */
function breakCastHome(target: any): void {
  const player = (target?.id && playerCache.get(target.id)) || target;
  // a gather (castGather) and fishing (castFish) are broken the same way
  if (!castingHome(player) && !castingGather(player) && !castingFish(player)) return;
  interruptPlayerCast(player).catch((error) => log.error(`A cast could not be broken: ${error}`));
}
// Any damage breaks it, and so does a stun. A step does too, where steps are read (MOVEXY), and dying where a death is handled.
listener.on(Events.PLAYER_DAMAGED, (event: { target?: any; damage?: number }) => {
  if (Number(event?.damage) > 0) breakCastHome(event.target);
});
listener.on(Events.PLAYER_DEBUFF_ADDED, (event: { target?: any; effectType?: string }) => {
  if (event?.effectType === "stun") breakCastHome(event.target);
});

/** Whether a player is fishing now: its cast is the one they are in (castFish). */
export const castingFish = (player: any) => !!player?.casting && player.fishCastId !== undefined && player.fishCastId === player.castId;

function drawnEquipment(target: any): any {
  return target?.equipment || null;
}

function broadcastFishing(map: unknown, data: Parameters<typeof packetManager.fishing>[0]): void {
  const packets = packetManager.fishing(data);
  const angler = playerCache.get(data.id);
  const hidden = !!(angler?.isStealth || angler?.isVanished);
  if (angler) {
    const line = angler.fishLine;
    angler.fishLine = data.state === "cast" ? { x: data.x, y: data.y, bit: false, reeled: false }
      : data.state === "bite" && line ? { ...line, bit: true }
      : data.state === "reel" && line ? { ...line, reeled: true }
      : null;
  }
  for (const p of filterPlayersByMap(String(map ?? ""))) {
    if (!p?.wt || p.wt.readyState !== 1) continue;
    if (hidden && p.id !== data.id && !p.isAdmin && !p.party?.includes(angler.username)) continue;
    sendPacket(p.wt, packets);
  }
  // Cluster mode: the viewers of the angler's mirrors see the line too (their node keeps the stealth rule above).
  relayToMirrorViewers(angler, packets, false);
}

/** Takes a player's fishing cast off them (its session already ended): the flags, then the pose. */
async function releaseFishCast(target: any): Promise<void> {
  const p = (target?.id && playerCache.get(target.id)) || target;
  if (!p) return;
  for (const held of new Set([target, p])) {
    held.casting = false;
    held.interruptableSpell = false;
    held.fishCastId = undefined;
  }
  // one who walks while fishing faces the water: the walk turns them back the way they go
  restoreWalkingFacing(p);
  playerCache.set(p.id, p);
  if (!p.wt) return;
  globalStateRevision++;
  await sendPositionAnimation(p.wt, p.location?.position?.direction || "down", !!p.moving, false, p.mount_type || "unicorn", undefined, globalStateRevision, false);
}

/** Whether a fishing player has left their line: another map, or further than FISH_WALK_RANGE from where they cast. */
function leftLine(p: any, session: { map: string; from: { x: number; y: number } }): boolean {
  const here = p?.location?.position;
  if (String(p?.location?.map ?? "").replaceAll(".json", "") !== session.map || !here) return true;
  return Math.hypot(Number(here.x) - session.from.x, Number(here.y) - session.from.y) > fishing.FISH_WALK_RANGE;
}

async function releaseFishCastAfter(target: any, castId: number, ms: number): Promise<void> {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  const p = (target?.id && playerCache.get(target.id)) || target;
  if (p && castingFish(p) && p.castId === castId) await releaseFishCast(p);
}

export async function stopFishing(target: any, holdMs = 0): Promise<void> {
  const p = (target?.id && playerCache.get(target.id)) || target;
  if (!p?.id) return;
  const ended = fishing.endSession(p.id);
  if (ended) broadcastFishing(ended.map, { id: p.id, state: "end" });
  if (!castingFish(p) && !castingFish(target)) return;
  if (holdMs > 0) await releaseFishCastAfter(p, p.castId, holdMs);
  else await releaseFishCast(p);
}

export async function castFish(caster: any, data: unknown): Promise<void> {
  const wt = caster.wt;
  if (!wt) return;
  const x = Math.round(Number((data as any)?.x)), y = Math.round(Number((data as any)?.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const refuse = (message: string) => sendPacket(wt, packetManager.notify({ message }));
  const live = playerCache.get(caster.id) || caster;
  // In another cast: nothing happens, and nothing is said.
  if ((live.casting || caster.casting) && !castingFish(live)) return;
  if (live.isDead || live.isGhost) return;
  if (spellEffects.isStunned(live)) return refuse("You can't fish while stunned.");
  if (live.pvp || creatures.combat.isInCombatWith(live.id)) return refuse("You can't fish while in combat.");
  const pos = live.location?.position;
  const map = String(live.location?.map ?? "");
  if (!pos || !map) return;
  if (Math.hypot(x - Number(pos.x), y - Number(pos.y)) > fishing.FISH_RANGE) return refuse("That is too far away to cast.");
  const spot = await fishing.spotAt(map, x, y);
  if (!spot) return refuse("You can't fish there.");
  // The weapon equipped must be one the tile names (the map editor's Fishing tab). A tile that names none is not fished.
  if (!spot.tools.length) return refuse("You can't fish there yet.");
  const tool = fishingTool(spot, live.equipment?.weapon);
  if (!tool) return refuse(`Equip ${toolsWords(spot.tools)} to fish here.`);
  const item = rollCatch(spot.catches, Math.random());
  if (!item) return refuse("You can't fish there.");
  if (!(await hasRoomFor(live.username, item))) return refuse("Your bags are full.");

  // the checks were awaited: a cast that began meanwhile or a map change wins
  const after = playerCache.get(caster.id);
  if (!after || (after.casting && !castingFish(after)) || String(after.location?.map ?? "") !== map) return;
  if (fishingTool(spot, after.equipment?.weapon) !== tool) return refuse(`Equip ${toolsWords(spot.tools)} to fish here.`);
  const here = after.location.position;
  const castId = (after.castId || 0) + 1;
  const facing = facingToward(x - Number(here.x), y - Number(here.y));
  // casting again: the old line is taken in (for the others; this player's client puts the new one in its place)
  const old = fishing.endSession(after.id);
  if (old) broadcastFishing(old.map, { id: after.id, state: "end" });
  for (const held of new Set([caster, after])) {
    held.casting = true;
    // a step does not break it (walking past FISH_WALK_RANGE does, in the tick below), and the walk keeps them turned to the water
    held.castOnSelf = false;
    held.interruptableSpell = false;
    held.castingSpellId = undefined;
    held.castId = castId;
    held.fishCastId = castId;
    held.mounted = false;
  }
  here.direction = facing;
  playerCache.set(after.id, after);
  fishing.startSession(after.id, {
    castId, map: map.replaceAll(".json", ""), from: { x: Number(here.x), y: Number(here.y) }, x, y, spot, tool, item, bitAt: 0, reeledAt: 0, timer: null,
  });

  globalStateRevision++;
  await sendPositionAnimation(after.wt || wt, facing, !!after.moving, false, after.mount_type || "unicorn", undefined, globalStateRevision, true);
  broadcastFishing(map, { id: after.id, state: "cast", x, y });
  const session = fishing.session(after.id);
  if (session && session.castId === castId) session.timer = setTimeout(() => fishBite(after.id, castId), fishing.biteDelay(Math.random()));
}

/** A fish takes the bait: the bobber goes under, for everyone on the map, and the player can reel it in. */
function fishBite(playerId: string, castId: number): void {
  const session = fishing.session(playerId);
  if (!session || session.castId !== castId) return;
  const p = playerCache.get(playerId);
  if (!p || !castingFish(p) || p.castId !== castId) {
    fishing.endSession(playerId);
    return;
  }
  session.bitAt = Date.now();
  session.reeledAt = 0;
  broadcastFishing(p.location.map, { id: playerId, state: "bite" });
  // not reeled in time: the fish lets go of the bait (fishEscape); FISH_REEL (fishReel) stops this
  session.timer = setTimeout(() => fishEscape(playerId, castId), fishing.BITE_ESCAPE_MS);
}

function fishEscape(playerId: string, castId: number): void {
  const session = fishing.session(playerId);
  if (!session || session.castId !== castId || !session.bitAt || session.reeledAt) return;
  const p = playerCache.get(playerId);
  if (!p || !castingFish(p) || p.castId !== castId) {
    fishing.endSession(playerId);
    return;
  }
  session.bitAt = 0;
  session.item = rollCatch(session.spot.catches, Math.random()) ?? session.item;
  if (p.wt) sendPacket(p.wt, packetManager.notify({ message: "The fish got away." }));
  broadcastFishing(p.location.map, { id: playerId, state: "escape" });
  session.timer = setTimeout(() => fishBite(playerId, castId), fishing.biteDelay(Math.random()));
}

export function fishReel(playerId: string): void {
  const session = fishing.session(playerId);
  if (!session || !session.bitAt || session.reeledAt) return;
  const castId = session.castId;
  session.reeledAt = Date.now();
  // the others' clients draw the line reeled from now on
  broadcastFishing(session.map, { id: playerId, state: "reel" });
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    if (fishing.session(playerId)?.castId !== castId) return;
    const now = playerCache.get(playerId);
    if (now?.wt) sendPacket(now.wt, packetManager.notify({ message: "The fish got away." }));
    stopFishing(now).catch((error) => log.error(`A fishing line could not be taken in: ${error}`));
  }, fishing.HOOKED_MAX_MS);
}

export async function landFish(caster: any): Promise<void> {
  const first = fishing.session(caster.id);
  if (!first || !first.bitAt) return;
  const castId = first.castId;
  // a land is a reel too: the fish does not get away while the land waits for MIN_REEL_MS
  fishReel(caster.id);
  const wait = first.bitAt + fishing.MIN_REEL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

  const session = fishing.session(caster.id);
  const p = playerCache.get(caster.id);
  if (!session || session.castId !== castId || !p || !castingFish(p) || p.castId !== castId) return;
  if (leftLine(p, session) || p.isDead || p.isGhost || spellEffects.isStunned(p)) {
    await interruptPlayerCast(p);
    return;
  }
  fishing.endSession(p.id);
  const item = session.item!;
  let given = false;
  try {
    given = (await hasRoomFor(p.username, item)) && await atomically([p.username], async (batch) => {
      if (!(await inventory.add(p.username, { name: item, quantity: 1 }, batch))) throw new Error(`${item} was not added`);
      return true;
    });
  } catch (error) {
    log.error(`[Fishing] ${item} could not be given to ${p.username}: ${error}`);
  }
  broadcastFishing(session.map, given ? { id: p.id, state: "catch", item, icon: fishing.iconOf(item), quality: fishing.qualityOf(item) } : { id: p.id, state: "end" });
  releaseFishCastAfter(p, castId, given ? fishing.CATCH_HOLD_MS : fishing.LINE_IN_MS).catch((error) => log.error(`A fishing cast could not be ended: ${error}`));
  const live = playerCache.get(p.id)?.wt;
  if (!live) return;
  if (!given) {
    sendPacket(live, packetManager.notify({ message: "Your bags are full. The fish got away." }));
    return;
  }
  // Re-read the bags, as a gather does: a new item needs its full details on the client.
  const after = playerCache.get(p.id) || p;
  after.inventory = await patchInventoryBagSlots(await inventory.get(after.username), after.username);
  playerCache.set(after.id, after);
  sendPacket(live, packetManager.inventory(after.inventory, await getInventorySlots(after)));
}

// Leaving the map, or dying, takes the line in too (damage and a stun break the cast as any other cast).
for (const event of [Events.MAP_ENTER, Events.PLAYER_DEATH]) {
  listener.on(event, (payload: { player?: any }) => {
    const target = payload?.player;
    if (target?.id && fishing.session(target.id)) stopFishing(target).catch((error) => log.error(`A fishing line could not be taken in: ${error}`));
  });
}
listener.on(Events.FIXED_UPDATE, () => {
  for (const [id, session] of fishing.allSessions()) {
    const p = playerCache.get(id);
    if (!p || !castingFish(p) || p.castId !== session.castId) continue;
    const rodOff = String(p.equipment?.weapon ?? "").toLowerCase() !== session.tool.toLowerCase();
    if (!rodOff && !leftLine(p, session)) continue;
    if (p.wt) sendPacket(p.wt, packetManager.notify({ message: rodOff ? `You put away your ${session.tool}.` : "You walked too far from your line." }));
    stopFishing(p).catch((error) => log.error(`A fishing line could not be taken in: ${error}`));
  }
});

async function sendMapMarkers(wt: any, map: unknown): Promise<void> {
  try {
    const name = String(map ?? "").replaceAll(".json", "");
    if (!wt || !name) return;
    const properties = await mapPropertiesOf(name);
    const npcs = await readNpcList();
    // a world made of cave systems (the underworld): the warps between them are caves too
    const world: any = getWorldMap(name);
    const layout = Array.isArray(world?.map?.data?.sections)
      ? { sections: world.map.data.sections, tileWidth: Number(world.tileWidth), tileHeight: Number(world.tileHeight) }
      : null;
    sendPacket(wt, packetManager.mapMarkers({ map: name, markers: mapMarkers(name, npcs, properties?.warps, (other) => !!getWorldMap(other), layout) }));
    await sendMailboxes(wt, name);
  } catch (error) {
    log.warn(`The minimap markers of ${map} could not be sent: ${error}`);
  }
}

/** What the loader read of a map: its warps, among others. */
async function mapPropertiesOf(name: string): Promise<any> {
  return getWorldMap(name)?.properties
    ?? (((await readHeldList("mapProperties")) || []) as any[]).find((held) => String(held?.name ?? "").replaceAll(".json", "") === name);
}

/** Sends a player where the mailboxes of a map stand. */
export async function sendMailboxes(wt: any, map: string): Promise<void> {
  sendPacket(wt, packetManager.mailboxes({ map, mailboxes: await mailboxesOf(map), iconUrl: getIconUrl("mailbox") || "" }));
}

/** What the mailbox editor is told of the world: the map its admin is on, where mailboxes stand, and which maps there are. */
export function mailboxEditorWorld(who: any): mailboxEditor.EditorWorld {
  return {
    here: standing(who).map.replaceAll(".json", ""),
    mailboxesOf: (map) => mailboxesOf(map),
    isMap: async (map) => !!getWorldMap(map) || !!(await mapPropertiesOf(map)),
    maps: async () => (((await assetCache.get("maps")) || []) as any[]).map((held) => String(held?.name ?? "")),
  };
}

async function mailboxesOf(map: unknown): Promise<Mailbox[]> {
  const name = String(map ?? "").replaceAll(".json", "");
  if (!name) return [];
  const placed = await mailboxEditor.placedOn(name);
  if (placed) return placed;
  const world = getWorldMap(name);
  const blocked = world
    ? (x: number, y: number) => world.collision.isSet(Math.floor(x / world.tileWidth), Math.floor(y / world.tileHeight)) === 1
    : undefined;
  const npcs = await readNpcList();
  return mailboxesOn(name, npcs, (await mapPropertiesOf(name))?.warps, (other) => !!getWorldMap(other), blocked);
}

/** Where a player stands. A position is kept as an object, or as "x,y". */
function standing(who: any): { map: string; x: number; y: number } {
  const position = who?.location?.position;
  const [x, y] = typeof position === "string" ? position.split(",").map(Number) : [Number(position?.x), Number(position?.y)];
  return { map: String(who?.location?.map ?? ""), x, y };
}

/** Whether a player may use their mail now: alive and at a mailbox. When not, their mail window is closed and they are told why. */
export async function mayUseMail(wt: any, who: any): Promise<boolean> {
  const at = standing(who);
  const reason = who.isDead || who.isGhost
    ? "You cannot use a mailbox while dead."
    : atMailbox(await mailboxesOf(at.map), at.x, at.y) ? null : "You are too far from a mailbox.";
  if (!reason) return true;
  sendPacket(wt, packetManager.mailClosed({ message: reason }));
  return false;
}

/** Sends a player their mail: this opens their mail window, or brings it up to date. */
export async function sendMailbox(wt: any, who: any): Promise<void> {
  sendPacket(wt, packetManager.mailInbox({ mail: await mail.inbox(who.username), postage: POSTAGE_COPPER, itemsMax: MAIL_ITEMS_MAX, subjectMax: SUBJECT_MAX, bodyMax: BODY_MAX }));
  await sendMailNotice(who);
}

/** Tells a player online how many of their mails are unread; `arrived`: and that new mail came. */
export async function sendMailNotice(who: any, arrived = false): Promise<void> {
  if (!who?.wt) return;
  const unread = await mail.unread(who.username);
  sendPacket(who.wt, packetManager.mailNotice({ unread }));
  if (arrived) sendPacket(who.wt, packetManager.notify({ message: "You have new mail." }));
}

/** As sendMailNotice, by name: the player may be online on another node in a cluster. */
export async function sendMailNoticeTo(username: string | undefined, arrived = false): Promise<void> {
  if (!username || !(await isOnline(username))) return;
  const unread = await mail.unread(username);
  await deliverToPlayer(username, [
    ...packetManager.mailNotice({ unread }),
    ...(arrived ? packetManager.notify({ message: "You have new mail." }) : []),
  ]);
}

/** An innkeeper or a vendor was added, changed or removed: everyone online is sent what the map they are on marks again. */
export async function resendMapMarkers(): Promise<void> {
  for (const online of Object.values(playerCache.list()) as any[]) {
    if (online?.wt && online.location?.map) await sendMapMarkers(online.wt, online.location.map);
  }
}

export type NpcChange = { map: string; updated?: Record<string, any>; removed?: number; markers?: boolean };

/** Shows this node's players of the map an NPC edit. */
function npcChangeHere(change: NpcChange): void {
  const packet = change.updated ? packetManager.npcUpdated(change.updated as any) : packetManager.npcRemoved(Number(change.removed));
  for (const p of filterPlayersByMap(change.map)) {
    if (p.wt && p.wt.readyState === 1) sendPacket(p.wt, packet);
  }
  if (change.markers) void resendMapMarkers();
}

/** Shows an NPC edit to the players of its map on this node and (cluster mode) the region's other nodes. */
export function npcChanged(change: NpcChange): void {
  npcChangeHere(change);
  void tellPeers("npc", change);
}

onPeerNews("npc", (news: { map?: unknown; updated?: unknown; removed?: unknown; markers?: unknown }) => {
  const map = typeof news?.map === "string" ? news.map : "";
  if (!map) return;
  const markers = news.markers === true;
  const removed = Number(news.removed);
  if (news.updated && typeof news.updated === "object") npcChangeHere({ map, updated: news.updated as Record<string, any>, markers });
  else if (Number.isInteger(removed) && removed > 0) npcChangeHere({ map, removed, markers });
});

/** What is left of a player's item cooldowns, sent when they log in so their bags and hotbar show them. */
async function sendItemCooldowns(wt: any, username: string): Promise<void> {
  const shared = consumables.cooldownLeft(username);
  if (shared > 0) sendPacket(wt, packetManager.itemCooldown({ kind: "consumable", remaining: shared, total: CONSUMABLE_COOLDOWN_MS }));
  const home = await homes.cooldownLeft(username);
  if (home > 0) sendPacket(wt, packetManager.itemCooldown({ kind: "home", remaining: home, total: HOME_COOLDOWN_MS }));
}

export async function sendQuestMarkersFor(wt: any, username: string, map: string): Promise<void> {
  try {
    const markers = await markersFor(username, String(map ?? "").replaceAll(".json", ""));
    sendPacket(wt, packetManager.questMarkers({ map: String(map ?? "").replaceAll(".json", ""), markers }));
  } catch {
    // Markers are best-effort.
  }
}

function questDefsForEntries(active: QuestLogEntry[], completed: number[]): Quest[] {
  const ids = new Set<number>([...active.map((e) => e.quest_id), ...completed]);
  const defs: Quest[] = [];
  for (const id of ids) {
    const q = questDefinitions.find(id);
    if (q) defs.push(q);
  }
  return defs;
}

export const MAX_CHAT_LENGTH = 500;
/** The longest command line read: a command is a name and a few arguments, or a chat line sent through /party, /guild or /whisper. */
export const MAX_COMMAND_LENGTH = MAX_CHAT_LENGTH + 100;
/** One RSA-4096 block is 512 bytes; this leaves room and no more. */
const MAX_CIPHERTEXT_BYTES = 1024;

export function chatRateOk(wt: any): boolean {
  const now = Date.now();
  const recent = (chatRateLimit.get(wt.data.id) || []).filter((t: number) => now - t < CHAT_RATE_WINDOW);
  if (recent.length >= CHAT_RATE_MAX) {
    chatRateLimit.set(wt.data.id, recent);
    sendPacket(wt, packetManager.notify({ message: "You are sending messages too fast." }));
    return false;
  }
  recent.push(now);
  chatRateLimit.set(wt.data.id, recent);
  return true;
}

/** A party, guild or whisper line: within the chat cap and the rate limit. When not, the player is told. */
export function channelLineOk(wt: any, message: unknown): message is string {
  if (typeof message !== "string" || !message) return false;
  if (message.length > MAX_CHAT_LENGTH) {
    sendPacket(wt, packetManager.notify({ message: `Message too long (max ${MAX_CHAT_LENGTH} characters).` }));
    return false;
  }
  return chatRateOk(wt);
}

/** Whether an encrypted chat or command line is what the client sends: a list of byte values, one RSA block long. */
export function isCiphertext(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const bytes = Object.values(value as Record<string, unknown>);
  return bytes.length > 0 && bytes.length <= MAX_CIPHERTEXT_BYTES && bytes.every((b) => Number.isInteger(b) && (b as number) >= 0 && (b as number) <= 255);
}
export const CHAT_RATE_MAX = 5;
export const CHAT_RATE_WINDOW = 3000;
export const activeEditorsByMap = new Map<string, Set<number>>();

// Track unsaved tile edits per map for syncing to new editors
export const editorEditHistory = new Map<string, Array<{ senderId: number; mapName: string; edits: any[] }>>();

import playerCache from "../services/playermanager.ts";
import layerManager, { blockOf, MAX_PLAYERS_PER_LAYER } from "../services/layermanager";
import mapIndex from "../services/mapindex";
import gameLoop from "../services/gameloop";
import { BASE_TICK_MS, TICK_MS } from "../services/tickrate";
// The warp preload scan (and NPC streaming with it) while a player walks: every 8th tick at 30 Hz, kept in time.
export const WARP_SCAN_MS = 8 * BASE_TICK_MS;
import assetCache from "../services/assetCache";
import { dropRows, refreshPlayer } from "../services/datacache";
import cooldownManager from "../services/cooldownmanager";
import effectManager from "../services/effectmanager";
// Keeps the startup load order: the handler modules, which import these, load at the first packet.
import { checkMapChangesWhenFree, followAssetServerMapChanges, pollMapChanges, onMapsChanged, takeInWorldChange, type MapChange } from "../modules/assetloader";
import { checkWorldChanges, getWorldMap } from "../modules/worldmaps";
import { onLeftChangeMissed } from "../modules/mapsaves";
// Keeps the startup load order: the handler modules, which import these, load at the first packet.
import "../modules/https_servers.ts";
import "../systems/language";
import questDefinitions from "../systems/quests/definitions";
// Keeps the startup load order: the handler modules, which import these, load at the first packet.
import "../systems/quests/log";
import { trackRadiusPlayer } from "../systems/quests/objectives";
import { markersFor } from "../systems/quests/markers";
// Keeps the startup load order: the handler modules, which import these, load at the first packet.
import "../systems/quests/editor";
import "../systems/friends";
import { registerExploreHooks } from "../systems/quests/objectives";
import { registerLevelUpHook } from "../systems/quests/markers";
import ignores from "../systems/ignores";
import * as moderation from "../systems/moderation";
import trades, { cannotTrade, type Trade, type TradeView } from "../systems/trades";
import { TRADE_UNREACHABLE, tradeLink, type TradeAnswer, type TradeClosedCast, type TradeLost, type TradeOp, type TradeReply, type TradeStateCast, type TradeUpdate } from "../cluster/tradelink";
import vendors, { cannotShop, hasRoomFor, readVendorItems, type VendorAnswer } from "../systems/vendors";
import consumables, { CONSUMABLE_COOLDOWN_MS } from "../systems/consumables";
// Keeps the startup load order: the handler modules, which import these, load at the first packet.
import "../systems/cooldowns";
import { mapMarkers } from "../systems/mapmarkers";
import mail, { atMailbox, mailboxesOn, BODY_MAX, MAIL_ITEMS_MAX, POSTAGE_COPPER, SUBJECT_MAX, type Mailbox } from "../systems/mail";
import homes, { HOME_CAST_MS, HOME_COOLDOWN_MS } from "../systems/homes";
import { audience as chatAudience } from "../systems/chatgate";
import { canonicalLinks, findChatLinks, MAX_ITEM_LINKS, type ChatLink } from "../systems/itemlinks";
import { definitions as achievementDefinitions } from "../systems/achievements/store";
import parties from "../systems/parties.ts";
import guilds from "../systems/guild.ts";
import { GuildPermission, refusalText, type GuildResult } from "../systems/guildranks";
import spells from "../systems/spells";
// Keeps the startup load order: the handler modules, which import these, load at the first packet.
import "../systems/equipment.ts";
import inventory from "../systems/inventory";
// Keeps the startup load order: the handler modules, which import these, load at the first packet.
import "../systems/particles";
import worlds from "../systems/worlds";
// Keeps the startup load order: the handler modules, which import these, load at the first packet.
import "../systems/npcs";
import { syncNpcChunks, forgetNpcStream, readNpcList, readHeldList, forgetMapGeometry } from "../systems/npcStreaming";
import spellEffects, { registerSpellEffect, cancelEffect, setStunsForPlayer, setSlowsForPlayer } from "../systems/spelleffects";
import dots from "../systems/dots";
import { spellManaCost } from "../systems/spellmath";
import creatures from "../systems/creatures";
import gathering from "../systems/gathering";
import { REASONS as GATHER_REASONS } from "../systems/gathering/service";
import fishing from "../systems/fishing";
import footprints from "../systems/footprints";
import { facingToward, fishingTool, rollCatch, toolsWords } from "../systems/fishing/catches";
import achievements from "../systems/achievements";
import collectables from "../systems/collectables";
import { projectileTravelMs } from "../systems/creatures/projectile";
// Keeps the startup load order: the handler modules, which import these, load at the first packet.
import "../systems/itemeditor";
import "../systems/mounteditor";
import "../systems/spelleditor";
import * as weatherEditor from "../systems/weathereditor";
import { TORNADO, nextCycleIn, settledPick } from "../systems/weathercycle";
import { onPeerNews, tellPeers } from "../cluster/peernews";
// Keeps the startup load order: the handler modules, which import these, load at the first packet.
import "../systems/classeditor";
import * as mailboxEditor from "../systems/mailboxeditor";
import classes from "../systems/classes";
import * as weatherApi from "../systems/weatherapi";
import * as tornadoes from "../systems/tornadoes";
// Keeps the startup load order: the handler modules, which import these, load at the first packet.
import "../systems/looteditor";
import * as playerEditor from "../systems/playereditor";
import * as controlPanel from "../systems/controlpanel";
// Keeps the startup load order: the handler modules, which import these, load at the first packet.
import "../systems/playerpick";
import { areaSpellHarms, PVP_BODY, type PvpAllowed } from "../systems/pvpzone";
import { heldNote, isHeld, refusedWhileHeld } from "../systems/cutsceneheld";
import { adopt as adoptCutscene, adoptChain as adoptCutsceneChain, setCutsceneBridge } from "../systems/cutsceneplayer";
// Keeps the startup load order: the handler modules, which import these, load at the first packet.
import "../systems/creatures/editor";
import { setCreatureEngineBridge } from "../systems/creatures/bridge";
import { spellMissChance } from "../systems/creatures/combat";
import { setPlayerDeathHandler, setMirrorZoneHitHandler, resyncZonesFor } from "../systems/groundaoe";
import bags from "../systems/bags";
import currencySystem from "../systems/currency";
// Keeps the startup load order: the handler modules, which import these, load at the first packet.
import "../controllers/sqldatabase";
import loot from "../systems/loot";
import lootChest from "../systems/lootChest";
// Keeps the startup load order: the handler modules, which import these, load at the first packet.
import "../systems/lootTable";
import skeletons from "../systems/skeletons";
import * as resurrection from "../systems/resurrection";
// Keeps the startup load order: the handler modules, which import these, load at the first packet.
import "../modules/cipher";
export const maps = await assetCache.get("maps");
export const worldsCache = await assetCache.get("worlds") as WorldData[];
export const mapPropertiesCache = await assetCache.get("mapProperties");
export const resolvedWeatherCache = new Map<string, { weather: string; weatherData: WeatherData | null }>();

import * as settings from "../config/settings.json";
import AOI_CONFIG from "../config/aoi.json";
import spatialGrid from "../services/spatialgrid";
import { randomBytes } from "../modules/hash";
import { equipmentSheetsToken, getPlayerSpriteSheetData, isSpriteSheetSystemAvailable, getIconUrl, getSpriteUrl, getMountSpriteUrl, getNpcSpriteLayers } from "../modules/spriteSheetManager";
import { notePoseCall, notePoseSelf } from "./posestats";
import { setLayerChangeHandler, initializePlayerAOI, updatePlayerAOI, shouldUpdateAOI, broadcastToAOI, broadcastPoseToAOI, broadcastToAOIBestEffort, broadcastStatsUpdateToAOI, broadcastToAOIBestEffortAtPosition, broadcastCastToAOI, clearGroundPreviewForAOI, getPlayersNearPoint, handleMapChangeAOI, syncPartyLayers, queueSpawnPlayerPacket, broadcastPlayerUpdate, sendLoadPlayersChunked, cleanupKickedSession, findPlayersWithTargetInAOI, aoiProf, updateMirrorViewers, relayToMirrorViewers, canSee } from "./aoi";
// Keeps the startup load order: the handler modules, which import these, load at the first packet.
import { leaveKickedPlayer, saveKickedPlayer } from "./server.ts";
import { realmWhitelist, isWhitelistEnabled } from "../services/whitelist";
import { restartState } from "./serverorders";
import { refusal as subscriptionRefusal } from "../systems/subscriptions";
import { deliverToPlayer, hearDeliveries, isOnline, registerPlayerAction, runOnPlayer } from "../cluster/deliver";
import { greetContacts, sendFriends, tellContactsOffline } from "./contacts";
import { clusterEnabled, nodeId } from "../cluster/config";
import { applyPartyMembers, cacheIfHeld, clearParty } from "./partystate";
import { clusterBlocks, clusterMapAdded, clusterNodes, clusterStore, useEngineHooks } from "../cluster/index";
import { adoptOwnerEpoch } from "../cluster/ownerepoch";
import { kickDuplicateSessions, sessionsOfAccount } from "../systems/logincharacter";
import { MAX_GRANT_ITEMS, grants } from "../cluster/grants";
import { playerHandoff } from "../cluster/handoff";
import { recoverLogin } from "../cluster/recovery";
import { readSnapshot } from "../cluster/snapshots";
import { handoffBlocked, pickHandoffs, prepareWalkers, type HandoffChecks } from "../cluster/handoffwatch";
import { trackPacket } from "../cluster/inflight";
import { onLinksAttached, type LinkContext } from "../cluster/linkhooks";
import { forwardTable } from "../cluster/forwarding";
import { settled, tradeSettle, unsettle } from "../cluster/tradesettle";
import { arrivedPoseRevision } from "./posedgram";
import { MAX_GAP_LATE_MS, RESUME_WALK_RECOVER_MS, RESUME_WALK_WAIT_MS, type GapApplied, type GapUpdate, type ResumeCatchUp, doneWalkOf, gapPlanOf, newerGap, resumeCatchUpMs, waitFor, walkOf, resumeSelfSpawn, adminMoveOf, arrivalFields, arrivalMaps, arrivalLimits, arrivalMount, draggedCheck, handoffStateOf, playersToDespawn, remoteAdminOf, reverseSummonAdmins, seedArrival, warpTarget } from "./arrival";
import { LiveNodeCache, routeLogin } from "../cluster/route";
import { revivePlayer, type ReviveDeps } from "./revive";
import { invitations } from "../cluster/invitations";
import { ghosts } from "../cluster/ghosts";
import { askOwner, itemOwner, serveItems } from "../cluster/remoteitems";
import { grantWrittenBefore, recordGrantWrite } from "../systems/grantwrites";
import { bagRoom, formatMoney, type LootError } from "../systems/creatures/kill";
import type { CorpseItem } from "../systems/creatures/loot";
import { bareMap, entityById, mirrorByUsername, mirrorOwner, mirrorPlayers, mirrorsNearPoint, mirrorsOnLayerNear, playerLayer } from "../cluster/mirrors";
import { refusalOf, sendPlayerHit, setPlayerHitApplier, type PlayerHit } from "../cluster/playerhits";
import { forgetVictim, recordAttack } from "../cluster/attackers";
import type { EffectResult } from "../cluster/effects";
// Keeps the startup load order: the handler modules, which import these, load at the first packet.
import "../cluster/aoievent";
import { playerGhostKind } from "../cluster/kinds/players";
export const defaultMap = (settings as any).default_map?.replace(".json", "") || "main";
/** The largest frame the server takes (webtransport.maxPayloadMB), and whether it is a benchmark server, which takes it from anyone. */
const MAX_FRAME_BYTES = 1024 * 1024 * ((settings as any)?.webtransport?.maxPayloadMB || 1);
const BENCHMARK_ENABLED = !!(settings as any)?.webtransport?.benchmarkenabled;

const useSpriteSheets = (settings as any).animation_system?.use_sprite_sheets ?? true;

export function resolveSpellParticles(spell: SpellData, particleList: Particle[] | null): Particle[] | null {
  if (!spell?.particles || !particleList || particleList.length === 0) return null;
  const names = spell.particles.split(",").map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) return null;
  const resolved = names
    .map((name) => particleList.find((p) => p.name && p.name.toLowerCase() === name.toLowerCase()))
    .filter((p): p is Particle => p != null);
  return resolved.length > 0 ? resolved : null;
}

async function getLiveWorlds(): Promise<WorldData[]> {
  const worldsResult = await assetCache.get("worlds").catch(() => worldsCache) as WorldData[] | string;
  return Array.isArray(worldsResult) ? worldsResult : JSON.parse(worldsResult as string);
}

async function resolveWorldWeather(worldName: string): Promise<{ weather: string; weatherData: WeatherData | null }> {
  const normalized = worldName.replace(".json", "");
  const worlds = await getLiveWorlds();
  const world = worlds.find((w) => w.name === normalized);
  if (!world) return { weather: "clear", weatherData: null };

  const weatherName = world.weather || "clear";

  if (weatherName === "random") {
    const cached = resolvedWeatherCache.get(normalized);
    if (cached) return cached;

    // The weather of the stretch (systems/weathercycle.ts): the one every node holding part of the world settles on.
    const randomWeather = settledPick(await assetCache.get("weather") as WeatherData[], normalized);
    if (randomWeather) {
      const resolved = { weather: randomWeather.name, weatherData: randomWeather };
      resolvedWeatherCache.set(normalized, resolved);
      return resolved;
    }
    return { weather: "clear", weatherData: null };
  }

  // The real weather is no row of the table: it is the last reading, the same for every world on it.
  if (weatherName === weatherApi.WEATHER_API) return { weather: weatherName, weatherData: weatherApi.currentWeather() };

  // "clear" has a row like any other weather (its wind still blows), and is clear without one.
  const allWeathers = await assetCache.get("weather") as WeatherData[];
  const weatherData = rowOf(allWeathers, weatherName);
  return { weather: weatherName, weatherData };
}

// "tornado" is a thunderstorm with tornadoes, a word of /weather that needs no row of the table (systems/weathercycle.ts).
export { TORNADO };
/** The name the client draws a weather by. */
const lookOf = (weather: string) => (weather === TORNADO ? "thunderstorm" : weatherApi.shownAs(weather));
/** A weather's row, a "tornado" without one taking the thunderstorm's. */
export const rowOf = (all: WeatherData[] | null | undefined, name: string): WeatherData | null =>
  all?.find((w) => w.name === name) || (name === TORNADO ? all?.find((w) => w.name === "thunderstorm") || null : null);

export const weatherShown = async (weather: string, weatherData: WeatherData | null) => {
  const look = lookOf(weather);
  let data = weather === TORNADO && weatherData ? { ...weatherData, sandstorm: true, blizzard: true } : weatherData;
  if (weather === weatherApi.WEATHER_API && data && Number(data.wind_speed) >= weatherApi.SANDSTORM_WIND) data = { ...data, blizzard: true };
  if (data && !data.sounds) data = { ...data, sounds: rowOf(await assetCache.get("weather") as WeatherData[], look)?.sounds ?? null };
  return { weather: look, weatherData: data };
};

/** Shows a world's players on this node the weather it shows now. A "random" world has settled on it. */
async function showWeatherHere(worldName: string, weatherName: string, weatherData: WeatherData | null): Promise<void> {
  // Only a "random" world has settled on a weather: it has settled on this one now.
  if (resolvedWeatherCache.has(worldName)) resolvedWeatherCache.set(worldName, { weather: weatherName, weatherData });
  const shown = await weatherShown(weatherName, weatherData);
  for (const playerId of mapIndex.getPlayersOnMap(worldName)) {
    const player = playerCache.get(playerId);
    if (player?.wt && player.wt.readyState === 1) {
      sendPacket(player.wt, packetManager.changeWeather(shown));
    }
  }
}

const weatherBridge: weatherEditor.WeatherEditorBridge = {
  worlds: async () => (await getLiveWorlds()).map((world) => ({
    name: world.name,
    weather: world.weather || "clear",
    // A "random" world is showing whichever weather it settled on.
    showing: (world.weather === "random" ? resolvedWeatherCache.get(world.name)?.weather : world.weather) || world.weather || "clear",
  })),
  // As the WEATHER command sets it.
  setWorldWeather: async (worldName, weatherName) => {
    const existingWorld = worldsCache.find((w) => w.name === worldName);
    await worlds.update({ name: worldName, weather: weatherName, players: existingWorld?.players || 0 });
    if (existingWorld) existingWorld.weather = weatherName;
    resolvedWeatherCache.delete(worldName);
    void tellPeers("weather", { world: worldName, set: weatherName });
  },
  show: async (worldName, weatherName, weatherData) => {
    await showWeatherHere(worldName, weatherName, weatherData);
    void tellPeers("weather", { world: worldName, shown: weatherName });
  },
};
weatherEditor.setWeatherEditorBridge(weatherBridge);

onPeerNews("weather", async (news: { world?: unknown; set?: unknown; shown?: unknown }) => {
  const world = typeof news?.world === "string" ? news.world : "";
  if (!world) return;
  if (typeof news.set === "string") {
    const existingWorld = worldsCache.find((w) => w.name === world);
    if (existingWorld) existingWorld.weather = news.set;
    resolvedWeatherCache.delete(world);
  }
  if (typeof news.shown === "string" && resolvedWeatherCache.has(world)) {
    resolvedWeatherCache.set(world, { weather: news.shown, weatherData: rowOf(await assetCache.get("weather") as WeatherData[], news.shown) });
  }
  const { weather, weatherData } = await resolveWorldWeather(world);
  await showWeatherHere(world, weather, weatherData);
});

void weatherApi.startWeatherApi(async (row) => {
  try {
    for (const world of await weatherBridge.worlds()) {
      // Here only: every node reads the real weather for itself.
      if (world.weather === weatherApi.WEATHER_API) void showWeatherHere(world.name, weatherApi.WEATHER_API, row);
    }
  } catch (error) {
    log.error(`Weather API: the reading could not be shown: ${error}`);
  }
}, (utcOffset) => {
  const time = packetManager.serverTime(utcOffset);
  for (const player of Object.values(playerCache.list()) as any[]) {
    if (player?.wt && player.wt.readyState === 1) sendPacket(player.wt, time);
  }
});

async function waitForSpritesReady() {
  if (!useSpriteSheets || !(await isSpriteSheetSystemAvailable())) {
    log.warn("Sprite sheet system not available");
    return;
  }
  log.success("Sprite system ready");
}

export const spriteDataCacheReady = waitForSpritesReady();

export const panelCommands = new WeakMap<object, { name: string; args: string[] }>();
const panelReplies = new Map<any, string[]>();
const PANEL_REPLY_MS = 3_000;
const PANEL_REPLY_POLL_MS = 25;

let globalStateRevision: number = 0;

/** A new revision for a state change that clients order by. Handler modules cannot write the `let` they import. */
export function bumpStateRevision(): number {
  return ++globalStateRevision;
}

/** The revision as it stands. */
export function stateRevision(): number {
  return globalStateRevision;
}

export const pluginHandlers = new Map<string, PluginHandlerFn>();

export const warpInterceptors: Array<(warp: { map: string; x: number; y: number }, wt: any, player: any, sendPacket: (wt: any, packets: any[]) => void) => Promise<boolean>> = [];

export const packetInterceptors: Array<(type: string, data: any, wt: any, player: any) => boolean> = [];

export const movementBatchQueue = new Map<string, Map<string, any>>();

const receiverSetCache = new Map<string, { revision: number; receivers: Set<string> }>();

let flushOffset = 0;
let flushTick = 0;

const movementProbeSeqs = new Map<string, number>();

const workerLayerSynced = new Set<string>();

setOnWorkerRetired((layerId: string) => {
  workerLayerSynced.delete(layerId);
});

const validPacketTypes = new Set<string>(Object.values(packetTypes) as string[]);

const DIRECTION_UNIT_OFFSETS: Record<string, { dx: number; dy: number }> = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
  upleft: { dx: -1, dy: -1 },
  upright: { dx: 1, dy: -1 },
  downleft: { dx: -1, dy: 1 },
  downright: { dx: 1, dy: 1 },
};

export const VALID_DIRECTIONS = new Set(Object.keys(DIRECTION_UNIT_OFFSETS));

const directionOffsetCache = new Map<number, Record<string, { dx: number; dy: number }>>();

export function getDirectionOffsets(speed: number): Record<string, { dx: number; dy: number }> {
  const cached = directionOffsetCache.get(speed);
  if (cached) return cached;

  const table: Record<string, { dx: number; dy: number }> = {};
  for (const key in DIRECTION_UNIT_OFFSETS) {
    const unit = DIRECTION_UNIT_OFFSETS[key];
    table[key] = { dx: unit.dx * speed, dy: unit.dy * speed };
  }

  if (directionOffsetCache.size < 64) {
    directionOffsetCache.set(speed, table);
  }
  return table;
}

const MAX_BUFFER_BACKPRESSURE = 1024 * 32; // 32KB - aggressive at high loads
const SPAWN_BACKPRESSURE_THRESHOLD = 1024 * 128; // 128KB

// Track recent flush latencies for adaptive batch scheduling
const LATENCY_HISTORY_SIZE = 5; // Keep last 5 flushes for fast recovery
const recentFlushLatencies: number[] = [];

function getAverageFlushLatency(): number {
  if (recentFlushLatencies.length === 0) return 0;
  const sum = recentFlushLatencies.reduce((a, b) => a + b, 0);
  return sum / recentFlushLatencies.length;
}

const BASE_INVENTORY_SLOTS = 25;

export async function getBagBoundaries(username: string): Promise<number[]> {
  const boundaries: number[] = [BASE_INVENTORY_SLOTS];
  const bagRow = await bags.get(username);
  if (bagRow) {
    const items = await assetCache.get("items") as Item[];
    for (const slot of bags.SLOTS) {
      const itemName = bagRow[slot];
      if (itemName) {
        const item = Array.isArray(items) ? items.find((i: any) => i.name === itemName) : null;
        const bonus = item?.bag_slots != null ? Number(item.bag_slots) : 10;
        boundaries.push(boundaries[boundaries.length - 1] + bonus);
      }
    }
  }
  return boundaries;
}

export function computeBagSlot(slot: number, boundaries?: number[]): number {
  if (slot == null || slot < BASE_INVENTORY_SLOTS) return 0;
  if (!boundaries || boundaries.length <= 1) return 0;
  for (let i = 1; i < boundaries.length; i++) {
    if (slot < boundaries[i]) return i;
  }
  return 0;
}

export async function patchInventoryBagSlots(inv: any[], username: string): Promise<any[]> {
  if (!Array.isArray(inv)) return inv;
  const boundaries = await getBagBoundaries(username);
  return inv.map((item: any) => ({
    ...item,
    bag_slot: computeBagSlot(item.slot, boundaries),
  }));
}

export async function getInventorySlots(player: any): Promise<number> {
  let slots = BASE_INVENTORY_SLOTS;
  const username = player?.username || player?.equipment?.username;
  if (username) {
    const bagRow = await bags.get(username);
    if (bagRow) {
      const items = await assetCache.get("items") as Item[];
      for (const slot of bags.SLOTS) {
        const itemName = bagRow[slot];
        if (itemName) {
          const item = Array.isArray(items) ? items.find((i: any) => i.name === itemName) : null;
          slots += item?.bag_slots != null ? Number(item.bag_slots) : 10;
        }
      }
    }
  }
  return slots;
}

const LOOP_PROBE_INTERVAL_MS = 250;
let eventLoopLagMs = 0;
const stallReporter = new StallReporter({
  thresholdMs: 1000,
  windowMs: 30_000,
  quietMs: 15 * 60_000,
  root: path.resolve("src"),
  report: (line) => log.warn(line),
});
{
  let expected = performance.now() + LOOP_PROBE_INTERVAL_MS;
  setInterval(() => {
    const now = performance.now();
    const lag = Math.max(0, now - expected);
    stallReporter.late(lag);
    eventLoopLagMs = eventLoopLagMs * 0.6 + lag * 0.4;
    expected = now + LOOP_PROBE_INTERVAL_MS;
  }, LOOP_PROBE_INTERVAL_MS);
}

export function getEventLoopLagMs(): number {
  return eventLoopLagMs;
}

export const PROFILE = process.env.BENCHMARK_PROFILE === "1" || process.env.BENCHMARK_PROFILE === "true";
export const prof = {
  moveCbCount: 0,
  collisionMs: 0,
  aoiUpdateCount: 0,
  flushCount: 0,
  flushMs: 0,
  flushReceivers: 0,
  flushSkipped: 0,
  datagramsSent: 0,
  tcCount: 0,
  tcFilterMs: 0,
  tcConeMs: 0,
  tcCreatureMs: 0,
  spawnFlushCount: 0,
  spawnFlushMs: 0,
  despawnFlushMs: 0,
  spawnQueueSeen: 0,
  collisionBlocks: 0,
  collisionReasons: {} as Record<string, number>,
};
if (PROFILE) {
  setInterval(() => {
    const movers = prof.moveCbCount;
    const line =
      `[profile] lag=${eventLoopLagMs.toFixed(1)}ms flushInterval=${getAdaptiveBatchInterval()}ms | ` +
      `move: ${movers} cb/5s (collision ${prof.collisionMs.toFixed(0)}ms sync) | ` +
      `aoi: ${prof.aoiUpdateCount} upd | ` +
      `flush: ${prof.flushCount}x, ${prof.flushMs.toFixed(0)}ms total, ${prof.flushReceivers} recv, ${prof.flushSkipped} skipped, ${prof.datagramsSent} dgrams | ` +
      `spawnflush: ${prof.spawnFlushCount}x, ${prof.spawnFlushMs.toFixed(0)}ms spawn + ${prof.despawnFlushMs.toFixed(0)}ms despawn, queue seen ${prof.spawnQueueSeen} | ` +
      `collblocks: ${prof.collisionBlocks} ${JSON.stringify(prof.collisionReasons)} | ` +
      `targetclosest: ${prof.tcCount}x, filter ${prof.tcFilterMs.toFixed(0)}ms, cone ${prof.tcConeMs.toFixed(0)}ms, creature ${prof.tcCreatureMs.toFixed(0)}ms`;
    log.info(line);
    if (aoiProf.calls > 0) {
      log.info(
        `[profile:aoi] ${aoiProf.calls} upd | filter ${aoiProf.filterMs.toFixed(0)}ms, entered-loop ${aoiProf.enteredLoopMs.toFixed(0)}ms, exited-loop ${aoiProf.exitedLoopMs.toFixed(0)}ms | ` +
        `candidates avg ${(aoiProf.candidateTotal / aoiProf.calls).toFixed(1)} max ${aoiProf.maxCandidates}, ` +
        `entered ${aoiProf.enteredTotal}, exited ${aoiProf.exitedTotal}`
      );
    }
    aoiProf.calls = aoiProf.filterMs = aoiProf.enteredLoopMs = aoiProf.exitedLoopMs = aoiProf.tailMs = 0;
    aoiProf.candidateTotal = aoiProf.enteredTotal = aoiProf.exitedTotal = aoiProf.maxCandidates = 0;
    prof.moveCbCount = prof.collisionMs = 0;
    prof.aoiUpdateCount = 0;
    prof.flushCount = prof.flushMs = prof.flushReceivers = prof.flushSkipped = prof.datagramsSent = 0;
    prof.tcCount = prof.tcFilterMs = prof.tcConeMs = prof.tcCreatureMs = 0;
    prof.spawnFlushCount = prof.spawnFlushMs = prof.despawnFlushMs = prof.spawnQueueSeen = 0;
    prof.collisionBlocks = 0;
    prof.collisionReasons = {};
  }, 5000).unref();
}

export async function takeInMapChange(change: MapChange): Promise<void> {
  const name = change.name;
  clearMapCache(name);
  fishing.forgetMap(name);
  forgetMapGeometry(name);
  editorEditHistory.delete(name);
  if (change.added) {
    const props = mapPropertiesCache.find((m: any) => m.name === `${name}.json`);
    if (props) {
      try {
        await clusterMapAdded(name, props.width * props.tileWidth, props.height * props.tileHeight);
      } catch (error: any) {
        log.warn(`Map ${name} could not join the region's maps: ${error?.message ?? error}`);
      }
    }
  }
  await refreshPlayersOnMap(name);
}

export async function refreshPlayersOnMap(mapName: string): Promise<void> {
  for (const p of filterPlayersByMap(mapName)) {
    if (!p?.wt || (CELLS_ON && inHandoff(p))) continue;
    const position = p.location?.position;
    try {
      await transitionPlayerToMap(
        p,
        mapName,
        { x: Number(position?.x) || 0, y: Number(position?.y) || 0, direction: position?.direction || "down" },
        p.wt,
        spawnBatchQueue,
        despawnBatchQueue
      );
    } catch (error: any) {
      log.warn(`${p.username ?? p.id} could not load ${mapName} again: ${error?.message ?? error}`);
    }
  }
}

onMapsChanged(async (changes) => {
  for (const change of changes) await takeInMapChange(change);
});

async function takeInWorldChanges(): Promise<void> {
  for (const world of await checkWorldChanges()) {
    await takeInWorldChange(world);
    const propsList = await assetCache.get("mapProperties");
    const props = propsList?.find((m: any) => m.name === world.name);
    if (props && world.properties) {
      props.warps = world.properties.warps;
      props.graveyards = world.properties.graveyards;
      props.version = world.properties.version;
      await assetCache.add("mapProperties", propsList);
    }
    log.info(`World ${world.id} changed on the asset server: collision, warps, graveyards and objects updated`);
    await takeInMapChange({ name: world.id, added: false });
  }
}
{
  const seconds = Number(process.env.WORLD_SYNC_INTERVAL ?? 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    followAssetServerMapChanges({
      worldsChanged: takeInWorldChanges,
      legacy: () => {
        setInterval(async () => {
          try {
            await pollMapChanges();
          } catch (error: any) {
            log.warn(`Map change check failed: ${error?.message ?? error}`);
          }
          try {
            await takeInWorldChanges();
          } catch (error: any) {
            log.warn(`World change check failed: ${error?.message ?? error}`);
          }
        }, seconds * 1000).unref();
      },
    });
  }
}

onLeftChangeMissed(async (name) => {
  try {
    if (getWorldMap(name)) await takeInWorldChanges();
    else await checkMapChangesWhenFree();
  } catch (error: any) {
    log.warn(`The change to ${name} left to a save that did not save could not be taken in: ${error?.message ?? error}`);
  }
});

const movementVolume = new MovementVolume();
let movementHighVolume = false;
setInterval(() => { movementHighVolume = movementVolume.sample(); }, 1000).unref();

function getAdaptiveBatchInterval(): number {
  const avgLatency = getAverageFlushLatency();
  const lag = eventLoopLagMs;

  if (lag > 120) return 150; // loop badly behind - ~7 Hz, let it recover
  if (lag > 60) return 100;  // ~10 Hz
  if (lag > 30) return 66;   // ~15 Hz

  const floor = movementHighVolume ? 50 : 0;

  // Loop is healthy; pace off flush latency, but never below the sliding floor.
  if (avgLatency < 15) {
    return floor;
  } else if (avgLatency < 25) {
    return 66; // ~15 Hz
  } else if (avgLatency < 40) {
    return 85; // ~12 Hz
  } else if (avgLatency < 50) {
    return 100; // 10 Hz
  } else {
    return 120; // ~8 Hz - maximum stability
  }
}

/** One movement flush, `backoffMs` (0: none) after the last at most: see afterTickFlush. */
async function flushMovementBatches(backoffMs: number = 0) {
  const startTime = Date.now();
  movementVolume.flushed();
  const _profStart = PROFILE ? performance.now() : 0;

  const avgLatency = getAverageFlushLatency();

  let skippedDueToLoad = 0;

  const movementTick = flushTick++;
  // How many flushes a far mover waits, at the spacing the flushes are running at (one a tick, or the back-off's).
  const farEvery = farUpdateEvery(Math.max(TICK_MS, backoffMs));

  // Queue management based on latency
  const MAX_BATCH_QUEUE_SIZE = avgLatency > 40 ? 800 : (avgLatency > 25 ? 1200 : 2000);

  if (movementBatchQueue.size > MAX_BATCH_QUEUE_SIZE) {
    const dropRate = avgLatency > 40 ? 0.15 : (avgLatency > 25 ? 0.08 : 0.05);
    const toDrop = Math.floor(MAX_BATCH_QUEUE_SIZE * dropRate);
    const keys = Array.from(movementBatchQueue.keys());
    for (let i = 0; i < toDrop; i++) {
      movementBatchQueue.delete(keys[i]);
    }
  }

  for (const [groupKey, playerMovements] of movementBatchQueue.entries()) {
    if (playerMovements.size === 0) continue;

    const allPlayers = playerCache.list();

    const groupReceiverIds = collectGroupReceivers(playerMovements.keys(), aoiReverse.getViewers);

    const receiverSets = new Map<string, Set<string>>();
    const changedSets: ReceiverDiff[] = [];

    for (const playerId of groupReceiverIds) {
      const player = allPlayers[playerId];
      if (!player || !player.aoi) continue;

      const revision = player.aoi.revision || 0;
      const cached = receiverSetCache.get(playerId);
      if (cached && cached.revision === revision) {
        receiverSets.set(playerId, cached.receivers);
        continue;
      }

      const receivers = new Set<string>([playerId]);
      if (player.aoi.playersInAOI) {
        for (const aoiPlayerId of player.aoi.playersInAOI) {
          receivers.add(aoiPlayerId as string);
        }
      }
      receiverSets.set(playerId, receivers);
      receiverSetCache.set(playerId, { revision, receivers });

      const oldSet = cached?.receivers;
      if (!oldSet) {
        changedSets.push({ playerId, add: [...receivers], remove: [] });
      } else {
        const add: string[] = [];
        for (const id of receivers) {
          if (!oldSet.has(id)) add.push(id);
        }
        const remove: string[] = [];
        for (const id of oldSet) {
          if (!receivers.has(id)) remove.push(id);
        }
        if (add.length > 0 || remove.length > 0) {
          changedSets.push({ playerId, add, remove });
        }
      }
    }

    const movers: MoverSnapshot[] = [];
    for (const [movingPlayerId, movementData] of playerMovements.entries()) {
      // A mirror (cluster mode) moves for the viewers here like a local walker; it is not in the cache.
      const movingPlayer = allPlayers[movingPlayerId] ?? entityById(movingPlayerId);
      if (!movingPlayer || !movingPlayer.aoi) continue;
      movers.push({
        id: movingPlayerId,
        x: movementData.d?.x ?? movingPlayer.location.position.x,
        y: movementData.d?.y ?? movingPlayer.location.position.y,
        direction: movementData.d?.dr ?? movingPlayer.location.position.direction ?? "down",
        stealth: !!(movementData.isStealth || movingPlayer.isStealth),
        vanished: !!movingPlayer.isVanished,
        party: movingPlayer.party || [],
        final: !!movementData.f,
      });
    }

    let sentCount = 0;
    let processedReceivers = 0;

    const maxReceiversPerFlush =
      eventLoopLagMs > 60 ? 100 : eventLoopLagMs > 30 ? 300 : Number.MAX_SAFE_INTEGER;

    const receiverArray = Array.from(receiverSets.entries());
    const startIndex = flushOffset % Math.max(receiverArray.length, 1);

    const useWorker = (layerManager.getLayerInfo(groupKey)?.playerCount ?? receiverArray.length) > 20;

    let workerDiffs: ReceiverDiff[] = [];
    if (useWorker) {
      if (!workerLayerSynced.has(groupKey)) {
        const snapshotIds = new Set<string>(
          groupKey.includes(":layer_") ? layerManager.getPlayersInLayer(groupKey) : mapIndex.getPlayersOnMap(groupKey)
        );
        for (const playerId of receiverSets.keys()) snapshotIds.add(playerId);
        for (const playerId of snapshotIds) {
          const cachedEntry = receiverSetCache.get(playerId);
          if (cachedEntry) {
            workerDiffs.push({ playerId, add: [...cachedEntry.receivers], remove: [], replace: true });
          }
        }
        workerLayerSynced.add(groupKey);
      } else {
        workerDiffs = changedSets;
      }
    }

    const selectedReceiverIds: string[] = [];
    const selectedSets = new Map<string, Set<string>>();
    const receiverInfo: Record<string, ReceiverInfo> = {};

    for (let i = 0; i < receiverArray.length; i++) {
      const [receiverId, receiversForPlayer] = receiverArray[(startIndex + i) % receiverArray.length];

      const isSelfReceiver = playerMovements.has(receiverId);
      if (!isSelfReceiver && processedReceivers >= maxReceiversPerFlush) {
        skippedDueToLoad++;
        continue;
      }
      if (!isSelfReceiver) {
        processedReceivers++;
      }

      const receiver = allPlayers[receiverId];
      if (!receiver || !receiver.wt || receiver.wt.readyState !== 1) continue;

      selectedReceiverIds.push(receiverId);
      selectedSets.set(receiverId, receiversForPlayer);
      receiverInfo[receiverId] = {
        x: receiver.location?.position?.x ?? 0,
        y: receiver.location?.position?.y ?? 0,
        isAdmin: !!receiver.isAdmin,
        username: receiver.username || "",
        targetId: receiver.selectedPlayerId != null ? String(receiver.selectedPlayerId) : undefined,
        seq: movementProbeSeqs.get(receiverId) ?? 0,
        selfId: receiverId,
      };
    }

    if (PROFILE) prof.flushReceivers += selectedReceiverIds.length;

    if (selectedReceiverIds.length > 0) {
      if (useWorker) {
        const allPlayersRef = allPlayers;
        queueLayerWorkerFlush(groupKey, {
          tick: movementTick,
          farEvery,
          movers,
          receiverIds: selectedReceiverIds,
          receiverInfo,
          diffs: workerDiffs,
          onBatches: (batches, updatedSeqs, volume) => {
            movementVolume.add(volume ?? 0);
            if (updatedSeqs) {
              for (const [receiverId, seq] of Object.entries(updatedSeqs)) {
                movementProbeSeqs.set(receiverId, seq);
              }
            }
            for (const batch of batches) {
              const receiver = allPlayersRef[batch.receiverId];
              if (!receiver?.wt || receiver.wt.readyState !== 1) continue;

              try {
                const data = batch.data;
                const parts: Uint8Array[] = [];
                for (let i = 0; i < batch.offsets.length - 1; i++) {
                  const start = batch.offsets[i];
                  const end = batch.offsets[i + 1];
                  parts.push(new Uint8Array(data.buffer, data.byteOffset + start, end - start));
                }
                if (parts.length === 1) {
                  receiver.wt.send(parts[0]);
                } else if (parts.length > 1) {
                  receiver.wt.sendMovementBatch(parts);
                }
                if (PROFILE) prof.datagramsSent += parts.length;
                sentCount++;
              } catch (error: any) {
                log.debug(`Movement batch send to ${batch.receiverId} failed: ${error?.message || error}`);
              }
            }
          },
        });
      } else {
        workerLayerSynced.delete(groupKey);

        const moverIndex = indexMovers(movers);
        for (const receiverId of selectedReceiverIds) {
          const receiver = allPlayers[receiverId];
          if (!receiver?.wt || receiver.wt.readyState !== 1) continue;

          try {
            const tally: EntryTally = { full: 0, far: 0 };
            const entries = collectReceiverEntries(selectedSets.get(receiverId)!, movers, receiverInfo[receiverId], movementTick, NEAR_TIER_DISTANCE, farEvery, moverIndex, tally);
            movementVolume.add(batchVolume(tally));
            if (entries.length === 0) continue;

            const receiverProbeSeq = movementProbeSeqs.get(receiverId) ?? 0;
            const { data, offsets } = encodeBatch(entries, { seq: receiverProbeSeq, serverSendTime: Date.now() });
            movementProbeSeqs.set(receiverId, receiverProbeSeq + (offsets.length - 1));
            const parts: Uint8Array[] = [];
            for (let i = 0; i < offsets.length - 1; i++) {
              const start = offsets[i];
              const end = offsets[i + 1];
              parts.push(new Uint8Array(data.buffer, data.byteOffset + start, end - start));
            }
            if (parts.length === 1) {
              receiver.wt.send(parts[0]);
            } else if (parts.length > 1) {
              receiver.wt.sendMovementBatch(parts);
            }
            if (PROFILE) prof.datagramsSent += parts.length;
            sentCount++;
          } catch (error: any) {
            log.debug(`Movement batch send to ${receiverId} failed: ${error?.message || error}`);
          }
        }
      }
    }

    flushOffset += Math.max(processedReceivers, 1);
  }

  movementBatchQueue.clear();

  // Track this flush's latency
  const flushLatency = Date.now() - startTime;
  recentFlushLatencies.push(flushLatency);
  if (recentFlushLatencies.length > LATENCY_HISTORY_SIZE) {
    recentFlushLatencies.shift();
  }

  if (PROFILE) {
    prof.flushCount++;
    prof.flushMs += performance.now() - _profStart;
    prof.flushSkipped += skippedDueToLoad;
  }
}

export const spawnBatchQueue = new Map<string, Map<string, any>>();

const SPRITE_CACHE_MAX = 5000;
const spriteDataCache = new Map<string, any>();
const animationDataCache = new Map<string, any>();

export function queueSpawnForReceivers(spawnedPlayer: any, receivers: any[], spriteData: any = null) {
  const spawnData = queueSpawnPlayerPacket(spawnedPlayer);
  if (!spawnData) return;
  if (spriteData) spawnData.spriteData = spriteData;

  for (const receiver of receivers) {
    if (!receiver || !receiver.wt || receiver.id === spawnedPlayer.id) continue;
    if (!spawnBatchQueue.has(receiver.id)) spawnBatchQueue.set(receiver.id, new Map());
    spawnBatchQueue.get(receiver.id)!.set(spawnedPlayer.id, spawnData);
  }
}

export async function partyViewChanged(p: any, change: () => unknown): Promise<void> {
  const hidden: { other: any; held: () => any }[] = [];
  for (const id of p?.aoi?.playersInAOI ?? []) {
    const mirror = mirrorPlayers.get(String(id));
    const local = !mirror && String(id) !== String(p.id) ? playerCache.get(id) : undefined;
    const other = mirror || local;
    if (other && (other.isStealth || other.isVanished)) {
      hidden.push({ other, held: mirror ? () => mirrorPlayers.get(String(id)) : () => playerCache.get(id) });
    }
  }
  const before = hidden.map(({ other }) => canSee(p, other));
  await change();
  if (!p?.wt) return;
  hidden.forEach(({ other: mirror, held }, i) => {
    // Gone, or out of view, while the change ran.
    if (held() !== mirror || !p.aoi?.playersInAOI?.has(mirror.id)) return;
    const shown = canSee(p, mirror);
    if (shown === before[i]) return;
    if (shown) {
      const spawnData = queueSpawnPlayerPacket(mirror);
      if (!spawnData) return;
      despawnBatchQueue.get(p.id)?.delete(mirror.id);
      if (!spawnBatchQueue.has(p.id)) spawnBatchQueue.set(p.id, new Map());
      spawnBatchQueue.get(p.id)!.set(mirror.id, spawnData);
    } else {
      spawnBatchQueue.get(p.id)?.delete(mirror.id);
      if (!despawnBatchQueue.has(p.id)) despawnBatchQueue.set(p.id, new Set());
      despawnBatchQueue.get(p.id)!.add(mirror.id);
    }
  });
}

async function flushSpawnBatches() {
  if (spawnBatchQueue.size === 0) return;

  const allPlayers = playerCache.list();

  const spawnJsonCache = new Map<string, string>();
  const animJsonCache = new Map<string, { json: string; signature: string }>();

  await flushSpawnQueue(
    spawnBatchQueue,
    (receivingPlayerId, claimed) => flushOneSpawnBatch(receivingPlayerId, claimed, allPlayers, spawnJsonCache, animJsonCache),
    SPAWN_FLUSH_CONCURRENCY
  );
}

async function flushOneSpawnBatch(
  receivingPlayerId: string,
  claimed: Map<string, any>,
  allPlayers: Record<string, any>,
  spawnJsonCache: Map<string, string>,
  animJsonCache: Map<string, { json: string; signature: string }>
): Promise<void> {
  const receivingPlayer = allPlayers[receivingPlayerId];

  if (!receivingPlayer || !receivingPlayer.wt || receivingPlayer.wt.readyState !== 1) {
    return;
  }

  const spawnsForThisPlayer = Array.from(claimed.values());

  if (receivingPlayer.wt.getFreshQueuedBytes() > SPAWN_BACKPRESSURE_THRESHOLD) {
    requeueSpawnBatch(spawnBatchQueue, receivingPlayerId, claimed);
    return;
  }

  if (spawnsForThisPlayer.length > 0) {
    // 10 a flush, and 50 while the receiver has a long queue behind it (a login wave), so the queue drains.
    const maxSpawns = spawnsPerFlush(spawnsForThisPlayer.length);
    const batchToSend = spawnsForThisPlayer.slice(0, maxSpawns);
    const remaining = spawnsForThisPlayer.slice(maxSpawns);

    const playersWithSprites = await Promise.all(
      batchToSend.map(async (queuedPlayer) => {
        // A mirror (cluster mode) is drawn from its record: it is not in the cache.
        const fullPlayer = allPlayers[queuedPlayer.id] ?? entityById(queuedPlayer.id);
        if (!fullPlayer) {
          return { ...queuedPlayer, spriteData: null };
        }

        const animationName = getAnimationNameForDirection(
          fullPlayer.location.position?.direction || "down",
          !!fullPlayer.moving,
          !!fullPlayer.mounted,
          fullPlayer.mount_type,
          !!fullPlayer.casting
        );

        const spriteCacheKey = `${queuedPlayer.id}:${animationName}:${fullPlayer.equipmentRevision || 0}`;
        let playerSpriteData = spriteDataCache.get(spriteCacheKey);
        if (playerSpriteData === undefined) {
          playerSpriteData = await getPlayerSpriteSheetData(animationName, fullPlayer.equipment || null);
          setBounded(spriteDataCache, spriteCacheKey, playerSpriteData, SPRITE_CACHE_MAX);
        }

        const mountSpriteForBatch = fullPlayer.mount_type ? getMountSpriteUrl(fullPlayer.mount_type) : null;

        let spriteData = null;
        if (playerSpriteData?.bodySprite || playerSpriteData?.headSprite || mountSpriteForBatch) {
          // Sprite URLs are now sent to the client, which fetches them from the asset server
          spriteData = {
            mountSprite: mountSpriteForBatch,
            bodySprite: playerSpriteData.bodySprite || null,
            headSprite: playerSpriteData.headSprite || null,
            armorHelmetSprite: playerSpriteData.armorHelmetSprite || null,
            armorShoulderguardsSprite: playerSpriteData.armorShoulderguardsSprite || null,
            armorNeckSprite: playerSpriteData.armorNeckSprite || null,
            armorHandsSprite: playerSpriteData.armorHandsSprite || null,
            armorChestSprite: playerSpriteData.armorChestSprite || null,
            armorFeetSprite: playerSpriteData.armorFeetSprite || null,
            armorLegsSprite: playerSpriteData.armorLegsSprite || null,
            armorWeaponSprite: playerSpriteData.armorWeaponSprite || null,
            animationState: playerSpriteData.animationState,
          };
        }

        return {
          ...queuedPlayer,
          spriteData: spriteData,
        };
      })
    );

    const playerJsonParts = playersWithSprites.map((spawnData) => {
      let json = spawnJsonCache.get(spawnData.id);
      if (json === undefined) {
        json = JSON.stringify(spawnData);
        spawnJsonCache.set(spawnData.id, json);
      }
      return json;
    });

    // The viewer's client builds these players anew: what it held of them before no longer counts (socket/looks.ts).
    for (const spawnData of playersWithSprites) forgetLook(receivingPlayer.wt, spawnData.id);

    const SPAWN_CHUNK_SIZE = 8;
    for (let i = 0; i < playerJsonParts.length; i += SPAWN_CHUNK_SIZE) {
      sendPacket(receivingPlayer.wt, packetManager.loadPlayersJson(
        playerJsonParts.slice(i, i + SPAWN_CHUNK_SIZE),
        globalStateRevision
      ));
    }

    const animationPromises = playersWithSprites.map(async (spawnData) => {
      const spawnedPlayer = allPlayers[spawnData.id] ?? entityById(spawnData.id);
      if (!spawnedPlayer) {
        return null;
      }

      const animationName = getAnimationNameForDirection(
        spawnedPlayer.location?.position?.direction || "down",
        spawnedPlayer.moving,
        spawnedPlayer.mounted,
        spawnedPlayer.mount_type,
        spawnedPlayer.casting || false
      );

      const fullPlayer = spawnedPlayer;
      const equipRev = fullPlayer?.equipmentRevision || 0;
      const animCacheKey = `${spawnData.id}:${animationName}:${equipRev}`;
      let animData = animationDataCache.get(animCacheKey);
      if (animData === undefined) {
        animData = await getAnimationData(animationName, spawnData.id);
        setBounded(animationDataCache, animCacheKey, animData, SPRITE_CACHE_MAX);
      }
      return animData;
    });

    const animationDataArray = (await Promise.all(animationPromises)).filter(a => a !== null);

    if (animationDataArray.length > 0) {
      const animEntries = animationDataArray.map((animData) => {
        const key = String(animData.id);
        let entry = animJsonCache.get(key);
        if (entry === undefined) {
          entry = { json: JSON.stringify(animData), signature: lookSignature(animData) };
          animJsonCache.set(key, entry);
        }
        return { id: key, entry };
      });
      const queued = sendPacketQueued(receivingPlayer.wt, packetManager.batchSpriteSheetAnimationJson(animEntries.map((e) => e.entry.json)));
      if (queued) for (const { id, entry } of animEntries) noteLook(receivingPlayer.wt, id, entry.signature);
    }

      const remainder = new Map<string, any>();
      for (const r of remaining) {
        remainder.set(r.id, r);
      }
      requeueSpawnBatch(spawnBatchQueue, receivingPlayerId, remainder);
  }
}

export const despawnBatchQueue = new Map<string, Set<string>>();

function flushDespawnBatches() {
  if (despawnBatchQueue.size === 0) return;

  const allPlayers = playerCache.list();

  for (const receivingPlayerId of Array.from(despawnBatchQueue.keys())) {
    const claimed = claimDespawnEntry(despawnBatchQueue, receivingPlayerId);
    if (!claimed || claimed.size === 0) continue;

    const receivingPlayer = allPlayers[receivingPlayerId];

    if (!receivingPlayer || !receivingPlayer.wt || receivingPlayer.wt.readyState !== 1) continue;

    if (receivingPlayer.wt.bufferedAmount > MAX_BUFFER_BACKPRESSURE) {
      requeueDespawnEntry(despawnBatchQueue, receivingPlayerId, claimed);
      continue;
    }

    const despawnsArray = Array.from(claimed);

    if (despawnsArray.length > 0) {

      const despawnData = despawnsArray.map(playerId => ({ id: playerId, reason: "disconnect" }));
      for (const playerId of despawnsArray) forgetLook(receivingPlayer.wt, playerId);
      sendPacket(receivingPlayer.wt, packetManager.batchDisconnectPlayer(despawnData));
    }

  }
}

// Movement is flushed by the game loop, once per tick, apart from spawns and despawns.
const flushMovementAfterTick = afterTickFlush(flushMovementBatches, getAdaptiveBatchInterval);

const SPAWN_FLUSH_INTERVAL = 50;
let spawnFlushTimer: ReturnType<typeof setTimeout> | null = null;

async function scheduleSpawnFlush() {
  try {
    const _qSize = PROFILE ? spawnBatchQueue.size : 0;
    const _s1 = PROFILE ? performance.now() : 0;
    flushDespawnBatches();
    if (PROFILE) {
      prof.despawnFlushMs += performance.now() - _s1;
    }
    const _s2 = PROFILE ? performance.now() : 0;
    await flushSpawnBatches();
    if (PROFILE) {
      prof.spawnFlushCount++;
      prof.spawnFlushMs += performance.now() - _s2;
      prof.spawnQueueSeen += _qSize;
    }
  } catch (error) {
    // Silently ignore batch flush errors
  } finally {
    if (spawnFlushTimer) clearTimeout(spawnFlushTimer);
    spawnFlushTimer = setTimeout(scheduleSpawnFlush, SPAWN_FLUSH_INTERVAL);
  }
}

gameLoop.addAfterTickHook(flushMovementAfterTick);
spawnFlushTimer = setTimeout(scheduleSpawnFlush, SPAWN_FLUSH_INTERVAL);

ghosts.register(playerGhostKind({ queueMove: queueRemoteMovement, spawnQueue: spawnBatchQueue, despawnQueue: despawnBatchQueue }));

export function constructMapMetadata(
  mapName: string,
  spawnX: number,
  spawnY: number,
  direction: string,
  maps: MapData[],
  mapPropertiesCache: any[]
): any {
  const normalizedName = mapName.replace(".json", "");
  const map = maps.find((m: MapData) => m.name === `${normalizedName}.json` || m.name === normalizedName);
  const mapProps = mapPropertiesCache.find((m: any) => m.name === `${normalizedName}.json`);
  const assetServerUrl = process.env.ASSET_SERVER_URL || "http://localhost:8081";

  const worldsArr: WorldData[] = Array.isArray(worldsCache) ? worldsCache : (typeof worldsCache === "string" ? JSON.parse(worldsCache) : []);

  const objectLayers = (map?.data?.layers || [])
    .filter((layer: any) => layer.type === "objectgroup")
    .map((layer: any) => ({ name: layer.name }));

  const mapVersion = mapProps?.version || '';

  const metadata = {
    name: normalizedName,
    assetServerUrl,
    width: map?.data?.width || 0,
    height: map?.data?.height || 0,
    tilewidth: map?.data?.tilewidth || 32,
    tileheight: map?.data?.tileheight || 32,
    tilesets: map?.data?.tilesets || [],
    infinite: map?.data?.infinite === true,
    spawnX,
    spawnY,
    direction,
    chunks: null,
    warps: mapProps?.warps || null,
    graveyards: mapProps?.graveyards || null,
    shadowLayerNames: mapProps?.shadowLayerNames || null,
    sections: Array.isArray(map?.data?.sections) ? map.data.sections : null,
    // The desert zones of a world, as outlines in tiles (modules/worldmaps.ts): a sandstorm is only drawn inside them
    deserts: Array.isArray(map?.data?.deserts) ? map.data.deserts : null,
    // and its snow zones: a blizzard is only drawn inside them
    snowfields: Array.isArray(map?.data?.snowfields) ? map.data.snowfields : null,
    zones: Array.isArray(map?.data?.zones) ? map.data.zones : null,
    interior: isInteriorMap(normalizedName),
    hasWeather: !!worldsArr.find((w) => w.name === normalizedName),
    objectLayers,
    mapVersion,
  };

  listener.emit(Events.WARP, { mapName, metadata });
  return metadata;
}

export function isInteriorMap(mapName: string): boolean {
  const name = String(mapName ?? "").replace(".json", "");
  const map = (maps as MapData[]).find((m: MapData) => m.name === `${name}.json` || m.name === name);
  const properties = (map?.data as any)?.properties;
  return Array.isArray(properties) && properties.some((p: any) => p?.name === "interior" && p.value === true);
}

export async function transitionPlayerToMap(
  player: any,
  newMapName: string,
  newPosition: { x: number; y: number; direction?: string },
  wt: any,
  spawnBatchQueue: Map<string, Map<string, any>>,
  despawnBatchQueue: Map<string, Set<string>>
): Promise<void> {
  const owner = warpTarget(handoffCtx, newMapName, newPosition.x, newPosition.y);
  if (owner && player.wt && handoffBlocked(player, owner, handoffChecks) === null) {
    const before = player.location;
    player.handoffFromMap = before?.map;
    player.location = {
      map: bareMap(newMapName),
      position: { x: newPosition.x, y: newPosition.y, direction: newPosition.direction || before?.position?.direction || "down", moving: false },
    };
    let result: string = "refused";
    try {
      result = await playerHandoff.handOff(player, owner, { fullLoad: true });
    } finally {
      if (result !== "switched" && result !== "gone") {
        player.location = before;
        delete player.handoffFromMap;
      }
    }
    if (result === "switched" || result === "gone") return;
    log.debug(`Warp of ${player.username} into ${owner}'s block: handoff ${result}, warped here instead`);
  }

  loot.cancelCleanup(player.username);

  const dismounted = player.mounted === true && isInteriorMap(newMapName);
  if (dismounted) {
    player.mounted = false;
    player.mount_type = null;
    playerCache.set(player.id, player);
  }

  await handleMapChangeAOI(player, newMapName, { x: newPosition.x, y: newPosition.y }, spawnBatchQueue, despawnBatchQueue);

  clearTargetOnMapChange(player.id);

  const updatedPlayer = playerCache.get(player.id);
  if (!updatedPlayer) return;

  listener.emit(Events.MAP_ENTER, { player: updatedPlayer, mapName: newMapName, position: { x: newPosition.x, y: newPosition.y } });

  const direction = newPosition.direction || updatedPlayer.location.position?.direction || "down";
  const mapMetadata = constructMapMetadata(newMapName, newPosition.x, newPosition.y, direction, maps, mapPropertiesCache);
  sendPacket(wt, packetManager.loadMap(mapMetadata));
  creatures.resyncPlayer(player.id);
  // and its gathering nodes, which it clears the same way
  gathering.resyncPlayer(player.id);

  if (dismounted) {
    updatedPlayer.mounted = false;
    updatedPlayer.mount_type = null;
    playerCache.set(updatedPlayer.id, updatedPlayer);
    globalStateRevision++;
    await sendPositionAnimation(wt, direction, false, false, "", updatedPlayer.id, globalStateRevision, updatedPlayer.casting || false);
    listener.emit(Events.PLAYER_MOUNT, { player: updatedPlayer, mounted: false, mountType: null });
  }

  setImmediate(async () => {
    try {
      const normalizedMap = newMapName.replace(".json", "");
      if ((await getLiveWorlds()).some((w) => w.name === normalizedMap)) {
        const resolved = await resolveWorldWeather(normalizedMap);
        if (resolved.weather) {
          sendPacket(wt, packetManager.weather(await weatherShown(resolved.weather, resolved.weatherData)));
        }
      }
    } catch (e) {
      log.warn(`Failed to fetch weather data for ${newMapName}: ${e}`);
    }

    try {
      // the NPCs of the map chunks round the arrival point; the rest stream in as the player moves (npcStreaming)
      const npcPackets = await syncNpcChunks({ id: player.id, location: { map: newMapName, position: { x: newPosition.x, y: newPosition.y } } }, true);
      if (npcPackets.length) {
        sendPacket(wt, npcPackets);
      }
    } catch (e) {
      log.warn(`Failed to fetch NPC data for ${newMapName}: ${e}`);
    }

    await sendQuestMarkersFor(wt, player.username, newMapName);
    // And where the new map's inns are, for the minimap.
    await sendMapMarkers(wt, newMapName);

    try {
      const lootOnMap = loot.getOnMap(newMapName);
      if (lootOnMap.length > 0) {
        const lootPackets = lootOnMap.map((l) =>
          packetManager.lootSpawn({
            id: l.id,
            item: l.item,
            quantity: l.quantity,
            quality: l.quality,
            iconUrl: l.iconUrl,
            x: l.x,
            y: l.y,
            ownerId: l.ownerId,
            ownerName: l.ownerName,
          })
        ).flat();
        sendPacket(wt, lootPackets);
      }
    } catch (e) {
      log.warn(`Failed to sync loot for ${newMapName}: ${e}`);
    }

    try {
      const playerPos = newPosition || player.location?.position;
      const playerRadius = player.aoi?.aoiRadius || AOI_CONFIG.DEFAULT_RADIUS;
      const skeletonsInAOI = skeletons.getInRadius(newMapName, playerPos.x, playerPos.y, playerRadius, layerManager.getPlayerLayer(player.id));
      sendPacketBestEffort(wt, packetManager.loadSkeletons(skeletonsInAOI.map((s) => toSkeletonPacket(s))));
    } catch (e) {
      log.warn(`Failed to sync skeletons for ${newMapName}: ${e}`);
    }

    try {
      const chestsOnMap = lootChest.getOnMap(newMapName);
      if (chestsOnMap.length > 0) {
        const chestPackets = chestsOnMap.map((c: any) =>
          packetManager.lootChestSpawn({ id: c.id, x: c.x, y: c.y, iconUrl: c.iconUrl, map: c.map })
        ).flat();
        sendPacket(wt, chestPackets);
      }
    } catch (e) {
      log.warn(`Failed to sync loot chests for ${newMapName}: ${e}`);
    }

    const p = playerCache.get(player.id);
    if (!p) return;

    const dir = newPosition.direction || p.location.position?.direction || "down";
    const animationName = getAnimationNameForDirection(dir, false, !!p.mounted, p.mount_type, false);
    let spriteData: any = null;
    try {
      const selfSpriteData = await getPlayerSpriteSheetData(animationName, p.equipment || null);
      if (selfSpriteData.bodySprite || selfSpriteData.headSprite) {
        spriteData = {
          mountSprite: p.mount_type ? getMountSpriteUrl(p.mount_type) : null,
          bodySprite: selfSpriteData.bodySprite || null,
          headSprite: selfSpriteData.headSprite || null,
          armorHelmetSprite: selfSpriteData.armorHelmetSprite || null,
          armorShoulderguardsSprite: selfSpriteData.armorShoulderguardsSprite || null,
          armorNeckSprite: selfSpriteData.armorNeckSprite || null,
          armorHandsSprite: selfSpriteData.armorHandsSprite || null,
          armorChestSprite: selfSpriteData.armorChestSprite || null,
          armorFeetSprite: selfSpriteData.armorFeetSprite || null,
          armorLegsSprite: selfSpriteData.armorLegsSprite || null,
          armorWeaponSprite: selfSpriteData.armorWeaponSprite || null,
          animationState: selfSpriteData.animationState,
        };
      }
    } catch (e) {
      log.warn(`Failed to fetch player sprite data for ${player.id}: ${e}`);
    }

    const spawnData = {
      id: player.id,
      userid: p.userid,
      location: {
        map: `${newMapName}.json`,
        x: newPosition.x,
        y: newPosition.y,
        direction: dir,
      },
      username: p.username,
      isAdmin: p.isAdmin,
      isGuest: p.isGuest,
      isStealth: p.isStealth,
      isNoclip: p.isNoclip,
      stats: p.stats || {},
      animation: null,
      spriteData,
      friends: p.friends || [],
      party_id: p.party_id ? Number(p.party_id) : null,
      party: p.party || [],
      guild_id: p.guild_id ? Number(p.guild_id) : null,
      guild: p.guild || [],
      guild_name: p.guild_name || null,
      currency: p.currency || { copper: 0, silver: 0, gold: 0 },
    };
    sendPacket(wt, packetManager.spawnPlayer(spawnData));

    try {
      await sendAnimationTo(wt, animationName, player.id);
    } catch (e) {
      log.warn(`Failed to send animation for ${player.id}: ${e}`);
    }
  });
}

export function clearBatchQueuesForPlayer(playerId: string) {

  receiverSetCache.delete(playerId);
  movementProbeSeqs.delete(playerId);
  postToAllWorkers({ type: "removePlayers", ids: [playerId] });

  for (const [groupKey, groupMovements] of movementBatchQueue.entries()) {
    if (!groupMovements.has(playerId)) continue;
    groupMovements.delete(playerId);
    if (groupMovements.size === 0) {
      movementBatchQueue.delete(groupKey);
    }
  }

  spawnBatchQueue.delete(playerId);

  for (const key of spriteDataCache.keys()) {
    if (key.startsWith(`${playerId}:`)) {
      spriteDataCache.delete(key);
    }
  }
  for (const key of animationDataCache.keys()) {
    if (key.startsWith(`${playerId}:`)) {
      animationDataCache.delete(key);
    }
  }

  let clearedSpawnsFrom = 0;
  for (const [receivingPlayerId, spawnedPlayers] of spawnBatchQueue.entries()) {
    if (spawnedPlayers.has(playerId)) {
      spawnedPlayers.delete(playerId);
      clearedSpawnsFrom++;
    }
    if (spawnedPlayers.size === 0) {
      spawnBatchQueue.delete(receivingPlayerId);
    }
  }

  despawnBatchQueue.delete(playerId);

}

export function clearPlayerTarget(playerId: string) {
  currentTargetMap.delete(playerId);
}

export function clearTargetOnMapChange(playerId: string) {
  const moving = playerCache.get(playerId);
  if (moving) moving.selectedPlayerId = null;

  if (currentTargetMap.has(playerId)) {
    currentTargetMap.delete(playerId);
    const mover = playerCache.get(playerId);
    if (mover?.wt && mover.wt.readyState === 1) {
      sendPacket(mover.wt, packetManager.selectPlayer({ id: playerId, data: null }));
    }
  }

  for (const [observerId, targetedId] of currentTargetMap.entries()) {
    if (targetedId === playerId) {
      currentTargetMap.delete(observerId);
      const observer = playerCache.get(observerId);
      if (observer) observer.selectedPlayerId = null;
      if (observer?.wt && observer.wt.readyState === 1) {
        sendPacket(observer.wt, packetManager.selectPlayer({ id: observerId, data: null }));
      }
    }
  }
}

export function releaseDraggedBy(adminId: string | number) {
  for (const [draggedId, dragByAdminId] of [...draggedPlayersMap.entries()]) {
    if (String(dragByAdminId) !== String(adminId)) continue;
    draggedPlayersMap.delete(draggedId);

    const draggedPlayer = playerCache.get(draggedId.toString());
    if (!draggedPlayer) continue;
    const dragStopPacket = packetManager.dragPlayerStop({ id: draggedId, adminId });
    for (const p of filterPlayersByMap(draggedPlayer.location.map)) {
      if (p.wt && p.wt.readyState === 1) {
        sendPacket(p.wt, dragStopPacket);
      }
    }
    relayToMirrorViewers(draggedPlayer, dragStopPacket, false);
  }
}

export function removePlayerFromCleanupMaps(playerId: string | number) {
    const id = Number(playerId);
    chatRateLimit.delete(id);
    guildEditTimes.delete(id);
    draggedPlayersMap.delete(id);

    for (const [mapName, editors] of activeEditorsByMap.entries()) {
        editors.delete(id);
        if (editors.size === 0) activeEditorsByMap.delete(mapName);
    }

    for (const [mapName, history] of editorEditHistory.entries()) {
        const filtered = history.filter(e => e.senderId !== id);
        if (filtered.length === 0) {
            editorEditHistory.delete(mapName);
        } else {
            editorEditHistory.set(mapName, filtered);
        }
    }
}

export function removeFromAuthenticationQueues(sessionId: string, token: string) {
    pendingAuthentications.delete(sessionId);
    authentication_queue.delete(token);
    authentication_session_queue.delete(sessionId);
}

/** Streams the NPCs round a player's position now (after a jump within the map: teleports, editor go-to). */
export async function resyncNpcChunks(playerObj: any, wt: any): Promise<void> {
  try {
    const packets = await syncNpcChunks(playerObj, false, true);
    if (packets.length) sendPacket(wt, packets);
  } catch (e) {
    log.warn(`Failed to stream NPCs after a teleport: ${e}`);
  }
}

export async function teleportPlayerWrapper(playerObj: any, mapName: string, x: number, y: number): Promise<void> {
  const wt = playerObj.wt;
  if (!wt) return;
  if (CELLS_ON && inHandoff(playerObj)) {
    log.info(`Teleport of ${playerObj.username} to ${mapName} (${x}, ${y}) skipped: the player is changing server node`);
    return;
  }
  await transitionPlayerToMap(
    playerObj,
    mapName.replace(".json", ""),
    { x, y, direction: playerObj.location?.position?.direction || "down" },
    wt,
    spawnBatchQueue,
    despawnBatchQueue
  );
}

export async function placePlayer(playerObj: any, mapName: string, x: number, y: number): Promise<void> {
  const wt = playerObj.wt;
  if (!wt) return;
  const destMap = String(mapName).replace(".json", "");
  const currentMap = String(playerObj.location?.map ?? "").replace(".json", "");
  if (destMap !== currentMap) {
    await teleportPlayerWrapper(playerObj, mapName, x, y);
    return;
  }
  const direction = playerObj.location.position?.direction || "down";
  playerObj.location.position = {
    ...playerObj.location.position,
    x: Math.round(Number(x)),
    y: Math.round(Number(y)),
    direction,
  };
  bumpStateRevision();
  if (shouldUpdateAOI(playerObj)) {
    await updatePlayerAOI(playerObj, spawnBatchQueue, despawnBatchQueue);
  }
  broadcastToAOI(playerObj, packetManager.moveXY({
    i: wt.data.id,
    d: { x: playerObj.location.position.x, y: playerObj.location.position.y, dr: direction },
    r: stateRevision(),
    s: playerObj.isStealth ? 1 : 0,
  }), true);
  await resyncNpcChunks(playerObj, wt);
}

const liveNodes = new LiveNodeCache(async () => (await clusterNodes()?.live()) ?? []);

async function switchLoginIfElsewhere(wt: any, sessionId: string, username: string, spawn: { map: string; x: number; y: number }): Promise<boolean> {
  const blocks = clusterEnabled() ? clusterBlocks() : null;
  if (!blocks) return false;
  const secret = process.env.GATEWAY_GAME_SERVER_SECRET;
  if (!secret) return false;
  let route;
  try {
    route = routeLogin(spawn, blocks, await liveNodes.get(), nodeId());
  } catch (error) {
    log.error(`Could not tell which node ${username} belongs on, so they log in here: ${error}`);
    return false;
  }
  if (route === "here") return false;
  const target = route.switchTo;
  if (wt.data?.switched) {
    log.warn(`Login of ${username} was handed here by another node, but ${target.nodeId} owns ${spawn.map} at ${spawn.x},${spawn.y}: it plays here`);
    return false;
  }
  await player.clearSessionId(sessionId).catch((e) => log.error(`Session of ${username} not cleared: ${e}`));
  const ticket = nodeTicket(secret, String(wt.data?.ticketOrigin ?? ""), String(wt.data?.ticketAccount ?? ""), target.nodeId);
  log.debug(`Login of ${username} goes to node ${target.nodeId}, which owns ${spawn.map} at ${spawn.x},${spawn.y}`);
  // The SWITCH must arrive before the close: without it the client takes the close for a lost connection and reconnects here.
  await wt.sendThenClose(packetManager.switchNode(target, ticket), 1000, "switch");
  return true;
}

export const authWorker = await getAuthPool();
/** The rows of players arriving by handoff, read on the pool before their AUTH (started by server.ts's handoff deps). */
export const loginPrefetch = new LoginPrefetch((job) => authWorker.postMessage(job));
interface ArrivingLogin {
  wt: any;
  username: string | null;
  sessionId: string | null;
  /** The map whose world count the login raised, lowered again when it fails. */
  countedMap: string | null;
}

/** Ends an arrival that could not be completed. It never throws. */
async function failArrival(arriving: ArrivingLogin, reason: string): Promise<void> {
  const { wt, username } = arriving;
  arriving.username = null;
  log.error(`The arrival of ${username} by handoff could not be completed, and they are sent to log in again: ${reason}`);
  if (arriving.countedMap) {
    await Promise.resolve()
      .then(() => worlds.adjustPlayerCount(arriving.countedMap!, -1))
      .catch((error) => log.error(`[WorldsFetchError] Failed to update world player count: ${error}`));
  }
  if (arriving.sessionId) {
    await Promise.resolve()
      .then(() => player.clearSessionId(arriving.sessionId!))
      .catch((error) => log.error(`Session of ${username} not cleared: ${error}`));
  }
  try {
    sendPacket(wt, packetManager.loginFailed());
    wt.close(1008, "The move to this server could not be completed");
  } catch (error) {
    log.error(`The connection of ${username} could not be closed after their arrival failed: ${error}`);
  }
}

authWorker.on("message", (result: any) => {
  if (LoginPrefetch.owns(result)) return loginPrefetch.answer(result);
  const arriving: ArrivingLogin = { wt: null, username: null, sessionId: null, countedMap: null };
  return completeLogin(result, arriving).catch((error) => {
    // Any login that is not an arrival in its first stretch fails as it always has.
    if (arriving.username === null) throw error;
    return failArrival(arriving, String(error?.stack ?? error));
  });
});

authWorker.on("lost", (job) => LoginPrefetch.owns(job) ? undefined : player.clearSessionId(job.id).catch((error) => log.error(`Session of connection ${job.id} not cleared after its login worker stopped: ${error}`)));

async function completeLogin(result: any, arriving: ArrivingLogin): Promise<void> {
  const status = result as Authentication;
  const sessionId = result.id;

  const pending = pendingAuthentications.get(sessionId);
  if (!pending) return;

  const { wt, token, language } = pending;
  // The worker has answered: a handoff arrival's mark (the line is said at the player's first move).
  playerHandoff.landed(String(wt.data?.ticketToken ?? ""), "worker_done");

  if (status.prefetched) {
    const data = await pending.prefetched;
    if (pendingAuthentications.get(sessionId) !== pending) return;
    if (!data) {
      // Still the character the handoff brings, never the account's active one read again.
      const arriving = playerHandoff.arrivingCharacter(String(wt.data?.ticketToken ?? ""));
      authWorker.postMessage({ token, id: sessionId, characterId: arriving?.characterId });
      return;
    }
    log.debug(`Login of ${data.username} by handoff: the rows read ahead of the AUTH were used`);
    status.data = data;
  }

  pendingAuthentications.delete(sessionId);
  authentication_queue.delete(token);
  authentication_session_queue.delete(sessionId);

  if (status.characterRequired) {
    sendPacket(wt, packetManager.characterRequired());
    wt.close(1008, "Choose a character first");
    return;
  }

  if (status.error && !status.authenticated) {
    sendPacket(wt, packetManager.loginFailed());
    wt.close(1008, status.error);
    return;
  }

  if (status.authenticated && status.completed && status.error) {
    sendPacket(wt, packetManager.loginFailed());
    wt.close(1008, status.error);
    return;
  }

  const playerData = status.data as PlayerData;
  if (status.authenticated && status.completed && playerData) {
    if (isWhitelistEnabled() && !realmWhitelist.has(playerData.accountUsername.toLowerCase())) {
      log.warn(`[Whitelist] Access denied for ${playerData.username} - not in whitelist`);
      sendPacket(wt, packetManager.loginFailed());
      wt.close(1008, "Username not whitelisted on this realm");
      return;
    }

    // Subscription lock on logging in (admins pass; subscriptions off means no lock)
    if (subscriptionRefusal(playerData, "login")) {
      log.warn(`[Subscriptions] Login refused for ${playerData.username} - not subscribed`);
      sendPacket(wt, packetManager.loginFailed());
      wt.close(1008, "A subscription is needed to play on this realm");
      return;
    }

    if (await classes.characterRequired(playerData.characterClass)) {
      await player.clearSessionId(sessionId).catch((e) => log.error(`Session of ${playerData.username} not cleared: ${e}`));
      sendPacket(wt, packetManager.characterRequired());
      wt.close(1008, "Create your character first");
      return;
    }

    const arrival = clusterEnabled()
      ? playerHandoff.takeArrival(String(wt.data?.ticketToken ?? ""), playerData.username, String(wt.data.id), playerData.characterId)
      : null;
    if (arrival) Object.assign(arriving, { wt, username: playerData.username, sessionId });
    // The first MOVEXY of this connection says the new node's line of marks (handlers/movement.ts).
    if (arrival) wt.data.handoffLanding = true;
    const arrivalState = arrival
      ? handoffStateOf(arrival.snapshot.state, arrivalLimits((await assetCache.get("spells")) as SpellData[] | null), playerData.username, {
        caster: knownDotCaster,
        maps: await arrivalMaps(arrival.snapshot.state, maps as MapData[] | null, () => assetCache.get("maps") as Promise<MapData[] | null>),
      })
      : null;

    const assetServerUrl = process.env.ASSET_SERVER_URL || "http://localhost:8081";

    await kickDuplicateSessions(sessionsOfAccount(Object.values(playerCache.list()), playerData.accountId), {
      save: saveKickedPlayer,
      leave: leaveKickedPlayer,
      notify: (p: any, message: string) => {
        log.info(`Kicking existing session for ${p.username} of account ${playerData.accountUsername} (duplicate login)`);
        if (p.wt && p.wt.readyState === 1) {
          sendPacket(p.wt, packetManager.notify({
            message
          }));
        }
      },
      drop: async (p: any) => {
        try {
          cleanupKickedSession(p, despawnBatchQueue);
          gameLoop.unregisterMovingPlayer(p.id);
          clearBatchQueuesForPlayer(p.id);
          try {
            await worlds.adjustPlayerCount(p.location?.map || "", -1);
          } catch (err) {
            log.error(`[WorldsFetchError] Failed to update world player count: ${err}`);
          }

          const map = p.location?.map;
          if (map) {
            for (const [, other] of Object.entries(playerCache.list()) as [string, any][]) {
              if (other.location?.map === map && other.id !== p.id && other.wt?.readyState === 1) {
                forgetLook(other.wt, p.id);
                sendPacket(other.wt, packetManager.despawnPlayer(p.id, "disconnect"));
              }
            }
          }

          if (p.wt && p.wt.readyState === 1) {
            p.wt.close(1000, "Logged in from another location", { drain: true });
          }
        } finally {
          playerCache.remove(p.id);
          forgetNpcStream(p.id);
        }
      },
    });

    if (clusterEnabled() && !arrival && !Number(playerData.isDead) && !playerData.isGuest) {
      const store = clusterStore();
      if (store) {
        await recoverLogin(playerData, {
          stamp: () => player.saveStamp(playerData.accountId),
          snapshot: (username) => readSnapshot(store, username),
          knownMap: (map) => mapPropertiesCache.some((m: any) => m.name === `${map}.json`),
        });
      }
    }

    const default_map_properties = mapPropertiesCache.find((m: any) => m.name === `${defaultMap}.json`);
    const spawnX = (settings as any).spawn_x;
    const spawnY = (settings as any).spawn_y;
    // A world names its own spawn (a town square): its centre may well be a lake
    const worldSpawn = default_map_properties?.spawn;
    const default_map_spawnpoint_x = spawnX != null
      ? spawnX
      : worldSpawn ? worldSpawn.x
      : default_map_properties ? (default_map_properties.width * default_map_properties.tileWidth) / 2 : 0;
    const default_map_spawnpoint_y = spawnY != null
      ? spawnY
      : worldSpawn ? worldSpawn.y
      : default_map_properties ? (default_map_properties.height * default_map_properties.tileHeight) / 2 : 0;
    const default_map_spawnpoint = { map: `${defaultMap}.json`, x: default_map_spawnpoint_x, y: default_map_spawnpoint_y, direction: "down" };
    const dbMap = playerData.location?.map;
    const player_map_properties = dbMap ? mapPropertiesCache.find((m: any) => m.name === `${dbMap}.json`) : default_map_properties;

    const position = playerData.location?.position as PositionData;
    let spawnLocation = default_map_spawnpoint;

    if (playerData.location && position && dbMap) {
      spawnLocation = {
        map: `${dbMap}.json`,
        x: position.x || (player_map_properties?.spawn ? player_map_properties.spawn.x : player_map_properties ? (player_map_properties.width * player_map_properties.tileWidth) / 2 : 0),
        y: position.y || (player_map_properties?.spawn ? player_map_properties.spawn.y : player_map_properties ? (player_map_properties.height * player_map_properties.tileHeight) / 2 : 0),
        direction: position.direction || "down",
      };
    }

    // The row cache may still hold the old node's last save (Deviation 22): the snapshot's point is used.
    if (arrival) {
      spawnLocation = {
        map: `${arrival.snapshot.map}.json`,
        x: arrival.snapshot.x,
        y: arrival.snapshot.y,
        direction: arrival.snapshot.direction || "down",
      };
    }

    const loginDeadState = arrivalState ? arrivalState.deadState : Number(playerData.isDead) || 0;
    if (!arrival && loginDeadState === 1 && playerData.corpse?.map) {
      spawnLocation = {
        map: `${playerData.corpse.map}.json`,
        x: playerData.corpse.x,
        y: playerData.corpse.y,
        direction: "down",
      };
    }
    if (loginDeadState !== 0 && playerData.stats) {
      playerData.stats.health = 0;
      playerData.stats.stamina = 0;
    }

    const savedMap = maps.find((m: MapData) => m.name === spawnLocation.map);
    const map = savedMap || maps.find((m: MapData) => m.name === `${defaultMap}.json`);
    const resume = !!arrival?.resume && !!savedMap;
    if (map) {
      if (!savedMap) {
        spawnLocation.x = default_map_spawnpoint.x;
        spawnLocation.y = default_map_spawnpoint.y;
        spawnLocation.direction = default_map_spawnpoint.direction;
      }
      spawnLocation.map = map.name;

      if (!arrival && (await switchLoginIfElsewhere(wt, sessionId, playerData.username, spawnLocation))) return;
    }

    if (!playerData.isAdmin && playerData.isNoclip) {
      player.toggleNoclip(playerData.username).catch(err =>
        log.error(`Failed to toggle noclip: ${err}`)
      );
    }
    if (!playerData.isAdmin && playerData.isStealth) {
      player.toggleStealth(playerData.username).catch(err =>
        log.error(`Failed to toggle stealth: ${err}`)
      );
    }

    listener.emit(Events.PLAYER_AUTH_COMPLETE, { username: playerData.username, spawnLocation, playerData });

    // Who the player ignores, for the menus and the list their client shows. Chat is held back here, not there.
    ignores.list(playerData.username)
      .then((ignored) => sendPacket(wt, packetManager.updateIgnores({ ignored })))
      .catch((error) => log.error(`The ignore list of ${playerData.username} could not be sent: ${error}`));

    if (!map) {
      // No map to put an arrival on: it is told, rather than left on the loading screen.
      if (arriving.username !== null) await failArrival(arriving, `there is no map ${spawnLocation.map} and no default map`);
      return;
    }

    const questActive: QuestLogEntry[] = Array.isArray(playerData.questlog?.active) ? playerData.questlog.active : [];
    const questCompleted: number[] = Array.isArray(playerData.questlog?.completed) ? playerData.questlog.completed : [];

    const worldsResult = await assetCache.get("worlds").catch(err => {
      log.error(`[WorldsFetchError] Failed to fetch worlds: ${err}`);
      return worldsCache;
    });

    const worldData: WorldData[] = Array.isArray(worldsResult)
      ? worldsResult
      : JSON.parse(worldsResult);

    const world = worldData.find(
      (w) => w.name === spawnLocation.map.replace(".json", "")
    );


    if (world) {
      const worldPlayerCount = await worlds.adjustPlayerCount(spawnLocation.map, 1);
      if (arriving.username !== null) arriving.countedMap = spawnLocation.map;
      if (worldPlayerCount !== null) {
      }
    }

    // Only apply weather/ambience if the map has a defined world entry
    if (world) {
      const resolved = await resolveWorldWeather(spawnLocation.map.replace(".json", ""));
      if (resolved.weather) {
        sendPacket(wt, packetManager.weather(await weatherShown(resolved.weather, resolved.weatherData)));
      }
    }

    if (!resume) await refreshPlayer(playerData.username);
    // A settle mark taken from another node at this login (Task 20b): the bags are shown again when it runs out.
    reloadWhenSettled(playerData.username);
    if (arrival) playerHandoff.landed(String(wt.data?.ticketToken ?? ""), "rows_done");

    if (playerData.characterClass != null) {
      try {
        const learned = await classes.learnUpTo(playerData.username, playerData.characterClass, Number(playerData.stats?.level) || 1);
        if (learned.length) playerData.learnedSpells = await spells.learnedDetails(playerData.username) as any;
      } catch (error) {
        log.error(`[Classes] The class spells of ${playerData.username} could not be learned at login: ${error}`);
      }
    }

    const inventorySlots = await getInventorySlots(playerData);
    const limitedInventory = Array.isArray(playerData.inventory) ? playerData.inventory.slice(0, inventorySlots) : [];
    const limitedFriends = Array.isArray(playerData.friends) ? playerData.friends.slice(0, 100) : [];
    const limitedCollectables = Array.isArray(playerData.collectables) ? playerData.collectables.slice(0, 50) : [];
    const limitedLearnedSpells = Array.isArray(playerData.learnedSpells) ? playerData.learnedSpells.slice(0, 100) : (playerData.learnedSpells || []);

    if (arrivalState) seedArrival(playerData.username, arrivalState);
    const fields = arrivalState
      ? arrivalFields(arrivalState)
      : { pvp: false, last_attack: null as number | null, mounted: false, mount_type: null as string | null };
    // The mount is checked here as the MOUNT packet checks it: owned, alive, not inside a building.
    const mount = arrivalState
      ? arrivalMount(fields, limitedCollectables, loginDeadState, isInteriorMap(spawnLocation.map))
      : { mounted: false, mount_type: null as string | null };

    playerCache.add(wt.data.id, {
      username: playerData.username,
      characterId: playerData.characterId,
      accountId: playerData.accountId,
      accountUsername: playerData.accountUsername,
      animation: null,
      isAdmin: playerData.isAdmin,
      isStealth: playerData.isStealth,
      isNoclip: playerData.isNoclip,
      id: wt.data.id,
      userid: playerData.id,
      location: {
        map: spawnLocation.map.replace(".json", ""),
        position: {
          x: spawnLocation.x || 0,
          y: spawnLocation.y || 0,
          direction: spawnLocation.direction || "down",
          moving: false,
        },
      },
      language: language || "en",
      wt,
      stats: playerData.stats || {},
      friends: limitedFriends,
      attackDelay: 0,
      lastMovementPacket: null,
      permissions: typeof playerData.permissions === "string" ? (playerData.permissions as string).split(",") : playerData.permissions || [],
      pvp: fields.pvp,
      last_attack: fields.last_attack,
      invitations: [],
      party_id: playerData.party_id ? Number(playerData.party_id) : null,
      party: playerData.party || null,
      guild_id: playerData.guild_id ? Number(playerData.guild_id) : null,
      guild: playerData.guild || [],
      guild_name: playerData.guild_name || null,
      currency: playerData.currency || { copper: 0, silver: 0, gold: 0 },
      isGuest: playerData.isGuest,
      isSubscribed: playerData.isSubscribed,
      characterClass: playerData.characterClass ?? null,
      created: performance.now(),
      lastUpdated: performance.now(),
      mounted: mount.mounted,
      mount_type: mount.mount_type,
      collectables: limitedCollectables,
      spellCooldowns: cooldownManager.getActiveCooldowns(playerData.username),
      casting: false,
      lastInterruptTime: 0,
      interruptableSpell: false,
      castId: 0,
      stunnedUntil: 0,
      _moveSeq: 0,
      // The pose revision (socket/posedgram.ts) counts on from the old node's, so a handed-off player never sends a lower one.
      poseRev: arrival ? arrivedPoseRevision(arrival.snapshot.state) : 0,
      spellLockoutUntil: cooldownManager.getLockout(playerData.username),
      slowPercent: 0,
      slowMultiplier: 1,
      isVanished: false,
      isDead: loginDeadState === 1,
      isGhost: loginDeadState === 2,
      corpse: loginDeadState === 0 ? null : arrivalState ? arrivalState.corpse : playerData.corpse || null,
      reviveOffered: false,
      learnedSpells: limitedLearnedSpells,
      inventory: limitedInventory,
      equipment: playerData.equipment || {},
      equipmentRevision: 0,
      questlog: { active: questActive, completed: questCompleted },
    });
    // Logged in: as large a packet as a player sends, or as the tools need for one who uses them.
    wt.setFrameLimit?.(frameLimitFor(playerCache.get(wt.data.id), MAX_FRAME_BYTES, BENCHMARK_ENABLED));
    wt.markLoggedIn?.();
    if (arrival) playerHandoff.landed(String(wt.data?.ticketToken ?? ""), "cached");

    const _pcache = playerCache.get(wt.data.id);
    if (!_pcache) {
      if (arriving.username !== null) await failArrival(arriving, "the player cache did not take them");
      return;
    }
    // The player is in the cache: from here a failure is cleaned up by the disconnect, as for any login.
    arriving.username = null;
    // The scene they were watching goes on here: they are held from now, before anything can reach them.
    if (arrivalState?.cutscene) adoptCutscene(_pcache, arrivalState.cutscene);
    if (arrivalState?.cutsceneChain) adoptCutsceneChain(_pcache, arrivalState.cutsceneChain);

    if (arrival) ghosts.dropMirror("player", arrival.snapshot.id);
    if (clusterEnabled()) forwardTable.forgetPlayer(String(_pcache.id), playerData.username);

    // Send initial packets immediately - stats sync and effect restoration follow asynchronously
    await initializePlayerAOI(_pcache);
    playerCache.set(_pcache.id, _pcache);
    mapIndex.addPlayer(_pcache.id, _pcache.location.map);
    loot.cancelCleanup(_pcache.username);
    if (resume) {
      // The client shows these creatures already: the next refresh sends only what differs (Deviation 15).
      const layerId = _pcache.aoi?.layerId ?? layerManager.getPlayerLayer(String(_pcache.id)) ?? null;
      creatures.sync.adopt(String(_pcache.id), _pcache.location.map, layerId, arrival!.snapshot.creatureIds);
    }

    const mapMetadata = constructMapMetadata(
      spawnLocation?.map,
      spawnLocation?.x || 0,
      spawnLocation?.y || 0,
      spawnLocation?.direction || "down",
      maps,
      mapPropertiesCache
    );
    // The resumed walk's start, so the spawn below is built after the walk has begun (it reads `moving` and the pose).
    let resumedWalk: Promise<void> | null = null;
    if (resume) {
      const resumeCatchUp: ResumeCatchUp | null = arrivalState?.walk
        ? { walk: arrivalState.walk, idleMs: arrivalState.walkIdleMs, committedAt: arrival?.committedAt ?? Date.now() }
        : null;
      const movement = await import("./handlers/movement");
      await player.preloadMapCollision(_pcache.location.map);
      const gap: GapUpdate | undefined = wt.data.gapUpdate;
      wt.data.gapUpdate = undefined;
      const replayable = !!resumeCatchUp && !!doneWalkOf(arrivalState?.walk, _pcache);
      // A report that comes from here on is walked from the same point (applyLateGap), once the walk below has begun.
      const position = _pcache.location.position;
      const applied: GapApplied = {
        seq: gap?.seq ?? -1,
        map: _pcache.location.map,
        from: { x: position.x, y: position.y, direction: position.direction },
        catchUp: replayable ? resumeCatchUp : null,
        at: 0,
        ready: false,
        pending: null,
      };
      wt.data.gapApplied = applied;
      const gapPlan = replayable ? gapPlanOf(gap?.input, resumeCatchUp, Date.now(), TICK_MS) : null;
      let walk = arrivalState?.walk ?? null;
      let catchUp = resumeCatchUp;
      if (gapPlan) {
        const moved = await movement.replayGapSteps(_pcache, gapPlan.steps);
        walk = gapPlan.walk;
        catchUp = walk && resumeCatchUp ? { ...resumeCatchUp, walk, spentMs: gapPlan.spentMs } : null;
        // They stand where the replay left them: their viewers are told.
        if (moved && !walk) queueFinalMovement(_pcache);
      }
      // The walk about to be resumed below, not the facing (a cast keeps the facing while the player walks another way).
      const doneWalk = doneWalkOf(walk, _pcache);
      // The client keeps its world (Task 12): it is told where it stands, and the spawns that follow are deduped by id.
      sendPacket(wt, packetManager.handoffDone({
        map: _pcache.location.map,
        x: _pcache.location.position.x,
        y: _pcache.location.position.y,
        direction: _pcache.location.position.direction,
        walk: doneWalk,
        // The walk the catch-up adds to the first step: the client keeps its walk when it is that far past the point.
        catchUpMs: doneWalk ? resumeCatchUpMs(catchUp, Date.now(), TICK_MS) : 0,
        // The newest report walked (-1 for none): the client walks the gap on until the answer to a newer one it sent.
        gapSeq: applied.seq,
      }));
      applied.at = Date.now();
      if (walk) {
        // (movement.ts undoes a stray stop of the superseded mover for this long, for this arrival only)
        wt.data.walkRecoverUntil = Date.now() + RESUME_WALK_RECOVER_MS;
        wt.data.resumeCatchUp = catchUp;
        resumedWalk = resumeArrivalWalk(wt, walk);
      }
      // (resumeArrivalWalk numbered its move before returning: a report walked now supersedes it)
      applied.ready = true;
      if (applied.pending) {
        const pending = applied.pending;
        applied.pending = null;
        void applyLateGap(wt, pending);
      }
    } else {
      sendPacket(wt, packetManager.loadMap(mapMetadata));
    }
    if (arrival) playerHandoff.landed(String(wt.data?.ticketToken ?? ""), "done_sent");

    sendPacket(wt, packetManager.serverTime(weatherApi.utcOffsetSeconds()));

    setTimeout(deferredStep(`The spawn of ${playerData.username}`, async () => {

      if (resumedWalk) await waitFor(resumedWalk, RESUME_WALK_WAIT_MS);

      const currentPlayer = playerCache.get(wt.data.id);
      if (!currentPlayer) return;

      // Sync stats with equipment bonuses before spawning
      const syncedStats = await player.synchronizeStats(playerData.username);
      if (syncedStats) {
        if (syncedStats.stamina > syncedStats.total_max_stamina) syncedStats.stamina = syncedStats.total_max_stamina;
        if (syncedStats.health > syncedStats.total_max_health) syncedStats.health = syncedStats.total_max_health;
        currentPlayer.stats = syncedStats;
        playerCache.set(currentPlayer.id, currentPlayer);
      }

      await updatePlayerAOI(currentPlayer, spawnBatchQueue, despawnBatchQueue);

      if (resume && arrival) {
        for (const id of arrival.snapshot.playerIds) {
          const mirror = mirrorPlayers.get(String(id));
          if (mirror) updateMirrorViewers(mirror, spawnBatchQueue, despawnBatchQueue);
        }
        const gone = playersToDespawn(arrival.snapshot.playerIds, currentPlayer.aoi?.playersInAOI ?? new Set<string>(), String(currentPlayer.id));
        for (const id of gone) forgetLook(wt, id);
        if (gone.length > 0) sendPacket(wt, gone.flatMap((id) => packetManager.despawnPlayer(id, "distance")));
      }

      // A resumed arrival has walked on since the snapshot: the spawn shows the walk, the mount and the point as they are now.
      const resumed = resume ? resumeSelfSpawn(currentPlayer, getAnimationNameForDirection, gameLoop.isPlayerMoving(currentPlayer.id)) : null;
      const animationName = resumed ? resumed.animationName : getAnimationNameForDirection(position?.direction || "down", false, false, undefined, false);
      const selfSpriteData = await getPlayerSpriteSheetData(animationName, _pcache?.equipment || null);

      let spriteDataForSelf = null;
      if (selfSpriteData.bodySprite || selfSpriteData.headSprite) {
        // Sprite URLs are now sent to the client, which fetches them from the asset server
        spriteDataForSelf = {
          mountSprite: _pcache?.mounted === true && _pcache?.mount_type ? getMountSpriteUrl(_pcache.mount_type) : null,
          bodySprite: selfSpriteData.bodySprite || null,
          headSprite: selfSpriteData.headSprite || null,
          armorHelmetSprite: selfSpriteData.armorHelmetSprite || null,
          armorShoulderguardsSprite: selfSpriteData.armorShoulderguardsSprite || null,
          armorNeckSprite: selfSpriteData.armorNeckSprite || null,
          armorHandsSprite: selfSpriteData.armorHandsSprite || null,
          armorChestSprite: selfSpriteData.armorChestSprite || null,
          armorFeetSprite: selfSpriteData.armorFeetSprite || null,
          armorLegsSprite: selfSpriteData.armorLegsSprite || null,
          armorWeaponSprite: selfSpriteData.armorWeaponSprite || null,
          animationState: selfSpriteData.animationState,
        };
      }

      const spawnDataForAll = {
        id: wt.data.id,
        userid: playerData.id,
        location: {
          map: spawnLocation.map,
          x: resumed ? resumed.x : spawnLocation.x || 0,
          y: resumed ? resumed.y : spawnLocation.y || 0,
          direction: resumed ? resumed.direction : spawnLocation.direction,
        },
        username: playerData.username,
        isAdmin: playerData.isAdmin,
        isGuest: playerData.isGuest,
        isStealth: playerData.isStealth,
        isNoclip: playerData.isNoclip,
        isDead: currentPlayer.isDead || false,
        isGhost: currentPlayer.isGhost || false,
        mounted: currentPlayer.mounted === true,
        ghostTeleportPending: currentPlayer.ghostTeleportPending || false,
        corpse: currentPlayer.corpse || null,
        stats: currentPlayer.stats || {},
        animation: null,
        spriteData: spriteDataForSelf,
        friends: playerData.friends || [],
        party_id: playerData.party_id ? Number(playerData.party_id) : null,
        party: playerData.party || [],
        guild_id: playerData.guild_id ? Number(playerData.guild_id) : null,
        guild: playerData.guild || [],
        guild_name: playerData.guild_name || null,
        currency: playerData.currency || { copper: 0, silver: 0, gold: 0 },
        effects: spellEffects.getEffectsPayload(currentPlayer),
      };
      sendPacket(wt, packetManager.spawnPlayer(spawnDataForAll));
      if (currentPlayer.guild_id) {
        sendPacket(wt, packetManager.updateGuild(await guilds.packetFor(currentPlayer.guild_id, currentPlayer.username)));
        const motd = await guilds.getMotd(currentPlayer.guild_id);
        if (motd) sendPacket(wt, packetManager.guildChat({ id: null, username: "", system: true, motd: true, message: `Guild Message of the Day: ${motd}` }));
      }

      const snapshotRevision = globalStateRevision;

      const playerDataForLoad: any[] = [];
      const playersInAOI = Array.from(currentPlayer.aoi.playersInAOI)
        .map(id => playerCache.get(id as string))
        .filter(p => p && p.wt);

      for (const p of playersInAOI) {

        const animationName = getAnimationNameForDirection(p.location.position?.direction || "down", !!p.moving, !!p.mounted, p.mount_type, !!p.casting);
        const spriteCacheKey = `${p.id}:${animationName}:${p.equipmentRevision || 0}`;
        let playerSpriteData = spriteDataCache.get(spriteCacheKey);
        if (playerSpriteData === undefined) {
          playerSpriteData = await getPlayerSpriteSheetData(animationName, p.equipment || null);
          setBounded(spriteDataCache, spriteCacheKey, playerSpriteData, SPRITE_CACHE_MAX);
        }

        const mountSprite = p.mount_type ? getMountSpriteUrl(p.mount_type) : null;

        let spriteData = null;
        if (playerSpriteData?.bodySprite || playerSpriteData?.headSprite || mountSprite) {
          // Sprite URLs are now sent to the client, which fetches them from the asset server
          spriteData = {
            mountSprite: mountSprite,
            bodySprite: playerSpriteData.bodySprite || null,
            headSprite: playerSpriteData.headSprite || null,
            armorHelmetSprite: playerSpriteData.armorHelmetSprite || null,
            armorShoulderguardsSprite: playerSpriteData.armorShoulderguardsSprite || null,
            armorNeckSprite: playerSpriteData.armorNeckSprite || null,
            armorHandsSprite: playerSpriteData.armorHandsSprite || null,
            armorChestSprite: playerSpriteData.armorChestSprite || null,
            armorFeetSprite: playerSpriteData.armorFeetSprite || null,
            armorLegsSprite: playerSpriteData.armorLegsSprite || null,
            armorWeaponSprite: playerSpriteData.armorWeaponSprite || null,
            animationState: playerSpriteData.animationState,
          };
        }

        const loadPlayerData = {
          id: p.id,
          userid: p.userid,
          location: {
            map: p.location.map,

            x: Number(p.location.position.x) || 0,
            y: Number(p.location.position.y) || 0,
            direction: p.location.position?.direction || "down",
            moving: p.moving || false,
          },
          username: p.username,
          isAdmin: p.isAdmin,
          isGuest: p.isGuest,
      isStealth: p.isStealth,
      isVanished: p.isVanished,
          isNoclip: p.isNoclip,
          isDead: p.isDead || false,
          isGhost: p.isGhost || false,
          ghostTeleportPending: p.ghostTeleportPending || false,
          corpse: p.corpse || null,
          stats: p.stats,
          animation: null,
          spriteData: spriteData,
          mounted: p.mounted,
          guild: p.guild || [],
          guild_name: p.guild_name || null,
          effects: spellEffects.getEffectsPayload(p),
        }
        playerDataForLoad.push(loadPlayerData);
      }

      sendLoadPlayersChunked(sendPacket, wt, playerDataForLoad, snapshotRevision);

      // Batch animation data for all existing players into one packet for the new player
      if (playerDataForLoad.length > 0) {
        const animationDataArray: any[] = [];
        for (const pl of playerDataForLoad) {
          if (pl.id !== wt.data.id && pl.location.direction) {
            const pcache = playerCache.get(pl.id);
            const animName = getAnimationNameForDirection(pl.location.direction, !!pcache?.moving, !!pcache?.mounted, pcache?.mount_type, !!pcache?.casting);
            animationDataArray.push({
              id: pl.id,
              name: animName,
              revision: globalStateRevision,
            });
          }
        }
        // Chunked for the same queue-limit reason
        const ANIMATION_CHUNK_SIZE = 25;
        for (let i = 0; i < animationDataArray.length; i += ANIMATION_CHUNK_SIZE) {
          sendPacket(wt, packetManager.batchSpriteSheetAnimation(animationDataArray.slice(i, i + ANIMATION_CHUNK_SIZE)));
        }
      }

      const layerId = currentPlayer.aoi?.layerId || layerManager.getPlayerLayer(currentPlayer.id);
      const groupKey = layerId || currentPlayer.location.map;
      const queuedMovements = movementBatchQueue.get(groupKey);
      if (queuedMovements && queuedMovements.size > 0) {
        const movementsForNewPlayer: any[] = [];

        for (const playerId of currentPlayer.aoi.playersInAOI) {
          const movement = queuedMovements.get(playerId as string);
          if (movement) {
            movementsForNewPlayer.push(movement);
          }
        }

        if (movementsForNewPlayer.length > 0) {
          sendPacket(wt, packetManager.batchMoveXY(movementsForNewPlayer));
        }
      }

      if (resume) {
        const poseNow = resumeSelfSpawn(currentPlayer, getAnimationNameForDirection, gameLoop.isPlayerMoving(currentPlayer.id));
        if (poseNow) await sendAnimationTo(wt, poseNow.animationName, wt.data.id);
      } else if (position?.direction) {
        await sendAnimationTo(
          wt,
          getAnimationNameForDirection(position.direction, false, false, undefined, false),
          wt.data.id
        );
      }

      // Effects and other-player animations are handled by flushSpawnBatches

      // Send the newly connected player the ground AoE zones near them on their layer
      resyncZonesFor(currentPlayer, true);

      // Restore persisted effects from previous session
      const effectUsername = playerData.username?.toLowerCase();
      if (effectUsername) {
        const savedDots = effectManager.loadDots(effectUsername);
        if (savedDots.length > 0) {
          dots.setPlayerDots(String(currentPlayer.id), savedDots.filter((d: any) => d.expiresAt > Date.now()));
        }

        const savedBarriers = effectManager.loadBarriers(effectUsername);
        if (savedBarriers.length > 0) {
          currentPlayer.barriers = savedBarriers;
          currentPlayer.stats.absorbtion = savedBarriers.reduce((sum: number, b: any) => sum + Math.max(0, b.amount), 0);
        }

        const savedStuns = effectManager.loadStuns(effectUsername);
        if (savedStuns.length > 0) {
          setStunsForPlayer(String(currentPlayer.id), savedStuns);
          currentPlayer.stunnedUntil = Math.max(...savedStuns.map((s: any) => s.expiresAt));
        }

        const savedSlows = effectManager.loadSlows(effectUsername);
        if (savedSlows.length > 0) {
          setSlowsForPlayer(String(currentPlayer.id), savedSlows);
          currentPlayer.slowPercent = Math.max(...savedSlows.map((s: any) => s.slowPercent));
          currentPlayer.slowMultiplier = 1 - currentPlayer.slowPercent / 100;
        }

        if (resurrection.restoreOnLogin(currentPlayer)) {
          sendPacket(
            wt,
            packetManager.updateStats({
              id: currentPlayer.id,
              target: currentPlayer.id,
              stats: currentPlayer.stats,
            })
          );
          spellEffects.broadcastEffectsUpdate(currentPlayer);
        }

        effectManager.clearAll(effectUsername);
      }

    }, () => {
      // The client never got its spawn: closing the connection runs the normal disconnect clean-up, and it logs in again.
      try { wt.close(1011, "The spawn could not be finished"); } catch {}
    }));
    // Defer secondary loads with a delay so the game loop can process between player spawns
    setTimeout(deferredStep(`The friends, NPCs and loot sent to ${playerData.username} after their spawn`, async () => {

      const currentPlayerData = playerCache.get(wt.data.id);
      // A crossing to another node is not a login: the contacts' lists stand as they were.
      if (currentPlayerData && !arrival) await greetContacts(currentPlayerData);

      // NPCs: those of the map chunks round the spawn point; the rest stream in as the player moves (npcStreaming)
      const spawnNpcPackets = await syncNpcChunks({ id: wt.data.id, location: { map: spawnLocation.map, position: { x: spawnLocation.x, y: spawnLocation.y } } }, true);
      if (spawnNpcPackets.length) sendPacket(wt, spawnNpcPackets);

      const mapName = spawnLocation.map.replace(".json", "");

      // Loot
      const lootOnMap = loot.getOnMap(mapName);
      if (lootOnMap.length) {
        sendPacket(wt, packetManager.loadLoot(lootOnMap));
      }

      // Death skeletons inside the player's AOI only.
      const skeletonViewer = playerCache.get(wt.data.id);
      const skeletonPos = skeletonViewer?.location?.position;
      if (skeletonPos) {
        const skeletonRadius = skeletonViewer.aoi?.aoiRadius || AOI_CONFIG.DEFAULT_RADIUS;
        const skeletonsInAOI = skeletons.getInRadius(mapName, skeletonPos.x, skeletonPos.y, skeletonRadius, layerManager.getPlayerLayer(wt.data.id));
        sendPacketBestEffort(wt, packetManager.loadSkeletons(skeletonsInAOI.map((s) => toSkeletonPacket(s))));
      }

      const relogPlayer = playerCache.get(wt.data.id);
      if (relogPlayer?.isDead) {
        sendPacket(wt, packetManager.playerDied({ id: relogPlayer.id }));
      } else if (relogPlayer?.isGhost) {
        const ghostPacket = packetManager.playerGhost({ id: relogPlayer.id, ghost: true });
        const viewersInMap = filterPlayersByMap(relogPlayer.location.map);
        viewersInMap.forEach((p) => {
          sendPacket(p.wt, ghostPacket);
        });
        relayToMirrorViewers(relogPlayer, ghostPacket, false);
      }
    }), 200);

    const clientConfig: any[] = (playerData.config || []).slice();
    if (clientConfig.length > 0) {
      const spellCooldownsForClient: Record<string, number> = {};
      const now = performance.now();
      for (const [spellIdStr, endTime] of Object.entries(_pcache?.spellCooldowns || {})) {
        const remaining = Math.max(0, (endTime as number) - now);
        if (remaining > 0) {
          const spell = await spells.find(Number(spellIdStr));
          if (spell?.name) {
            spellCooldownsForClient[spell.name] = Math.ceil(remaining);
          }
        }
      }
      clientConfig[0].spell_cooldowns = spellCooldownsForClient;
      const lockoutRemaining = Math.max(0, (_pcache?.spellLockoutUntil || 0) - now);
      clientConfig[0].spell_lockout = Math.ceil(lockoutRemaining);
    }
    sendPacket(wt, packetManager.clientConfig(clientConfig));

    // Convert icon names to Asset Server URLs for inventory items
    const bagBoundaries = await getBagBoundaries(playerData.username);
    const inventoryWithIconUrls = playerData.inventory?.map((item: any) => ({
      ...item,
      iconUrl: getIconUrl(item.icon),
      icon: undefined,
      bag_slot: computeBagSlot(item.slot, bagBoundaries),
    })) || [];

    // Convert icon names to Asset Server sprite URLs for spells (icons and sprites share the same name)
    const spellsWithSpriteUrls: Record<string, any> = {};
    if (playerData.learnedSpells && typeof playerData.learnedSpells === 'object') {
      for (const [spellName, spellData] of Object.entries(playerData.learnedSpells)) {
        spellsWithSpriteUrls[spellName] = {
          spriteUrl: (spellData as any).icon ? `${assetServerUrl}/sprite?name=${encodeURIComponent((spellData as any).icon)}` : null,
          description: (spellData as any).description ?? null,
          mana: (spellData as any).mana ?? 0,
          cooldown: (spellData as any).cooldown ?? 0,
          cast_time: (spellData as any).cast_time ?? 0,
          damage: (spellData as any).damage ?? 0,
          type: (spellData as any).type ?? null,
          effects: (spellData as any).effects ?? [],
          particles: (spellData as any).particles ?? null,
          aoe_radius: (spellData as any).aoe_radius ?? null,
          range: (spellData as any).range ?? null,
          ground_aoe: (spellData as any).ground_aoe ?? null,
          ground_duration: (spellData as any).ground_duration ?? null,
          is_thrown: (spellData as any).is_thrown ?? null,
          charge_distance: (spellData as any).charge_distance ?? null,
          teleport_behind: (spellData as any).teleport_behind ?? null,
          can_move: (spellData as any).can_move ? 1 : 0,
        };
      }
    }

    // Convert icon names to Asset Server URLs for collectables (mounts)
    const collectablesWithIconUrls = playerData.collectables?.map((collectable: any) => ({
      ...collectable,
      iconUrl: getIconUrl(collectable.icon),
      icon: undefined // Remove the old icon field
    })) || [];

    sendPacket(wt, packetManager.inventory(inventoryWithIconUrls, inventorySlots));
    sendPacket(wt, packetManager.equipment(playerData.equipment || {}));

    void consumables.giveHomeItem(playerData.username)
      .then((given) => (given ? sendBelongingsOf(playerCache.get(wt.data.id)) : undefined))
      .catch((error) => log.error(`${playerData.username} could not be given the home item: ${error}`));
    void sendItemCooldowns(wt, playerData.username)
      .catch((error) => log.error(`The item cooldowns of ${playerData.username} could not be sent: ${error}`));

    const playerBags = await bags.ensure(playerData.username);
    sendPacket(wt, packetManager.bags(playerBags));
    sendPacket(wt, packetManager.collectables(collectablesWithIconUrls));
    sendPacket(wt, packetManager.spells(spellsWithSpriteUrls));
    // Quest log + definitions so the client needs no second fetch, then markers.
    try {
      trackRadiusPlayer(playerData.username);
    } catch {
      // Best-effort.
    }
    sendPacket(
      wt,
      packetManager.questLog({ active: questActive, completed: questCompleted, definitions: questDefsForEntries(questActive, questCompleted) })
    );
    await sendQuestMarkersFor(wt, playerData.username, spawnLocation.map);
    await sendMapMarkers(wt, spawnLocation.map);
    // the tiles that can be fished (systems/fishing), on every map
    sendPacket(wt, packetManager.fishingTiles({ tilesets: fishing.publicTiles() }));
    // and the footprints tiles take (systems/footprints)
    try {
      sendPacket(wt, packetManager.tileFootprints({ tilesets: await footprints.getFootprints() }));
    } catch (error) {
      log.warn(`The tile footprints could not be sent to ${playerData.username}: ${error}`);
    }
    try {
      const self = playerCache.getByUsername(playerData.username);
      if (self && (await mail.unread(self.username)) > 0) await sendMailNotice(self, true);
    } catch (error) {
      log.warn(`The mail of ${playerData.username} could not be looked at: ${error}`);
    }
  }
}

/** The handler modules, loaded at the first packet (they import this module). */
let handlerRoutes: typeof import("./handlers/index") | null = null;

async function resumeArrivalWalk(wt: any, direction: string): Promise<void> {
  try {
    const handler = (handlerRoutes ??= await import("./handlers/index")).route("MOVEXY");
    const currentPlayer = playerCache.get(wt.data.id) || null;
    if (!handler || !currentPlayer || wt.readyState !== 1) return;
    await trackPacket(String(wt.data.id), () => handler.handle({
      server: undefined, wt, message: "", parsedMessage: { type: "MOVEXY", data: direction } as unknown as Packet, data: direction, type: "MOVEXY", currentPlayer,
      resolveNpcParticles: async (npc: Npc) => npc, resolveNpcForClient: async (npc: Npc) => npc,
    }));
  } catch (error) {
    log.warn(`The walk of an arrival was not resumed: ${error}`);
  }
}

export async function applyLateGap(wt: any, update: GapUpdate): Promise<void> {
  const applied: GapApplied | undefined = wt.data?.gapApplied;
  if (!applied || update.seq <= applied.seq) return;
  if (!applied.ready) {
    applied.pending = newerGap(applied.pending, update);
    return;
  }
  applied.seq = update.seq;
  const p = playerCache.get(wt.data.id);
  if (!p || wt.readyState !== 1) return;
  applied.ready = false;
  // (resumeArrivalWalk numbers its move before returning: the next report, walked after the finally, supersedes it)
  let resumed: Promise<void> | null = null;
  try {
    const now = Date.now();
    const walkable = !!applied.catchUp && p.location.map === applied.map && now - applied.at <= MAX_GAP_LATE_MS && !!doneWalkOf(applied.catchUp.walk, p);
    const plan = walkable ? gapPlanOf(update.input, applied.catchUp, now, TICK_MS) : null;
    if (plan) {
      // The walk under way, and a MOVEXY of it still running, give way: their move number is older.
      p._moveSeq = (p._moveSeq ?? 0) + 1;
      gameLoop.unregisterMovingPlayer(p.id);
      wt.data.resumeCatchUp = undefined;
      p._stepCarry = undefined;
      await (await import("./handlers/movement")).replayGapSteps(p, plan.steps, applied.from);
    }
    const walk = doneWalkOf(plan ? plan.walk : walkOf(p), p);
    const catchUp = plan && walk ? { ...applied.catchUp!, walk, spentMs: plan.spentMs } : null;
    sendPacket(wt, packetManager.handoffGapDone({
      seq: update.seq,
      x: p.location.position.x,
      y: p.location.position.y,
      direction: p.location.position.direction,
      walk,
      catchUpMs: catchUp ? resumeCatchUpMs(catchUp, Date.now(), TICK_MS) : 0,
      // The client drops its own echoes sent before this (same clock as their send time).
      t: Date.now(),
    }));
    if (!plan) return;
    if (walk) {
      wt.data.walkRecoverUntil = Date.now() + RESUME_WALK_RECOVER_MS;
      wt.data.resumeCatchUp = catchUp;
      resumed = resumeArrivalWalk(wt, walk);
    } else {
      // They stand where the replay left them: they are posed standing, and their viewers are told where.
      await forceStopPlayerMovement(p);
      queueFinalMovement(p);
    }
  } catch (error) {
    log.warn(`A gap report of an arrival was not walked: ${error}`);
  } finally {
    applied.ready = true;
    const next = applied.pending;
    applied.pending = null;
    if (next) void applyLateGap(wt, next);
  }
  if (resumed) await resumed;
}

const CELLS_ON = clusterEnabled();

export default async function packetReceiver(
  server: any,
  wt: any,
  message: string,
  preParsed?: Packet
) {
  try {

    if (!message) return wt.close(1008, "Empty message");

    if (message.length > frameLimitFor(playerCache.get(wt.data.id), MAX_FRAME_BYTES, BENCHMARK_ENABLED)) {
      return wt.close(1009, "Message too large");
    }

    const parsedMessage: Packet = (preParsed ?? tryParsePacket(message)) as Packet;
    if (!parsedMessage) return wt.close(1007, "Malformed message");

    const data = parsedMessage?.data;
    const type = parsedMessage?.type;

    if (!type || (!data && data != null))
      return wt.close(1007, "Malformed message");

    if (!validPacketTypes.has(type as unknown as string)) {
      return wt.close(1007, "Invalid packet type");
    }

    const currentPlayer = playerCache.get(wt.data.id) || null;

    if (CELLS_ON && (wt.data?.handedOff || currentPlayer?.handoff) && type !== "PING" && type !== "PONG") return;

    if (currentPlayer?.cutscene && refusedWhileHeld(String(type), data, currentPlayer)) return;

    for (const interceptor of packetInterceptors) {
      if (interceptor(type, data, wt, currentPlayer)) {
        return;
      }
    }

    const pluginHandler = pluginHandlers.get(type);
    if (pluginHandler) {
      // Counted in flight, so a handoff's drain waits for it (cluster/inflight.ts). A single node calls it directly.
      if (CELLS_ON) await trackPacket(String(wt.data?.id ?? ""), () => pluginHandler(wt, currentPlayer, data, sendPacket));
      else await pluginHandler(wt, currentPlayer, data, sendPacket);
      return;
    }

    // Resolve a DB NPC's comma-separated particle names to full particle objects
    async function resolveNpcParticles(npc: Npc): Promise<Npc> {
      const particlesCache = await assetCache.get("particles") as any[] | null;
      const resolved = typeof npc.particles === "string" && npc.particles && particlesCache
        ? (npc.particles as string).split(",")
            .map((name: string) => particlesCache.find((p: any) => p.name === name.trim()))
            .filter(Boolean)
        : (Array.isArray(npc.particles) ? npc.particles : []);


      return { ...npc, particles: resolved as Particle[] };
    }

    async function resolveNpcForClient(npc: Npc): Promise<any> {
      const withParticles = await resolveNpcParticles(npc);
      return { ...withParticles, spriteLayers: getNpcSpriteLayers(npc) };
    }

    const routes = (handlerRoutes ??= await import("./handlers/index"));
    const handler = routes.route(String(type));
    if (!handler) {
      log.error(`Unknown packet type: ${type}`);
      return;
    }
    // Counted in flight once here, for the router and everything it awaits; a single node calls it directly.
    if (CELLS_ON) {
      return await trackPacket(String(wt.data?.id ?? ""), () => handler.handle({ server, wt, message, parsedMessage, data, type: String(type), currentPlayer, resolveNpcParticles, resolveNpcForClient }));
    }
    return await handler.handle({ server, wt, message, parsedMessage, data, type: String(type), currentPlayer, resolveNpcParticles, resolveNpcForClient });
  } catch (e) {
    log.error(e as string);
  }
}

export function queueFinalMovement(player: any) {
  if (!player?.aoi || !player.location?.position) return;
  const groupKey = player.aoi.layerId || layerManager.getPlayerLayer(player.id) || player.location.map;
  let group = movementBatchQueue.get(groupKey);
  if (!group) {
    group = new Map();
    movementBatchQueue.set(groupKey, group);
  }
  group.set(player.id, {
    i: player.id,
    d: {
      x: Number(player.location.position.x),
      y: Number(player.location.position.y),
      dr: player.location.position.direction,
    },
    r: globalStateRevision,
    s: player.isStealth ? 1 : 0,
    f: 1,
  });
}

export function queueRemoteMovement(mirror: any, final: boolean) {
  if (!mirror?.aoi || !mirror.location?.position) return;
  const groupKey = mirror.aoi.layerId || mirror.location.map;
  let group = movementBatchQueue.get(groupKey);
  if (!group) {
    group = new Map();
    movementBatchQueue.set(groupKey, group);
  }
  group.set(mirror.id, {
    i: mirror.id,
    d: {
      x: Number(mirror.location.position.x),
      y: Number(mirror.location.position.y),
      dr: mirror.location.position.direction,
    },
    r: globalStateRevision,
    s: mirror.isStealth ? 1 : 0,
    ...(final ? { f: 1 } : {}),
  });
}

export async function forceStopPlayerMovement(target: any) {
  if (!target) return;

  if (gameLoop.isPlayerMoving(target.id)) queueFinalMovement(target);
  gameLoop.unregisterMovingPlayer(target.id);
  target.moving = false;
  ghosts.touch("player", target.id);
  if (target._movementState) {
    target._movementState = undefined;
  }
  target._stepCarry = undefined;

  const cached = playerCache.get(target.id);
  if (cached && cached !== target) {
    cached.moving = false;
    cached._movementState = undefined;
    cached._stepCarry = undefined;
  }

  const wt = target.wt;
  if (wt && wt.readyState === 1) {
    globalStateRevision++;
    await sendPositionAnimation(
      wt,
      target.location?.position?.direction || "down",
      false,
      target.mounted,
      target.mount_type || "unicorn",
      undefined,
      globalStateRevision,
      target.casting || false
    );
  }
}

export async function interruptPlayerCast(target: any) {
  // fishing (castFish) ends with its line taken in, not with an interrupted cast bar: it never showed one
  const fishingCast = castingFish(target) || castingFish(playerCache.get(target.id));
  target.casting = false;
  target.castId = (target.castId || 0) + 1;
  target.lastInterruptTime = performance.now();

  if (target.castingSpellId && target.spellCooldowns) {
    delete target.spellCooldowns[target.castingSpellId];
    cooldownManager.deleteCooldown(target.username, target.castingSpellId);
    target.castingSpellId = undefined;
  }

  const cached = playerCache.get(target.id);
  if (cached && cached !== target) {
    cached.casting = false;
    cached.castId = target.castId;
    cached.lastInterruptTime = target.lastInterruptTime;
    if (cached.castingSpellId && cached.spellCooldowns) {
      delete cached.spellCooldowns[cached.castingSpellId];
    }
    cached.castingSpellId = undefined;
    playerCache.set(cached.id, cached);
  }

  if (fishingCast) {
    const ended = fishing.endSession(target.id);
    broadcastFishing(ended?.map ?? target.location.map, { id: target.id, state: "end" });
  } else {
    broadcastCastToAOI(
      target,
      packetManager.castSpell({ id: target.id, spell: 'interrupted', time: 1 })
    );
  }
  clearGroundPreviewForAOI(target, packetManager.groundAoeDespawn({ id: target.id + "_casting" }));

  restoreWalkingFacing(target);
  globalStateRevision++;
  if (target.wt) {
    await sendPositionAnimation(
      target.wt,
      target.location.position?.direction || "down",
      false,
      target.mounted,
      target.mount_type || "unicorn",
      undefined,
      globalStateRevision,
      false
    );
  }
}

export function generateGhostSpeak(): string {
  const wordCount = 1 + Math.floor(Math.random() * 4);
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    const len = 2 + Math.floor(Math.random() * 5);
    let word = "";
    for (let j = 0; j < len; j++) {
      word += Math.random() < 0.5 ? "o" : "O";
    }
    words.push(word);
  }
  const message = words.join(" ");
  return message.charAt(0).toUpperCase() + message.slice(1);
}

export const REVIVE_OFFER_RADIUS = 100;
export const GHOST_TELEPORT_DELAY_MS = 3000;
const REVIVE_OFFER_HIDE_RADIUS = 120;

export function checkGhostReviveProximity(player: any): void {
  if (!player.isGhost || !player.corpse) return;
  if (player.corpse.map !== player.location.map) {
    player.reviveOffered = false;
    return;
  }
  const dx = player.location.position.x - player.corpse.x;
  const dy = player.location.position.y - player.corpse.y;
  const dist2 = dx * dx + dy * dy;
  if (dist2 <= REVIVE_OFFER_RADIUS * REVIVE_OFFER_RADIUS) {
    if (!player.reviveOffered && player.wt) {
      player.reviveOffered = true;
      sendPacket(player.wt, packetManager.reviveOffer({ x: player.corpse.x, y: player.corpse.y }));
    }
  } else if (dist2 > REVIVE_OFFER_HIDE_RADIUS * REVIVE_OFFER_HIDE_RADIUS) {
    player.reviveOffered = false;
  }
  // Between offer and hide radius: sticky, neither offer nor re-arm.
}

export function findGraveyardSpawn(mapName: string, x: number, y: number): { x: number; y: number } {
  const mapProps = mapPropertiesCache.find((m: any) => m.name === `${mapName}.json`);
  if (mapProps?.graveyards && Array.isArray(mapProps.graveyards) && mapProps.graveyards.length > 0) {
    let closest = mapProps.graveyards[0];
    let closestDistance = Math.sqrt(
      Math.pow(x - closest.position.x, 2) + Math.pow(y - closest.position.y, 2)
    );
    for (const graveyard of mapProps.graveyards) {
      const distance = Math.sqrt(
        Math.pow(x - graveyard.position.x, 2) + Math.pow(y - graveyard.position.y, 2)
      );
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = graveyard;
      }
    }
    return { x: Math.round(closest.position.x), y: Math.round(closest.position.y) };
  }
  const defaultMapProps = mapPropertiesCache.find((m: any) => m.name === `${defaultMap}.json`);
  if (defaultMapProps?.spawn) return { x: Math.round(defaultMapProps.spawn.x), y: Math.round(defaultMapProps.spawn.y) };
  return {
    x: defaultMapProps ? Math.round((defaultMapProps.width * defaultMapProps.tileWidth) / 2) : 0,
    y: defaultMapProps ? Math.round((defaultMapProps.height * defaultMapProps.tileHeight) / 2) : 0,
  };
}

export async function handlePlayerDeath(target: any, killer: any, info: { damage: number; isCrit: boolean }) {
  // Already dead or a ghost: damage-over-time ticks must not re-kill.
  if (target.isDead || target.isGhost) return;

  const deathMap = target.location.map;
  const deathX = Math.round(target.location.position.x);
  const deathY = Math.round(target.location.position.y);

  // Leave a skeleton marker where the player died.
  skeletons.spawn(deathMap, deathX, deathY, target.username, layerManager.getPlayerLayer(target.id));

  target.stats.health = 0;
  target.stats.stamina = 0;
  target.mounted = false;
  await forceStopPlayerMovement(target);
  if (target.casting) {
    await interruptPlayerCast(target);
  }
  spellEffects.clearBarriers(target);
  dots.clearDots(target.id);
  spellEffects.clearStuns(target.id);
  spellEffects.clearSlows(target.id);
  spellEffects.clearVanishes(target.id);
  target.slowPercent = 0;
  target.slowMultiplier = 1;
  target.stunnedUntil = 0;
  spellEffects.broadcastEffectsUpdate(target);

  target.isDead = true;
  target.isGhost = false;
  target.corpse = { map: deathMap, x: deathX, y: deathY };
  target.reviveOffered = false;
  playerCache.set(target.id, target);
  try {
    await player.setDeadState(target.username, 1, target.corpse);
  } catch (e: any) {
    log.error(`Failed to persist death state for ${target.username}: ${e?.message || e}`);
  }

  const deathStats = { ...target.stats, health: 0, stamina: 0 };

  // A killer on another node (casterFor's stand-in) is not cached here: its own node updates it.
  if (killer && killer.id !== target.id && !killer.remote) {
    const syncedStats = await player.synchronizeStats(killer.username);
    if (syncedStats) {
      killer.stats = syncedStats;
    }
    playerCache.set(killer.id, killer);
    if (killer.wt) {
      sendPacket(
        killer.wt,
        packetManager.updateStats({
          target: killer.id,
          stats: killer.stats,
        })
      );
    }
  }

  globalStateRevision++;
  const deathPacket = packetManager.updateStats({
    id: killer?.id,
    target: target.id,
    stats: deathStats,
    isCrit: info.isCrit,
    damage: info.damage,
  });
  const playersInMap = filterPlayersByMap(target.location.map);
  playersInMap.forEach((p) => {
    sendPacket(p.wt, deathPacket);
  });
  // Cluster mode: the viewers of the target's mirrors on neighbouring nodes see them fall, with the killing number.
  relayToMirrorViewers(target, deathPacket, false);

  if (target.wt) {
    sendPacket(target.wt, packetManager.playerDied({ id: target.id, corpse: target.corpse }));
  }

  if (killer && !killer.remote) {
    sendStatsToPartyMembers(killer.username, killer.id, killer.stats);
  }
  sendStatsToPartyMembers(target.username, target.id, target.stats);
  listener.emit(Events.PLAYER_DEATH, { player: target, killer });
}

export function splashCreatures(caster: any, spell: SpellData, x: number, y: number, radius: number, excludeCreatureId: number | null) {
  const base = Number(spell.damage) || 0;
  if (base < 0 || !radius || radius <= 0) return;
  const level = caster.stats?.level || 1;
  const now = Date.now();
  for (const creature of creatures.creaturesInRadius(caster, x, y, radius)) {
    if (creature.id === excludeCreatureId) continue;
    if (creature.state === "evading") {
      // Immune while evading: this shows "Evading" and does nothing else.
      creatures.combat.damageCreature(creature, caster.id, 0, now);
      continue;
    }
    const text = { creatureId: creature.id, targetId: `creature:${creature.id}`, sourceId: caster.id };
    if (Math.random() * 100 < spellMissChance(level, creature.level)) {
      creatures.combat.damageCreature(creature, caster.id, 0, now);
      creatures.combat.emitCombatText({ ...text, kind: "resist", amount: 0 });
      continue;
    }
    if (base > 0) {
      const min = base + (level - 1) * 2;
      const max = base + (level - 1) * 5;
      const amount = Math.floor(Math.random() * (max - min + 1)) + min + (caster.stats?.stat_damage || 0);
      // A mirrored creature's text is shown by its owner, which needs the kind (emitCombatText does nothing for a mirror).
      const dealt = creatures.combat.damageCreature(creature, caster.id, amount, now, 1, creature.remote ? "spell" : null);
      creatures.combat.emitCombatText({ ...text, kind: "spell", amount: dealt });
    } else {
      creatures.combat.damageCreature(creature, caster.id, 0, now);
    }
    creatures.combat.applySpellToCreature(creature, caster.id, spell, now);
  }
}

/** 8-way facing from one point toward another (the sprite directions). */
export function directionToward(fromX: number, fromY: number, toX: number, toY: number): string {
  const ang = Math.atan2(toY - fromY, toX - fromX) * (180 / Math.PI);
  if (ang >= -22.5 && ang < 22.5) return "right";
  if (ang >= 22.5 && ang < 67.5) return "downright";
  if (ang >= 67.5 && ang < 112.5) return "down";
  if (ang >= 112.5 && ang < 157.5) return "downleft";
  if (ang >= 157.5 || ang < -157.5) return "left";
  if (ang >= -157.5 && ang < -112.5) return "upleft";
  if (ang >= -112.5 && ang < -67.5) return "up";
  return "upright";
}

export function faceToward(caster: any, x: number, y: number): void {
  const pos = caster?.location?.position;
  if (!pos || !Number.isFinite(x) || !Number.isFinite(y)) return;
  if (pos.x === x && pos.y === y) return;
  pos.direction = directionToward(pos.x, pos.y, x, y);
  playerCache.set(caster.id, caster);
}

function restoreWalkingFacing(caster: any): boolean {
  const pos = caster?.location?.position;
  const walking = String(caster?._movementState?.targetDirection ?? "");
  if (!caster?.moving || !pos || !VALID_DIRECTIONS.has(walking) || pos.direction === walking) return false;
  pos.direction = walking;
  playerCache.set(caster.id, caster);
  return true;
}

export async function blockEquipmentChangeWhilePvp(wt: any, currentPlayer: any, slot: unknown): Promise<boolean> {
  if (!currentPlayer?.pvp || !slot) return false;
  sendPacket(wt, packetManager.notify({ message: "You can't change equipment while in combat." }));
  sendPacket(wt, packetManager.equipment(currentPlayer.equipment));
  sendPacket(wt, packetManager.inventory(currentPlayer.inventory, await getInventorySlots(currentPlayer)));
  return true;
}

/** restoreWalkingFacing, then show the turn with a walking animation. */
export async function resumeWalkingFacing(wt: any, caster: any): Promise<void> {
  if (!restoreWalkingFacing(caster)) return;
  globalStateRevision++;
  await sendPositionAnimation(wt, caster.location.position.direction, true, caster.mounted || false, caster.mount_type || "unicorn", undefined, globalStateRevision, caster.casting || false);
}

export async function castSpellOnCreature(wt: any, currentPlayer: any, spell: SpellData, creatureId: number) {
  const spellId = spell.id as number;
  const fail = (reason: string, message?: string) => {
    if (message) sendPacket(wt, packetManager.notify({ message }));
    listener.emit(Events.SPELL_FAILED, { player: currentPlayer, target: null, spellName: spell.name, reason } as any);
  };
  const resetCooldown = () => {
    const fresh = playerCache.get(currentPlayer.id);
    if (fresh?.spellCooldowns) {
      delete fresh.spellCooldowns[spellId];
      cooldownManager.deleteCooldown(fresh.username, spellId);
      playerCache.set(fresh.id, fresh);
    }
  };
  const inRangeWithSight = (creature: any): string | null => {
    if (!creatures.isTargetableBy(currentPlayer, creature)) return "invalid_target";
    const pos = currentPlayer.location.position;
    if (Math.hypot(pos.x - creature.x, pos.y - creature.y) > (spell.range || 100)) return "range";
    if (!creatures.hasLineOfSight(currentPlayer, creature)) return "path_blocked";
    return null;
  };

  const creature = creatures.getCreature(creatureId);
  // A corpse can be targeted, but not cast at.
  if (creature?.state === "dead") return fail("invalid_target", "Your target is dead.");
  if (!creature || !creatures.isTargetableBy(currentPlayer, creature)) return fail("invalid_target", "Target not found.");
  const spellDamage = Number(spell.damage) || 0;
  const creatureEffects = new Set(["damage_over_time", "stun", "slow", "interrupt", "taunt", "threat"]);
  const hasCreatureEffects = Array.isArray(spell.effects) && spell.effects.some((e) => creatureEffects.has(e?.type));
  if (spellDamage < 0 || (spellDamage === 0 && !hasCreatureEffects)) return fail("invalid_target", "You can't cast that on this target.");
  if ((spell.aoe_radius && spell.aoe_radius > 0) || spell.ground_aoe) return fail("invalid_target", "That spell can't be used on this target yet.");

  currentPlayer.spellCooldowns = currentPlayer.spellCooldowns || {};
  if ((currentPlayer.spellCooldowns[spellId] || 0) > performance.now()) return fail("cooldown");

  currentPlayer.interruptableSpell = !spell.can_move;
  // Pressed while moving: nothing started, so nothing happens or shows.
  if (!spell.can_move && currentPlayer.moving) return fail("moving");

  const manaCost = spellManaCost(spell.mana || 0, currentPlayer.stats);
  if ((currentPlayer.stats.stamina || 0) < manaCost) return fail("mana");

  const preflight = inRangeWithSight(creature);
  if (preflight === "range") return fail("range", "Target is out of range");
  if (preflight === "path_blocked") return fail("path_blocked", "Target is not in line of sight");
  if (preflight) return fail(preflight, "Target not found.");

  const cooldownEnd = performance.now() + (spell.cooldown || 0) * 1000;
  currentPlayer.spellCooldowns[spellId] = cooldownEnd;
  cooldownManager.setCooldown(currentPlayer.username, spellId, cooldownEnd);
  currentPlayer.lastCastTime = performance.now();
  currentPlayer.castingSpellId = spellId;
  currentPlayer.casting = true;
  currentPlayer.castOnSelf = false;
  currentPlayer.castId = (currentPlayer.castId || 0) + 1;
  currentPlayer.mounted = false;
  const thisCastId = currentPlayer.castId;
  const castStart = performance.now();
  playerCache.set(currentPlayer.id, currentPlayer);

  // Face the creature, as with player targets, so the cast is aimed at it.
  faceToward(currentPlayer, creature.x, creature.y);
  const direction = currentPlayer.location.position?.direction || "down";
  globalStateRevision++;
  await sendPositionAnimation(wt, direction, currentPlayer.moving || false, false, currentPlayer.mount_type || "unicorn", undefined, globalStateRevision, true);
  broadcastCastToAOI(currentPlayer, packetManager.castSpell({ id: currentPlayer.id, spell: spell.name, time: spell.cast_time }));

  await new Promise((resolve) => setTimeout(resolve, (spell.cast_time || 0) * 1000));

  const after = playerCache.get(currentPlayer.id);
  if (!after || after.castId !== thisCastId) return;
  if (after.manualSpellCancel && after.manualSpellCancel >= castStart) {
    delete after.manualSpellCancel;
    after.casting = false;
    playerCache.set(after.id, after);
    await resumeWalkingFacing(wt, after);
    return resetCooldown();
  }
  if (!spell.can_move && !after.casting) return resetCooldown();
  after.casting = false;
  playerCache.set(after.id, after);
  const creatureNow = creatures.getCreature(creatureId);
  if (creatureNow) faceToward(after, creatureNow.x, creatureNow.y);
  restoreWalkingFacing(after);
  globalStateRevision++;
  await sendPositionAnimation(wt, after.location.position?.direction || direction, after.moving || false, false, after.mount_type || "unicorn", undefined, globalStateRevision, false);

  // Re-validate at completion: the creature may have died, evaded, moved or broken sight.
  const target = creatures.getCreature(creatureId);
  const finalCheck = target ? inRangeWithSight(target) : "invalid_target";
  if (!target || finalCheck || after.isDead) {
    broadcastCastToAOI(after, packetManager.castSpell({ id: after.id, spell: "failed", time: 1 }));
    resetCooldown();
    return fail(finalCheck || "invalid_target", finalCheck === "range" ? "Target is out of range" : finalCheck === "path_blocked" ? "Target is not in line of sight" : undefined);
  }
  if ((after.stats.stamina || 0) < manaCost) {
    resetCooldown();
    return fail("mana");
  }
  after.stats.stamina = Math.max(0, after.stats.stamina - manaCost);

  if (after.isVanished) {
    const vanishId = spellEffects.getVanishedEffectId(after);
    if (vanishId) {
      cancelEffect(after, vanishId);
      spellEffects.broadcastEffectsUpdate(after);
    }
  }

  const travelMs = projectileTravelMs(Math.hypot(after.location.position.x - target.x, after.location.position.y - target.y));
  const creatureParticles = resolveSpellParticles(spell, (await readHeldList<Particle>("particles")));
  const projectile = packetManager.projectile({
    id: after.id,
    time: travelMs / 1000,
    target_id: `c:${target.id}`,
    spell: spell.name,
    icon: getIconUrl(spell.icon),
    creature: true,
    particles: creatureParticles,
  });
  if (projectile.length) {
    for (const p of filterPlayersByMap(after.location.map)) sendPacketBestEffort(p.wt, projectile);
    relayToMirrorViewers(after, projectile, true);
  }

  if (travelMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, travelMs));
    // The creature may have died while the projectile was in flight.
    const stillThere = creatures.getCreature(creatureId);
    if (!stillThere || stillThere.state === "dead") return;
  }

  // Evading creatures are immune: the hit lands as "Evading", nothing else.
  if (target.state === "evading") {
    creatures.combat.damageCreature(target, after.id, 0, Date.now());
    return;
  }

  const now = Date.now();
  const playerLevel = after.stats.level || 1;
  const textBase = { creatureId: target.id, targetId: `creature:${target.id}`, sourceId: after.id };
  if (Math.random() * 100 < spellMissChance(playerLevel, target.level)) {
    // A resisted spell still pulls the creature.
    creatures.combat.damageCreature(target, after.id, 0, now);
    creatures.combat.emitCombatText({ ...textBase, kind: "resist", amount: 0 });
  } else if (spellDamage === 0) {
    creatures.combat.damageCreature(target, after.id, 0, now);
    creatures.combat.applySpellToCreature(target, after.id, spell, now);
  } else {
    const minDamage = spellDamage + (playerLevel - 1) * 2;
    const maxDamage = spellDamage + (playerLevel - 1) * 5;
    const rolled = Math.floor(Math.random() * (maxDamage - minDamage + 1)) + minDamage + (after.stats.stat_damage || 0);
    const isCrit = Math.random() * 100 < (after.stats.stat_critical_chance || 0);
    const amount = Math.round(isCrit ? rolled * (1.5 + (after.stats.stat_critical_damage || 0) / 100) : rolled);
    // A mirrored creature's text is shown by its owner, which needs the kind (emitCombatText does nothing for a mirror).
    const dealt = creatures.combat.damageCreature(target, after.id, amount, now, 1, target.remote ? (isCrit ? "crit" : "spell") : null);
    creatures.combat.emitCombatText({ ...textBase, kind: isCrit ? "crit" : "spell", amount: dealt });
    if (hasCreatureEffects) creatures.combat.applySpellToCreature(target, after.id, spell, now);
  }

  playerCache.set(after.id, after);
  broadcastToAOIBestEffort(after, packetManager.updateStats({ id: after.id, target: after.id, stats: after.stats }));
  sendStatsToPartyMembers(after.username, after.id, after.stats);
  listener.emit(Events.SPELL_CAST, { player: after, spellName: spell.name, target: null, isEntityTarget: false, creatureId: target.id } as any);
}

dots.setPlayerDeathHandler(handlePlayerDeath);

// A player held in a cutscene is out of harm's way: a creature's blow, daze or spell does not reach them (cutsceneheld.ts).
setCreatureEngineBridge({
  damagePlayer: async (target, amount, info) => {
    if (target.isDead || target.isGhost || !target.stats || isHeld(target)) return;
    const absorbed = spellEffects.consumeBarrier(target, amount);
    if (absorbed > 0) spellEffects.broadcastEffectsUpdate(target);
    target.stats.health = Math.max(0, Math.round(target.stats.health - (amount - absorbed)));
    const attacker = { id: `creature:${info.creatureId}`, username: info.creatureName, isCreature: true };
    listener.emit(Events.PLAYER_DAMAGED, { attacker, target, damage: amount, isCrit: info.isCrit });
    playerCache.set(target.id, target);
    if (target.stats.health <= 0) {
      await handlePlayerDeath(target, null, { damage: amount, isCrit: info.isCrit });
      return;
    }
    broadcastStatsUpdateToAOI(
      target,
      target,
      packetManager.updateStats({ id: target.id, target: target.id, stats: target.stats, isCrit: info.isCrit, damage: amount, absorb: absorbed })
    );
    sendStatsToPartyMembers(target.username, target.id, target.stats);
  },
  dazePlayer: async (target) => {
    if (target.isDead || target.isGhost || isHeld(target)) return;
    const dazed = { name: "dazed", icon: null, effects: [{ type: "slow", value: 50, duration: 4 }] } as unknown as SpellData;
    await spellEffects.applySpellEffects(dazed, target, target, () => {}, (p: any) => spellEffects.broadcastEffectsUpdate(p));
  },
  applySpellEffects: async (target, caster, spell) => {
    if (target.isDead || target.isGhost || isHeld(target)) return;
    await spellEffects.applySpellEffects(
      spell,
      caster,
      target,
      (p: any) => broadcastStatsUpdateToAOI(p, p, packetManager.updateStats({ id: p.id, target: p.id, stats: p.stats })),
      (p: any) => spellEffects.broadcastEffectsUpdate(p)
    );
  },
});
setPlayerDeathHandler(handlePlayerDeath);
// Cluster mode: a ground AoE zone's tick on a player of a neighbouring node goes to that player's owner, which applies it.
setMirrorZoneHitHandler((caster, mirror, zone, damage) => hitRemotePlayer(caster, mirror, remoteHit(caster, zone.spell ? { ...zone.spell, effects: zone.effects ?? [] } : null, damage, false, {
  skipEffects: !zone.spell || !zone.effects?.length,
  showsDamage: damage !== 0,
  harmful: zone.damageType !== "heal",
})));

setCutsceneBridge({
  send: (target, packets) => sendPacket(target.wt, packets),
  hold: async (target) => {
    // A step still being handled is stale from here: it must not set the player walking again after they are stopped.
    target._moveSeq = (target._moveSeq ?? 0) + 1;
    await forceStopPlayerMovement(target);
    if (target.casting) await interruptPlayerCast(target);
  },
  teleport: (target, map, x, y) => placePlayer(target, map, x, y),
});

achievements.setBridge({
  syncInventory: async (target) => {
    target.inventory = await patchInventoryBagSlots(await inventory.get(target.username), target.username);
    playerCache.set(target.id, target);
    sendPacket(target.wt, packetManager.inventory(target.inventory, await getInventorySlots(target)));
  },
  sendCollectables: async (target) => {
    // As at login (socket/authentication.ts): each mount with its icon, a mount that no longer exists left out.
    const mounts = new Map((((await assetCache.get("mounts")) || []) as any[]).map((m: any): [string, any] => [String(m.name).toLowerCase(), m]));
    target.collectables = (((await collectables.list(target.username)) || []) as any[])
      .filter((c: any) => c.type !== "mount" || mounts.has(String(c.item).toLowerCase()))
      .map((c: any) => ({ type: c.type, item: c.item, icon: c.type === "mount" ? (mounts.get(String(c.item).toLowerCase())?.icon ?? null) : null }));
    playerCache.set(target.id, target);
    sendPacket(target.wt, packetManager.collectables(target.collectables.map((c: any) => ({ ...c, iconUrl: getIconUrl(c.icon), icon: undefined }))));
  },
  sendMailNotice: (target) => sendMailNotice(target),
});

playerEditor.setPlayerEditorBridge({
  syncInventory: async (target) => {
    target.inventory = await patchInventoryBagSlots(await inventory.get(target.username), target.username);
    sendPacket(target.wt, packetManager.inventory(target.inventory, await getInventorySlots(target)));
  },
  broadcastStats: async (target) => {
    broadcastToAOIBestEffort(target, packetManager.updateStats({ target: target.id, stats: target.stats }), false);
    await sendStatsToPartyMembers(target.username, target.id, target.stats);
  },
  refreshAppearance: async (target) => {
    const animationName = getAnimationNameForDirection(
      target.location.position?.direction || "down",
      !!target.moving,
      !!target.mounted,
      target.mount_type || undefined,
      !!target.casting
    );
    await sendSpriteSheetAnimation(target.wt, animationName, target.id);
  },
  sendCollectables: (target) => {
    // Icon names become asset server URLs, as at login.
    const withIconUrls = (target.collectables || []).map((c: any) => ({ ...c, iconUrl: getIconUrl(c.icon), icon: undefined }));
    sendPacket(target.wt, packetManager.collectables(withIconUrls));
  },
  sendSpells: (target) => {
    const spellBook: Record<string, any> = {};
    for (const [name, spell] of Object.entries(target.learnedSpells || {}) as [string, any][]) {
      spellBook[name] = { ...spell, spriteUrl: getSpriteUrl(spell.icon) };
    }
    sendPacket(target.wt, packetManager.spells(spellBook));
  },
  announce: (target) => broadcastPlayerUpdate(target),
  syncPartyLayers: (leader, members) => syncPartyLayers(leader, members, playerCache, sendAnimationTo),
  relocate: async (target, map, x, y, direction) => {
    if (CELLS_ON && inHandoff(target)) {
      log.info(`Relocation of ${target.username} skipped: the player is changing server node`);
      return;
    }
    await forceStopPlayerMovement(target);
    if (map !== String(target.location?.map ?? "").replace(".json", "")) {
      target.location.position.direction = direction;
      await player.setLocation(target.id, map, { x, y, direction });
      await teleportPlayerWrapper(target, map, x, y);
      return;
    }
    target.location.position = { ...target.location.position, x, y, direction };
    ghosts.touch("player", target.id);
    globalStateRevision++;
    if (shouldUpdateAOI(target)) {
      await updatePlayerAOI(target, spawnBatchQueue, despawnBatchQueue);
    }
    broadcastToAOI(target, packetManager.moveXY({
      i: target.id,
      d: { x, y, dr: direction },
      r: globalStateRevision,
      s: target.isStealth ? 1 : 0,
    }), true);
    await resyncNpcChunks(target, target.wt);
  },
});

controlPanel.setControlPanelBridge({
  restartScheduled: () => !!restartState.scheduled,
  status: () => ({
    eventLoopLagMs: getEventLoopLagMs(),
    whitelistEnabled: isWhitelistEnabled(),
    whitelisted: realmWhitelist.size,
    creatures: creatures.stats(),
  }),
  worlds: async () => {
    const rows = (await assetCache.get("weather") as WeatherData[]) || [];
    const live = { look: weatherApi.shownAs(weatherApi.WEATHER_API), row: weatherApi.currentWeather() };
    return (await getLiveWorlds()).map((world) => ({
      name: world.name,
      ...controlPanel.worldWeather(world.weather, resolvedWeatherCache.get(world.name), live, rows),
      players: Number(world.players) || 0,
    }));
  },
});

export async function runForControlPanel(wt: any, run: controlPanel.PanelRun, options: controlPanel.PanelRunOptions = {}): Promise<string[]> {
  const replies: string[] = [];
  const stood = "command" in run ? { type: "COMMAND", data: { command: "" } } : { type: run.packet, data: null };
  if ("command" in run) panelCommands.set(stood, { name: run.command, args: run.args });
  panelReplies.set(wt, replies);
  try {
    await packetReceiver(null, wt, "control panel", stood as unknown as Packet);
    // A command for a player on another node ends once it is sent: the answer comes from that node, by name.
    if (options.awaitReply && clusterEnabled()) {
      const until = Date.now() + PANEL_REPLY_MS;
      while (replies.length === 0 && Date.now() < until) await Bun.sleep(PANEL_REPLY_POLL_MS);
    }
  } finally {
    panelReplies.delete(wt);
  }
  return replies;
}

hearDeliveries(panelHears);

spellEffects.setStunMovementHandler(forceStopPlayerMovement);

spellEffects.setVanishRemovedHandler(async (player) => {
  const map = player.location?.map;
  if (!map) return;
  const spawnData = queueSpawnPlayerPacket(player);
  if (!spawnData) return;

  // Fetch sprite data like the stealth handler does
  const animationName = getAnimationNameForDirection(
    player.location.position?.direction || "down",
    !!player.moving,
    !!player.mounted,
    player.mount_type,
    !!player.casting
  );
  const playerSpriteData = await getPlayerSpriteSheetData(animationName, player.equipment || null);
  const mountSpriteForBatch = player.mount_type ? getMountSpriteUrl(player.mount_type) : null;
  if (playerSpriteData?.bodySprite || playerSpriteData?.headSprite || mountSpriteForBatch) {
    (spawnData as any).spriteData = {
      mountSprite: mountSpriteForBatch,
      bodySprite: playerSpriteData.bodySprite || null,
      headSprite: playerSpriteData.headSprite || null,
      armorHelmetSprite: playerSpriteData.armorHelmetSprite || null,
      armorShoulderguardsSprite: playerSpriteData.armorShoulderguardsSprite || null,
      armorNeckSprite: playerSpriteData.armorNeckSprite || null,
      armorHandsSprite: playerSpriteData.armorHandsSprite || null,
      armorChestSprite: playerSpriteData.armorChestSprite || null,
      armorFeetSprite: playerSpriteData.armorFeetSprite || null,
      armorLegsSprite: playerSpriteData.armorLegsSprite || null,
      armorWeaponSprite: playerSpriteData.armorWeaponSprite || null,
      animationState: playerSpriteData.animationState,
    };
  }

  const spawnPacket = packetManager.spawnPlayer(spawnData);
  if (!Array.isArray(spawnPacket)) return;
  const allOnMap = filterPlayersByMap(map);
  allOnMap.forEach((p) => {
    if (p.id === player.id) return;
    sendPacket(p.wt, spawnPacket);
  });
});

const DEFAULT_INTERRUPT_LOCKOUT_SECONDS = 3;

registerSpellEffect("interrupt", ({ target, effect }) => {
  if (!target?.stats) return; // players only - entities do not cast
  const fresh = playerCache.get(target.id) || target;
  if (!fresh.casting || !fresh.interruptableSpell) return;

  interruptPlayerCast(fresh).catch((e) => log.error(`Failed to interrupt cast: ${e}`));

  const lockoutSec = effect.duration && effect.duration > 0 ? effect.duration : DEFAULT_INTERRUPT_LOCKOUT_SECONDS;
  fresh.spellLockoutUntil = performance.now() + lockoutSec * 1000;
  cooldownManager.setLockout(fresh.username, performance.now() + lockoutSec * 1000);
  playerCache.set(fresh.id, fresh);

  if (fresh.wt) {
    sendPacket(fresh.wt, packetManager.spellLockout({ duration: lockoutSec }));
  }
  listener.emit(Events.SPELL_INTERRUPTED, { player: fresh });
});

listener.on(Events.SPELL_INTERRUPTED, async ({ player }) => {
  if (!player?.casting || !player?.interruptableSpell) return;
  await interruptPlayerCast(player);
});

export function filterPlayersByMap(map: string) {

  const playerIds = mapIndex.getPlayersOnMap(map);
  const players: any[] = [];
  for (const playerId of playerIds) {
    const player = playerCache.get(playerId);
    if (player) {
      players.push(player);
    }
  }
  return players;
}

function parsePos(pos: any): { x: number; y: number } {
  if (typeof pos === 'string') {
    const [x, y] = pos.split(',');
    return { x: Number(x), y: Number(y) };
  }
  return { x: pos?.x ?? 0, y: pos?.y ?? 0 };
}

const TARGET_GRID_PAD_PX = Math.max(128, (Number(AOI_CONFIG.UPDATE_THRESHOLD) || 100) + 32);
const TARGET_GRID_CELL_PX = Number(AOI_CONFIG.GRID_CELL_SIZE) || 512;

/** Whether the session of `player` is still the one this node holds (a player who left, or logged in elsewhere, is not). */
function stillHere(player: any): boolean {
  const live = playerCache.get(player.id);
  return !!live && live.wt === player.wt;
}

async function receiveHanded<T extends { name: string; quantity: number }>(player: any, items: T[], copper: number, call = "hand-over", grantId?: unknown): Promise<T[] | null> {
  if (items.length === 0 && copper <= 0) return [];
  // The hand-over this node claimed, if the owner parked one: its id is written with the items (grantwrites.ts).
  const id = typeof grantId === "string" ? grantId : null;
  const lostText = `${JSON.stringify(items.map((item) => ({ name: item.name, quantity: item.quantity })))}, ${copper} copper`;
  // The session may have ended during the round trip: another node can hold this player's rows by now.
  if (!stillHere(player)) {
    await parkAgain(player.username, items, copper, call, `Items handed over by another node were lost for ${player.username}, who left meanwhile: ${lostText}`, id);
    return null;
  }
  const added: T[] = [];
  try {
    const balance = await atomically([player.username], async (batch) => {
      added.length = 0;
      if (id) await recordGrantWrite(batch, id);
      for (const item of items) {
        if (await inventory.add(player.username, { name: item.name, quantity: item.quantity } as any, batch)) added.push(item);
      }
      return copper > 0 ? await currencySystem.add(player.username, { copper, silver: 0, gold: 0 }, batch) : null;
    });
    for (const item of items) {
      if (!added.includes(item)) log.error(`Item handed over by another node was lost for ${player.username}: ${item.quantity} x ${item.name} is not an item`);
    }
    if (balance) {
      sendPacket(player.wt, packetManager.currency(balance));
      sendPacket(player.wt, packetManager.notify({ message: `You receive loot: ${formatMoney(copper)}` }));
    }
    return added;
  } catch (error) {
    if (id && grantWrittenBefore(error)) {
      log.info(`Hand-over ${id} for ${player.username} was written before: not written again (${lostText})`);
      return null;
    }
    const lost = `Items handed over by another node were lost for ${player.username}: ${lostText}: ${error}`;
    if (nothingWritten(error)) await parkAgain(player.username, items, copper, call, lost, id);
    else log.error(lost);
    return null;
  }
}

async function parkAgain(username: string, items: Array<{ name: string; quantity: number }>, copper: number, call: string, lost: string, grantId: string | null = null): Promise<void> {
  const parked: string[] = [];
  try {
    const rows = items.map((item) => ({ itemName: item.name, quantity: item.quantity }));
    let at = 0;
    do {
      const id = await grants.park({ username, items: rows.slice(at, at + MAX_GRANT_ITEMS), copper: at === 0 ? copper : 0, call }, at === 0 && grantId ? grantId : undefined);
      if (!id) throw new Error("the grant store did not take it");
      parked.push(id);
      at += MAX_GRANT_ITEMS;
    } while (at < rows.length);
  } catch {
    // Rows parked before the failure are given by their own grants, which their park line names.
    log.error(parked.length > 0 ? `${lost} (except what hand-over(s) ${parked.join(", ")} hold)` : lost);
    return;
  }
  log.warn(`Items handed over by another node could not be written for ${username}: they are parked again as hand-over(s) ${parked.join(", ")}`);
}

/** The players with a call to a neighbouring node's items under way, by lowercase name. */
const itemCallsUnderWay = new Set<string>();
/** What a player is told when a call of theirs is refused for another being under way. */
export const ITEM_CALL_BUSY = "You are already doing that. Try again in a moment.";

async function oneItemCallAtATime<T, R>(owner: string | null, player: any, refused: () => R, run: () => Promise<T>): Promise<T | R> {
  if (!owner) return run();
  const key = String(player.username).toLowerCase();
  if (itemCallsUnderWay.has(key)) return refused();
  itemCallsUnderWay.add(key);
  try {
    return await run();
  } finally {
    itemCallsUnderWay.delete(key);
  }
}

/** Opens a corpse for a player here: this node's corpse as before, or a neighbouring node's (LOOT_OPEN). A reason when it cannot. */
export async function openCorpseHere(player: any, creatureId: number): Promise<{ items: CorpseItem[]; copper: number } | string> {
  return oneItemCallAtATime(itemOwner("LOOT_OPEN", creatureId), player, () => "busy", async () => {
    const asked = await askOwner("LOOT_OPEN", creatureId, player, { creatureId });
    if (!asked) return creatures.openCorpseFor(player, creatureId);
    return asked.ok ? { items: (asked.items as CorpseItem[]) || [], copper: Number(asked.copper) || 0 } : String(asked.reason ?? "failed");
  });
}

/** Takes from a corpse for a player here: from this node's corpse as before, or from a neighbouring node's (LOOT_TAKE). */
export async function takeCorpseLootHere(player: any, creatureId: number, indices: number[] | null) {
  const owner = itemOwner("LOOT_TAKE", creatureId);
  if (!owner) return creatures.takeCorpseLootFor(player, creatureId, indices);
  // Held across the read of the bags too: the room is a database read for every packet that gets this far.
  return oneItemCallAtATime(owner, player, () => "busy" as LootError, async () => {
    const asked = await askOwner("LOOT_TAKE", creatureId, player, { creatureId, indices, room: await bagRoom(player.username) });
    if (!asked?.ok) return ((asked?.reason as LootError | undefined) ?? "failed") as LootError;
    const taken = (asked.items as CorpseItem[]) || [];
    const copper = Number(asked.copper) || 0;
    const added = await receiveHanded(player, taken.map((item) => ({ name: item.itemName, quantity: item.quantity, item })), copper, "LOOT_TAKE", asked.grantId);
    if (added === null) return "failed" as LootError;
    // As on the owner's own node, only what was really added is told to the player and counted.
    for (const { item } of added) {
      sendPacket(player.wt, packetManager.lootReceived({ itemName: item.itemName, quantity: item.quantity, quality: item.quality || "common" }));
      listener.emit(Events.PLAYER_LOOT_RETRIEVED, { player, itemName: item.itemName, quantity: item.quantity, mapName: bareMap(player.location?.map), x: player.location?.position?.x, y: player.location?.position?.y } as any);
    }
    if (asked.empty) sendPacket(player.wt, packetManager.creatureLootable({ id: creatureId, lootable: false }));
    return { taken, empty: !!asked.empty, full: !!asked.full, remaining: (asked.remaining as CorpseItem[]) || [], copper: 0 };
  });
}

export async function pickupLootHere(player: any, lootId: string): Promise<{ added: boolean; message?: string }> {
  return oneItemCallAtATime(itemOwner("PICKUP_REQUEST", String(lootId)), player, () => ({ added: false, message: ITEM_CALL_BUSY }), async () => {
    const asked = await askOwner("PICKUP_REQUEST", String(lootId), player, { lootId: String(lootId) });
    const result = asked
      ? { success: asked.ok, message: asked.reason, item: asked.item as any }
      : loot.pickup(player, lootId);
    if (!result.success || !result.item) return { added: false, message: result.message || "Could not pick up loot." };

    const lootItem = result.item;
    const lost = `Loot handed over by another node was lost for ${player.username}: ${lootItem.item} x${lootItem.quantity}`;
    const handed = [{ name: String(lootItem.item), quantity: Number(lootItem.quantity) || 1 }];
    const grantId = typeof asked?.grantId === "string" ? asked.grantId : null;
    if (asked && !stillHere(player)) {
      await parkAgain(player.username, handed, 0, "PICKUP_REQUEST", `${lost}, who left meanwhile`, grantId);
      return { added: false };
    }
    let addResult;
    try {
      // A handed-over item is written as one batch, so a failure says whether anything was written (nothingWritten).
      addResult = asked
        ? await atomically([player.username], async (batch) => {
          if (grantId) await recordGrantWrite(batch, grantId);
          return await inventory.add(player.username, { name: lootItem.item, quantity: lootItem.quantity }, batch);
        })
        : await inventory.add(player.username, { name: lootItem.item, quantity: lootItem.quantity });
    } catch (error) {
      if (!asked) throw error;
      if (grantId && grantWrittenBefore(error)) {
        log.info(`Hand-over ${grantId} for ${player.username} was written before: not written again (${lootItem.item} x${lootItem.quantity})`);
        return { added: false };
      }
      if (nothingWritten(error)) await parkAgain(player.username, handed, 0, "PICKUP_REQUEST", `${lost}: ${error}`, grantId);
      else log.error(`${lost}: ${error}`);
      return { added: false };
    }
    if (!addResult) {
      if (asked) log.error(lost);
      return { added: false };
    }
    // The owner leaves this hook to the player's node.
    if (asked) listener.emit(Events.PLAYER_LOOT_RETRIEVED, { player, itemName: lootItem.item, quantity: lootItem.quantity, mapName: lootItem.map, x: lootItem.x, y: lootItem.y } as any);
    return { added: true };
  });
}

/** The packets that answer opening a chest a neighbouring node owns (CHEST_OPEN). Null when this node owns it. */
export async function openChestOnOwner(player: any, chestId: string): Promise<any[] | null> {
  return oneItemCallAtATime(itemOwner("CHEST_OPEN", chestId), player, () => packetManager.notify({ message: ITEM_CALL_BUSY }), async () => {
    const asked = await askOwner("CHEST_OPEN", chestId, player, { chestId });
    if (!asked) return null;
    const items = (asked.items as any[]) || [];
    if (!asked.ok) return packetManager.notify({ message: asked.reason || "Could not open chest." });
    if (items.length === 0) return packetManager.notify({ message: "This chest is empty for you." });
    return packetManager.lootChestContents({ chestId, items });
  });
}

/** Takes chest items for a player here (all of them when `indices` is null), from this node's chest or a neighbour's (CHEST_TAKE). */
export async function takeChestItems(player: any, chestId: string, indices: number[] | null): Promise<{ taken: any[]; remaining: any[]; allTaken: boolean } | null> {
  // A refused take is null, which the packet case answers "Could not take items.": nothing was sent or taken.
  return oneItemCallAtATime(itemOwner("CHEST_TAKE", chestId), player, () => null, async () => {
    const asked = await askOwner("CHEST_TAKE", chestId, player, { chestId, indices });
    if (!asked) {
      if (indices) return lootChest.takeItems(chestId, String(player.id), player.username, indices);
      const all = await lootChest.takeAllItems(chestId, String(player.id), player.username);
      return all ? { ...all, remaining: [] } : null;
    }
    if (!asked.ok) return null;
    const taken = (asked.items as any[]) || [];
    if ((await receiveHanded(player, taken.map((item) => ({ name: item.itemName, quantity: item.quantity })), 0, "CHEST_TAKE", asked.grantId)) === null) return null;
    return { taken, remaining: (asked.remaining as any[]) || [], allTaken: !!asked.allTaken };
  });
}

/** getPlayersNearPoint, and the mirrored players the same query finds: what an area spell may hit. */
export function playersAndMirrorsNear(x: number, y: number, map: string, radius: number, layerId: string | null | undefined): any[] {
  const players = getPlayersNearPoint(x, y, map, radius, layerId);
  for (const mirror of mirrorsOnLayerNear(map, x, y, radius, layerId)) players.push(mirror);
  return players;
}

/** What the inspect window is sent of `target`: their whole inventory when `whole`, else only the rows of what they wear. */
export function inspectPlayerData(target: any, whole: boolean) {
  const worn = new Set(Object.values(target.equipment || {}).filter(Boolean).map((name: any) => String(name)));
  return {
    id: target.id,
    stats: target.stats,
    username: target.username,
    equipment: target.equipment || {},
    inventory: whole ? (target.inventory || []) : (target.inventory || []).filter((row: any) => worn.has(String(row?.name))),
  };
}

/** The players within `distance` of the caster (filterPlayersByDistance), and the mirrored players on the caster's layer in it too. */
export function withMirrors(wt: any, distance: number, map: string): any[] {
  const result = filterPlayersByDistance(wt, distance, map);
  const caster = playerCache.get(wt.data.id);
  const pos = caster?.location?.position;
  if (!caster || !pos || mirrorPlayers.size === 0) return result;
  const layerId = caster.aoi?.layerId || layerManager.getPlayerLayer(caster.id) || null;
  const at = parsePos(pos);
  for (const mirror of mirrorsNearPoint(caster.location.map, at.x, at.y, distance)) {
    if (layerId && (playerLayer(mirror.id) ?? null) !== layerId) continue;
    result.push(mirror);
  }
  return result;
}

/** A hit from `caster` on a mirrored player, as sent to that player's owner. */
export function remoteHit(caster: any, spell: any, damage: number, isCrit: boolean, how: { skipEffects?: boolean; showsDamage: boolean; harmful: boolean }): PlayerHit {
  return {
    casterId: String(caster.id),
    casterName: caster.username,
    casterStats: caster.stats,
    casterLocation: { map: caster.location.map, position: { ...caster.location.position } },
    casterLayer: caster.aoi?.layerId || layerManager.getPlayerLayer(caster.id) || null,
    casterParty: [...(caster.party ?? [])],
    spell: spell ?? null,
    damage,
    isCrit,
    skipEffects: !!how.skipEffects,
    showsDamage: how.showsDamage,
    harmful: how.harmful,
  };
}

export async function hitRemotePlayer(caster: any, target: any, hit: PlayerHit): Promise<boolean> {
  const result = await sendPlayerHit(target, hit);
  if (!result || (result.outcome !== "applied" && result.outcome !== "killed")) return false;
  if (hit.harmful && !hit.casterParty.includes(target.username)) setPlayerPvp(caster, true);
  caster.last_attack = performance.now();
  if (hit.showsDamage && result.stats) {
    const packets = packetManager.updateStats({ id: caster.id, target: target.id, stats: result.stats, isCrit: hit.isCrit, damage: hit.damage, absorb: result.absorb || 0 });
    const relayed = new Set(findPlayersWithTargetInAOI(target.id).map((viewer: any) => String(viewer.id)));
    const receivers = new Map<string, any>();
    if (caster.wt) receivers.set(String(caster.id), caster);
    for (const viewer of findPlayersWithTargetInAOI(caster.id)) if (viewer.wt) receivers.set(String(viewer.id), viewer);
    for (const [id, receiver] of receivers) if (!relayed.has(id)) sendPacketBestEffort(receiver.wt, packets);
  }
  if (result.outcome === "killed") listener.emit(Events.PLAYER_DEATH, { player: target, killer: caster });
  return true;
}

export function routeSplashToMirror(pending: Promise<boolean>[], caster: any, victim: any, spell: any, damage: number, how: { skipEffects?: boolean; showsDamage: boolean; harmful: boolean }): boolean {
  if (!victim.remote) return false;
  pending.push(hitRemotePlayer(caster, victim, remoteHit(caster, spell, damage, false, how)));
  return true;
}

export async function inspectOnOwner(asker: any, targetId: unknown): Promise<boolean> {
  const mirrored = targetId && !playerCache.get(targetId as string) ? mirrorPlayers.get(String(targetId)) : undefined;
  if (!mirrored) return false;
  await runOnPlayer(mirrored.username, "cells-inspect", { asker: asker.username, admin: !!asker.isAdmin });
  return true;
}

async function applyRemotePlayerHit(targetId: string, hit: PlayerHit, caster: any): Promise<EffectResult> {
  const target = playerCache.get(targetId);
  const allowed: PvpAllowed = (position) => player.isInPvPZone(target.location.map, position as PositionData, PVP_BODY);
  const harmAllowed = !target?.location || !hit.harmful ? true : await areaSpellHarms(hit.casterLocation?.position, target.location.position, allowed);
  const refused = refusalOf(target, hit, harmAllowed);
  if (refused) return { outcome: refused === "missing" ? "missing" : "refused", reason: refused };
  const damage = Number(hit.damage) || 0;
  let toHealth = damage;
  if (damage > 0) {
    const absorbed = spellEffects.consumeBarrier(target, damage);
    toHealth = damage - absorbed;
    if (absorbed > 0) spellEffects.broadcastEffectsUpdate(target);
  }
  target.stats.health = Math.round(target.stats.health - toHealth);
  if (target.stats.health > target.stats.total_max_health) target.stats.health = target.stats.total_max_health;
  if (damage < 0) listener.emit(Events.PLAYER_HEALED, { caster, target, amount: Math.abs(damage), source: hit.spell?.name } as any);
  listener.emit(Events.PLAYER_DAMAGED, { attacker: caster, target, damage, isCrit: hit.isCrit });
  if (hit.harmful) recordAttack(caster.id, target.id);
  if (target.stats.health <= 0) {
    await handlePlayerDeath(target, caster, { damage, isCrit: hit.isCrit });
    return { outcome: "killed", stats: { ...target.stats } };
  }
  let effectResult: any = {};
  if (hit.spell && !hit.skipEffects && Array.isArray(hit.spell.effects) && hit.spell.effects.length > 0) {
    effectResult = (await spellEffects.applySpellEffects(hit.spell, caster, target,
      (pp: any) => broadcastStatsUpdateToAOI(pp, caster, packetManager.updateStats({ id: pp.id, target: pp.id, stats: pp.stats })),
      (pp: any) => spellEffects.broadcastEffectsUpdate(pp)
    )) ?? {};
  }
  if (hit.showsDamage) {
    broadcastStatsUpdateToAOI(target, caster, packetManager.updateStats({ id: caster.id, target: target.id, stats: target.stats, isCrit: hit.isCrit, damage, absorb: effectResult.absorb || 0 }));
  }
  sendStatsToPartyMembers(target.username, target.id, target.stats);
  if (hit.harmful && !hit.casterParty.includes(target.username)) setPlayerPvp(target, true);
  target.last_attack = performance.now();
  if (damage > 0 && target.isVanished) {
    const vanishId = spellEffects.getVanishedEffectId(target);
    if (vanishId) {
      cancelEffect(target, vanishId);
      spellEffects.broadcastEffectsUpdate(target);
    }
  }
  return { outcome: "applied", stats: { ...target.stats }, absorb: effectResult.absorb || 0 };
}

// Registered once at load; the effect channel reaches it only when the links are attached.
setPlayerHitApplier(applyRemotePlayerHit);
// A player who leaves this node (every removal from playerCache: logout, disconnect, a replaced session) takes the memory of who hit them with them.
playerCache.onRemove((key) => forgetVictim(key));

function filterPlayersByDistance(wt: any, distance: number, _map: string) {
  const currentPlayer = playerCache.get(wt.data.id);
  if (!currentPlayer) return [];

  const currPos = parsePos(currentPlayer.location.position);
  const distanceSq = distance * distance;

  const layerId =
    currentPlayer.aoi?.layerId || layerManager.getPlayerLayer(currentPlayer.id);
  const mapName = String(currentPlayer.location.map).replaceAll(".json", "");
  const queryRadius = distance + TARGET_GRID_PAD_PX;
  const cellsPerSide = Math.floor((currPos.x + queryRadius) / TARGET_GRID_CELL_PX) -
    Math.floor((currPos.x - queryRadius) / TARGET_GRID_CELL_PX) + 1;
  const layerSize = layerId ? (layerManager.getLayerInfo(layerId)?.playerCount ?? 0) : Infinity;
  const useGrid = AOI_CONFIG.USE_SPATIAL_GRID && Number.isFinite(currPos.x) && Number.isFinite(currPos.y) &&
    cellsPerSide * cellsPerSide <= layerSize;

  let candidateIds: Iterable<string>;
  if (useGrid) {
    candidateIds = spatialGrid.getPlayersInRadius(currPos.x, currPos.y, queryRadius, mapName);
  } else {
    candidateIds = layerId ? layerManager.getPlayersInLayer(layerId) : mapIndex.getPlayersOnMap(mapName);
  }

  const result: any[] = [];
  for (const playerId of candidateIds) {
    // Grid candidates span every layer of the map; keep the caller's own.
    if (useGrid && layerId && layerManager.getPlayerLayer(playerId) !== layerId) continue;
    const p = playerCache.get(playerId);
    if (!p || !p.location) continue;
    const pPos = parsePos(p.location.position);
    const dx = pPos.x - currPos.x;
    const dy = pPos.y - currPos.y;
    if (dx * dx + dy * dy <= distanceSq) {
      result.push(p);
    }
  }
  return result;
}

function tryParsePacket(data: any) {
  try {
    return JSON.parse(data.toString());
  } catch (e) {
    log.error(e as string);
    return undefined;
  }
}

export function sendPacket(wt: any, packets: any[]): void {
  sendPacketQueued(wt, packets);
}

/** sendPacket that says whether every packet was queued; a connection that reports nothing counts as having queued it. */
export function sendPacketQueued(wt: any, packets: any[]): boolean {
  if (!wt || !wt.send || wt.readyState !== 1) {

    return false;
  }
  // What a command tells the admin is also the control panel's answer.
  if (panelReplies.size) controlPanel.collectReplies(panelReplies.get(wt), packets);
  let queued = true;
  try {
    packets.forEach((packet) => {
      if (wt.send(packet) === false) queued = false;
    });
  } catch (error) {
    log.error(`Failed to send packet: ${error}`);
    return false;
  }
  return queued;
}

/** A packet that reaches the admin by another way than sendPacket (a world broadcast): what it says is the control panel's answer too. */
export function panelHears(wt: any, packets: any[]) {
  if (panelReplies.size) controlPanel.collectReplies(panelReplies.get(wt), packets);
}

export function sendPacketBestEffort(wt: any, packets: any[]) {
  if (!wt || typeof wt.sendBestEffort !== "function" || wt.readyState !== 1) {
    return;
  }
  try {
    packets.forEach((packet) => {
      wt.sendBestEffort(packet);
    });
  } catch (error) {
    log.debug(`Best-effort packet send failed: ${error}`);
  }
}

export function sendToWholeMap(map: string, packets: any[]) {
  for (const playerId of mapIndex.getPlayersOnMap(String(map ?? "").replaceAll(".json", ""))) {
    const p = playerCache.get(playerId);
    if (p?.wt && p.wt.readyState === 1) {
      sendPacket(p.wt, packets);
    }
  }
}

loot.setOnDespawn((lootItem) => {
  sendToWholeMap(lootItem.map, packetManager.lootDespawn(lootItem.id));
});

function toSkeletonPacket(skeleton: any) {
  return {
    id: skeleton.id,
    username: skeleton.username,
    map: skeleton.map,
    x: skeleton.x,
    y: skeleton.y,
    createdAt: skeleton.createdAt,
    expiresAt: skeleton.expiresAt,
  };
}

export function destinationLayerFor(player: any, wantedLayerId: string | null | undefined, lowerLayerId: string | null): string | null {
  if (!player?.aoi) return null;
  const currentLayerId = player.aoi.layerId;
  if (wantedLayerId) {
    if (wantedLayerId === currentLayerId) return null;
    const pos = player.location.position;
    if (layerManager.getLayerInfo(wantedLayerId) &&
      layerManager.countInBlock(wantedLayerId, blockOf(pos.x, pos.y)) < MAX_PLAYERS_PER_LAYER) {
      return wantedLayerId;
    }
  }
  return lowerLayerId && lowerLayerId !== currentLayerId ? lowerLayerId : null;
}

function resyncSkeletonsFor(playerId: string): void {
  const viewer = playerCache.get(playerId);
  const pos = viewer?.location?.position;
  if (!viewer?.wt || !pos) return;
  const map = String(viewer.location.map || "").replaceAll(".json", "");
  const radius = viewer.aoi?.aoiRadius || AOI_CONFIG.DEFAULT_RADIUS;
  const visible = skeletons.getInRadius(map, pos.x, pos.y, radius, layerManager.getPlayerLayer(playerId));
  sendPacketBestEffort(viewer.wt, packetManager.loadSkeletons(visible.map((s) => toSkeletonPacket(s))));
}

setLayerChangeHandler((playerId) => {
  resyncSkeletonsFor(playerId);
  resyncZonesFor(playerCache.get(playerId));
});

skeletons.setOnSpawn((skeleton) => {
  broadcastToAOIBestEffortAtPosition(
    skeleton.x,
    skeleton.y,
    skeleton.map,
    packetManager.skeletonSpawn(toSkeletonPacket(skeleton)),
    skeleton.layerId
  );
});

skeletons.setOnDespawn((skeleton) => {
  broadcastToAOIBestEffortAtPosition(
    skeleton.x,
    skeleton.y,
    skeleton.map,
    packetManager.skeletonDespawn(skeleton.id),
    skeleton.layerId
  );
});

resurrection.setOnSicknessExpiry(async (p) => {
  const synced = await player.synchronizeStats(p.username);
  if (!synced) return;
  p.stats = synced;
  playerCache.set(p.id, p);
  globalStateRevision++;
  const statsPacket = packetManager.updateStats({ id: p.id, target: p.id, stats: p.stats });
  filterPlayersByMap(p.location.map).forEach((v) => {
    sendPacket(v.wt, statsPacket);
  });
  relayToMirrorViewers(p, statsPacket, false);
  spellEffects.broadcastEffectsUpdate(p);
  sendStatsToPartyMembers(p.username, p.id, p.stats);
});

export async function sendStatsToPartyMembers(playerUsername: string, playerId: string, stats: any) {
  const partyId = await parties.getPartyId(playerUsername);
  if (!partyId) return;

  const partyMembers = await parties.getPartyMembers(partyId);
  if (!partyMembers || partyMembers.length === 0) return;

  for (const memberName of partyMembers) {
    if (memberName.toLowerCase() === playerUsername.toLowerCase()) continue;

    await deliverToPlayer(
      memberName,
      packetManager.updateStats({
        target: playerId,
        username: playerUsername,
        stats: stats,
      }),
      { bestEffort: true }
    );
  }
}

/** What revivePlayer needs of this node: the REVIVE command and the cells-revive action share it (cells phase 7). */
export function reviveDeps(): ReviveDeps {
  return {
    clearSickness: (target) => resurrection.clearSickness(target),
    synchronizeStats: (username) => player.synchronizeStats(username),
    setDeadState: (username) => player.setDeadState(username, 0, null),
    keep: (target) => { playerCache.set(target.id, target); },
    bumpStateRevision: () => { bumpStateRevision(); },
    viewersOn: (map) => filterPlayersByMap(map),
    send: (viewer, packets) => sendPacket(viewer.wt, packets),
    ghostPacket: (target) => packetManager.playerGhost({ id: target.id, ghost: false }),
    revivePacket: (target) => packetManager.revive({ id: target.id, target: target.id, stats: target.stats }),
    relay: (target, packets) => relayToMirrorViewers(target, packets, false),
    broadcastEffects: (target) => spellEffects.broadcastEffectsUpdate(target),
    sendPartyStats: (target) => { void sendStatsToPartyMembers(target.username, target.id, target.stats); },
    revived: (target) => { listener.emit(Events.PLAYER_REVIVED, { player: target }); },
  };
}

const POSE_LAYER_FIELDS = [
  "mountSprite", "bodySprite", "headSprite", "armorHelmetSprite", "armorShoulderguardsSprite", "armorNeckSprite",
  "armorHandsSprite", "armorChestSprite", "armorFeetSprite", "armorLegsSprite", "armorWeaponSprite",
] as const;

/** The equipment slots getPlayerSpriteSheetData draws. */
const POSE_EQUIPMENT_SLOTS = ["helmet", "shoulderguards", "necklace", "gloves", "chestplate", "boots", "pants", "weapon"] as const;

interface PoseEntry {
  key: string;
  sheets: object | null;
  self: any[];
  observers: any[];
  observerFrames: { frame?: Uint8Array }[];
  /** lookSignature of the sheets in the packets, and the pose packet (socket/looks.ts) with its frame holder. */
  signature: string;
  pose: any[];
  poseFrames: { frame?: Uint8Array }[];
  /** The animation state the pose packet carries: what the pose datagram of a viewer carries (socket/posedgram.ts). */
  animationState: string;
  /** The data of the observers' sheet packet, to build it again with the pose revision (withRevision below). */
  observerData: Record<string, any>;
}
const POSE_CACHE_PER_PLAYER = 4;
const poseCache = new WeakMap<object, PoseEntry[]>();

/** Everything the packet depends on besides the sheet table, as one string. */
function poseKey(name: string, mountType: string, equipment: any): string {
  let key = name + "\u0001" + mountType;
  for (const slot of POSE_EQUIPMENT_SLOTS) key += "\u0001" + (equipment?.[slot] ?? "");
  return key;
}

export function poseData(id: string, spriteSheetData: any, mountSprite: any, forObservers: boolean): Record<string, any> {
  const layers: Record<string, any> = { mountSprite, ...spriteSheetData };
  const data: Record<string, any> = { id };
  for (const field of POSE_LAYER_FIELDS) {
    const layer = layers[field] || null;
    if (layer || !forObservers) data[field] = layer;
  }
  data.animationState = spriteSheetData.animationState;
  return data;
}

export async function sendSpriteSheetAnimation(wt: any, name: string, playerId?: string, _revision?: number) {
  const currentPlayer = playerCache.get(playerId || wt.data.id);
  if (!currentPlayer) return;

  const playerEquipment = drawnEquipment(currentPlayer);
  const mountType: string = currentPlayer.mounted && currentPlayer.mount_type ? String(currentPlayer.mount_type) : "";
  const key = poseKey(name, mountType, playerEquipment);
  notePoseCall(currentPlayer, name, key);
  const sheets = playerEquipment ? equipmentSheetsToken() : null;

  const kept = poseCache.get(currentPlayer);
  let entry = kept?.find((e) => e.key === key && (!playerEquipment || (sheets && e.sheets === sheets)));
  if (!entry) {
    const spriteSheetData = await getPlayerSpriteSheetData(name, playerEquipment);

    if (!spriteSheetData.bodySprite && !spriteSheetData.headSprite) {
      log.warn(`No sprite sheet layers available for animation "${name}", player ${currentPlayer.id}`);
      return;
    }

    const mountSprite = mountType ? getMountSpriteUrl(mountType) : null;
    const observerData = poseData(currentPlayer.id, spriteSheetData, mountSprite, true);
    entry = {
      key,
      sheets,
      self: packetManager.spriteSheetAnimation(poseData(currentPlayer.id, spriteSheetData, mountSprite, false)),
      observers: packetManager.spriteSheetAnimation(observerData),
      observerData,
      observerFrames: [{}],
      signature: lookSignature({ mountSprite, ...spriteSheetData }),
      pose: packetManager.spriteSheetPose({ id: currentPlayer.id, animationState: spriteSheetData.animationState }),
      poseFrames: [{}],
      animationState: spriteSheetData.animationState,
    };
    // A table that had already expired when it was asked for may be newer than the one used: not kept this time.
    if (!playerEquipment || sheets) {
      const list = (poseCache.get(currentPlayer) ?? []).filter((e) => e.key !== key);
      list.push(entry);
      if (list.length > POSE_CACHE_PER_PLAYER) list.shift();
      poseCache.set(currentPlayer, list);
    }
  }

  if (currentPlayer.wt) {
    sendPacket(currentPlayer.wt, entry.self);
    notePoseSelf();
  }
  const shown = entry;
  broadcastPoseToAOI(currentPlayer, {
    id: String(currentPlayer.id),
    key,
    signature: entry.signature,
    full: entry.observers,
    fullFrames: entry.observerFrames,
    pose: entry.pose,
    poseFrames: entry.poseFrames,
    animationState: entry.animationState,
    withRevision: (poseRev: number) => ({
      full: packetManager.spriteSheetAnimation({ ...shown.observerData, poseRev }),
      pose: packetManager.spriteSheetPose({ id: currentPlayer.id, animationState: shown.animationState, poseRev }),
    }),
  });
}

// (end marker of the cut above: src/tests/packet-srv.test.ts)
async function sendAnimation(wt: any, name: string, playerId?: string, revision?: number) {
  const currentPlayer = playerCache.get(playerId || wt.data.id);
  if (!currentPlayer) return;

  if (!useSpriteSheets) {
    log.warn(`Sprite sheet system disabled in config for player ${currentPlayer.id}`);
    return;
  }

  if (!(await isSpriteSheetSystemAvailable())) {
    log.warn(`Sprite sheet system not available for player ${currentPlayer.id}`);
    return;
  }

  await sendSpriteSheetAnimation(wt, name, playerId, revision);
}

export function getAnimationNameForDirection(
  direction: string,
  walking: boolean,
  mounted: boolean = false,
  mount_type?: string,
  casting: boolean = false
): string {
  const normalized = normalizeDirection(direction);

  if (casting) {
    const castAction = walking ? "cast_walk" : "cast_idle";
    return `player_${castAction}_${normalized}.png`;
  }

  const action = walking ? "walk" : "idle";
  if (mounted) {
    mount_type = mount_type || "unicorn";
    return `mount_${mount_type}_${action}_${normalized}.png`;
  }
  return `player_${action}_${normalized}.png`;
}

export async function sendPositionAnimation(
  wt: any,
  direction: string,
  walking: boolean,
  mounted: boolean = false,
  mount_type: string = "",
  playerId?: string,
  revision?: number,
  casting: boolean = false
) {
  const animation = getAnimationNameForDirection(direction, walking, mounted, mount_type, casting);
  await sendAnimation(wt, animation, playerId, revision);
}

function normalizeDirection(direction: string): string {

  const validDirections = ["down", "up", "left", "right", "downleft", "downright", "upleft", "upright"];
  if (validDirections.includes(direction)) {
    return direction;
  }
  return "down";
}

async function getAnimationData(name: string, playerId: string, revision?: number): Promise<any | null> {
  // A mirrored player (cluster mode) is animated from its record, for the viewers here.
  const targetPlayer = entityById(playerId);
  if (!targetPlayer) return null;

  if (!useSpriteSheets || !(await isSpriteSheetSystemAvailable())) {
    return null;
  }

  const playerEquipment = drawnEquipment(targetPlayer);
  const spriteSheetData = await getPlayerSpriteSheetData(name, playerEquipment);

  if (!spriteSheetData.bodySprite && !spriteSheetData.headSprite) {
    return null;
  }

  // Sprite URLs are now sent directly to the client
  return {
    id: targetPlayer.id,
    mountSprite: targetPlayer.mounted && targetPlayer.mount_type ? getMountSpriteUrl(targetPlayer.mount_type) : null,
    bodySprite: spriteSheetData.bodySprite || null,
    headSprite: spriteSheetData.headSprite || null,
    armorHelmetSprite: spriteSheetData.armorHelmetSprite || null,
    armorShoulderguardsSprite: spriteSheetData.armorShoulderguardsSprite || null,
    armorNeckSprite: spriteSheetData.armorNeckSprite || null,
    armorHandsSprite: spriteSheetData.armorHandsSprite || null,
    armorChestSprite: spriteSheetData.armorChestSprite || null,
    armorFeetSprite: spriteSheetData.armorFeetSprite || null,
    armorLegsSprite: spriteSheetData.armorLegsSprite || null,
    armorWeaponSprite: spriteSheetData.armorWeaponSprite || null,
    animationState: spriteSheetData.animationState,
    revision: revision,
  };
}

export async function sendAnimationTo(targetWs: any, name: string, playerId?: string, revision?: number) {
  // A mirrored player (cluster mode) is animated from its record, for the viewers here.
  const targetPlayer = entityById(playerId || targetWs.data.id);
  if (!targetPlayer) return;

  if (!useSpriteSheets || !(await isSpriteSheetSystemAvailable())) {
    log.warn(`Sprite sheet system not available for player ${targetPlayer.id}`);
    return;
  }

  const playerEquipment = drawnEquipment(targetPlayer);

  const spriteSheetData = await getPlayerSpriteSheetData(name, playerEquipment);

  if (!spriteSheetData.bodySprite && !spriteSheetData.headSprite) {
    log.debug(`No sprite sheet layers available for animation "${name}", player ${targetPlayer.id} - will send empty sprite data`);

  }

  // Sprite URLs are now sent directly to the client
  const spriteSheetPacketData = {
    id: targetPlayer.id,
    mountSprite: targetPlayer.mounted && targetPlayer.mount_type ? getMountSpriteUrl(targetPlayer.mount_type) : null,
    bodySprite: spriteSheetData.bodySprite || null,
    headSprite: spriteSheetData.headSprite || null,
    armorHelmetSprite: spriteSheetData.armorHelmetSprite || null,
    armorShoulderguardsSprite: spriteSheetData.armorShoulderguardsSprite || null,
    armorNeckSprite: spriteSheetData.armorNeckSprite || null,
    armorHandsSprite: spriteSheetData.armorHandsSprite || null,
    armorChestSprite: spriteSheetData.armorChestSprite || null,
    armorFeetSprite: spriteSheetData.armorFeetSprite || null,
    armorLegsSprite: spriteSheetData.armorLegsSprite || null,
    armorWeaponSprite: spriteSheetData.armorWeaponSprite || null,
    animationState: spriteSheetData.animationState,
    revision: revision,
  };

  if (sendPacketQueued(targetWs, packetManager.spriteSheetAnimation(spriteSheetPacketData))) {
    noteLook(targetWs, String(targetPlayer.id), lookSignature(spriteSheetPacketData));
  }
  const session = !targetPlayer.remote && castingFish(targetPlayer) ? fishing.session(targetPlayer.id) : undefined;
  const line = targetPlayer.remote ? targetPlayer.fishLine
    : session ? { x: session.x, y: session.y, bit: !!session.bitAt, reeled: !!(session.bitAt && session.reeledAt) } : null;
  if (line && targetWs !== targetPlayer.wt) {
    sendPacket(targetWs, packetManager.fishing({ id: targetPlayer.id, state: "cast", x: line.x, y: line.y }));
    if (line.bit) sendPacket(targetWs, packetManager.fishing({ id: targetPlayer.id, state: "bite" }));
    if (line.bit && line.reeled) sendPacket(targetWs, packetManager.fishing({ id: targetPlayer.id, state: "reel" }));
  }
}

function scheduleLightning() {
  const delay = 2000 + Math.random() * 3000;
  setTimeout(async () => {
    try {
      for (const world of await getLiveWorlds()) {
        const resolved = resolvedWeatherCache.get(world.name);
        const activeWeather = resolved ? resolved.weather : world.weather;
        if (lookOf(activeWeather) !== "thunderstorm") continue;
        const playersOnMap = mapIndex.getPlayersOnMap(world.name);
        if (playersOnMap.size === 0) continue;

        const playerIds = Array.from(playersOnMap);
        const randomId = playerIds[Math.floor(Math.random() * playerIds.length)];
        const player = playerCache.get(randomId);
        if (!player?.location?.position) continue;

        const strikeX = player.location.position.x + (Math.random() * 600 - 300);
        const strikeY = player.location.position.y + (Math.random() * 400 - 200);

        broadcastToAOIBestEffort(
          player,
          packetManager.lightning({ x: Math.round(strikeX), y: Math.round(strikeY), map: world.name }),
          true
        );
      }
    } catch (e) {
      // silently ignore
    }
    scheduleLightning();
  }, delay);
}

scheduleLightning();

/** How far past the turn of a stretch the cycle runs: a timer that fires a little early still settles on the new one. */
const WEATHER_CYCLE_SLACK_MS = 1000;

function scheduleWeatherCycle() {
  setTimeout(async () => {
    try {
      const all = await assetCache.get("weather") as WeatherData[];
      for (const world of worldsCache) {
        if (world.weather !== "random") continue;

        const settled = settledPick(all, world.name);
        if (!settled) continue;
        resolvedWeatherCache.set(world.name, { weather: settled.name, weatherData: settled });

        const shown = await weatherShown(settled.name, settled);
        for (const playerId of mapIndex.getPlayersOnMap(world.name)) {
          const player = playerCache.get(playerId);
          if (player?.wt && player.wt.readyState === 1) {
            sendPacket(player.wt, packetManager.changeWeather(shown));
          }
        }
      }
    } catch (e) {
      // silently ignore
    }
    scheduleWeatherCycle();
  }, nextCycleIn() + WEATHER_CYCLE_SLACK_MS);
}

// What the tornadoes (systems/tornadoes.ts) need from the socket layer, and their tick.
tornadoes.setTornadoBridge({
  weathers: async () => (await getLiveWorlds()).map((world) => {
    const name = resolvedWeatherCache.get(world.name)?.weather ?? world.weather ?? "clear";
    return { map: world.name, weather: name === TORNADO ? "tornado" : lookOf(name) === "thunderstorm" ? "storm" : "none" };
  }),
  players: (map) => Array.from(mapIndex.getPlayersOnMap(map)).map((id) => playerCache.get(id)).filter((p: any) => p?.wt),
  size: (map) => {
    const data = (maps as any[])?.find((m: any) => String(m?.name ?? "").replace(".json", "") === map)?.data;
    return data?.width && data?.tilewidth ? { width: data.width * data.tilewidth, height: data.height * data.tileheight } : null;
  },
  // (the body a walking player is tested with)
  walkable: (_map, x, y, who) =>
    player.checkCollisionSync(who.location.map, { x, y, direction: who.location?.position?.direction || "down" }, { width: 24, height: 40 }).value === false,
  move: async (who, x, y) => {
    who.location.position = { ...who.location.position, x, y };
    ghosts.touch("player", who.id);
    // a walking player's next step goes on from here, and tells them and those around them
    if (gameLoop.isPlayerMoving(who.id)) return;
    globalStateRevision++;
    if (shouldUpdateAOI(who)) await updatePlayerAOI(who, spawnBatchQueue, despawnBatchQueue);
    broadcastToAOI(who, packetManager.moveXY({
      i: who.id,
      d: { x, y, dr: who.location.position.direction },
      r: globalStateRevision,
      s: who.isStealth ? 1 : 0,
    }), true);
  },
  // As a creature's blow is taken (setCreatureEngineBridge's damagePlayer).
  hurt: async (target, amount) => {
    if (target.isDead || target.isGhost || !target.stats || isHeld(target)) return;
    const absorbed = spellEffects.consumeBarrier(target, amount);
    if (absorbed > 0) spellEffects.broadcastEffectsUpdate(target);
    target.stats.health = Math.max(0, Math.round(target.stats.health - (amount - absorbed)));
    const attacker = { id: "tornado", username: "Tornado", isCreature: true };
    listener.emit(Events.PLAYER_DAMAGED, { attacker, target, damage: amount, isCrit: false });
    playerCache.set(target.id, target);
    if (target.stats.health <= 0) {
      await handlePlayerDeath(target, null, { damage: amount, isCrit: false });
      return;
    }
    broadcastStatsUpdateToAOI(
      target,
      target,
      packetManager.updateStats({ id: target.id, target: target.id, stats: target.stats, isCrit: false, damage: amount, absorb: absorbed })
    );
    sendStatsToPartyMembers(target.username, target.id, target.stats);
  },
  // Tornadoes are the whole map's, on every layer, but each player hears only of those near them (tornadoes.showNearby).
  show: (map, list) => {
    const onMap = (p: any) => p?.wt && p.wt.readyState === 1 && String(p.location?.map ?? "").replaceAll(".json", "") === map;
    tornadoes.showNearby(map, list, {
      near: (x, y) => getPlayersNearPoint(x, y, map, AOI_CONFIG.DEFAULT_RADIUS + tornadoes.SHOW_MARGIN, undefined),
      get: (id) => { const p = playerCache.get(id); return onMap(p) ? p : undefined; },
      reach: (viewer) => viewer.aoi?.aoiRadius || AOI_CONFIG.DEFAULT_RADIUS,
      send: (viewer, near) => {
        if (!onMap(viewer)) return;
        const packet = packetManager.tornadoes({ map, tornadoes: near });
        if (near.length) sendPacketBestEffort(viewer.wt, packet);
        else sendPacket(viewer.wt, packet);
      },
    });
  },
});
listener.on(Events.FIXED_UPDATE, () => {
  void tornadoes.tick(Date.now());
});
gameLoop.addTickHook(() => tornadoes.pull(Date.now()));

scheduleWeatherCycle();

