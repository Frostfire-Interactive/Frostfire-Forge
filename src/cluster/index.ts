import log from "../modules/logger";
import assetCache, { changedElsewhere, onWrite } from "../services/assetCache";
import gameLoop from "../services/gameloop";
import { usesSharedCache } from "../services/datacache";
import { setClusterPlayerLock } from "../services/batch";
import layerManager from "../services/layermanager";
import playerCache from "../services/playermanager";
import { accountCharacterNames, characterIdOf } from "../systems/characterids";
import { BlockMover, BlockMoveOrders } from "./blockmove";
import { BlockTable, blockAt, blockKey } from "./blocks";
import { ClusterBus } from "./bus";
import { CENSUS_MS, Census, type PanelSource, type PeerRoster } from "./census";
import { requireClusterKeys } from "./clusterkeys";
import { clusterEnabled, nodeId, regionId } from "./config";
import { LOCK_KEY, deadKey } from "./coordinator";
import { delivery } from "./deliver";
import { PlayerDirectory, type DirectoryEntry } from "./directory";
import { useWorldIds } from "./entityids";
import { forwardTable, redirectCall } from "./forwarding";
import { ghosts } from "./ghosts";
import { grants } from "./grants";
import { storeHealth } from "./health";
import { holdPlayerLock, playerHandoff } from "./handoff";
import { IdAllocator } from "./ids";
import { invitations } from "./invitations";
import { LayerNumbers } from "./layerseq";
import { NodeLinks } from "./links";
import { linkCalls } from "./linkcalls";
import { runLinkHooks } from "./linkhooks";
import type { LinkTransport } from "./linktransport";
import { MapCatalogue, extentOf, takeInMap, type MapExtent } from "./maps";
import { NodeDeath } from "./nodedeath";
import type { ClusterDebugSource } from "./nodedebug";
import { LoopLagMeter, NodeRegistry, type LoadReport, type NodeInfo } from "./nodes";
import { peerNews } from "./peernews";
import { PlayerLocks, characterLockKeys } from "./playerlock";
import { trackPresence } from "./presence";
import { RedisStore } from "./redisstore";
import { SNAPSHOT_EVERY_MS, SnapshotWriter, addSnapshotMap, useSnapshotMaps } from "./snapshots";
import type { ClusterStore } from "./store";
import { sealStore } from "./storeseal";
import { BorderBand, TargetCache, linkPartners } from "./strip";
import { tradeSettle } from "./tradesettle";

// Joins this node to the world when CLUSTER=true; does nothing otherwise.

/** Where players reach this node: what the gateway registration advertises. */
export type NodeAddress = Pick<NodeInfo, "publicHost" | "port" | "wtPort" | "useSSL" | "linkHost" | "linkPort" | "certHash">;

/** How often a node checks its directory set against the entries (ms). */
const DIRECTORY_REPAIR_MS = 30_000;

/** How often the node beats and re-reads its block table, and how long it waits for blocks no one owns. Tests shorten them. */
export interface ClusterTiming {
  beatMs?: number;
  refreshMs?: number;
  unownedGraceMs?: number;
  /** How often owned players' snapshots are written. Default SNAPSHOT_EVERY_MS. */
  snapshotMs?: number;
  /** How often the node looks for its own tombstone. Default DEAD_CHECK_MS. */
  deadCheckMs?: number;
  /** How long a fenced node waits for its players' saves before it exits. Default FENCE_EXIT_MS. */
  fenceExitMs?: number;
  /** How often the store's connection is read. Default STORE_POLL_MS. */
  healthPollMs?: number;
  /** How often the block mover reads its open orders: the seed until it succeeds, then the review. Default MOVER_REVIEW_MS. */
  moverReviewMs?: number;
  /** How often the other nodes' load reports are read. Default CENSUS_MS. */
  censusMs?: number;
}

export interface ClusterLinkOptions {
  /** null: no node links (tests that do not need them, or NODE_LINK_PORT=0). */
  transport: LinkTransport | null;
  /** Shorter pings for tests. */
  pingMs?: number;
  deadMs?: number;
}

/** A creature as the load report counts it. */
export interface CreaturePosition {
  map: string;
  x: number;
  y: number;
  state: string;
}

// Beat (and report load) every second: three missed beats and the node is dead (nodes.ts).
const BEAT_MS = 1000;
// Every 10 s the block table is read again, in case a "blocks-changed" message was missed.
const REFRESH_MS = 10_000;
const UNOWNED_GRACE_MS = 10_000;
const MOVER_REVIEW_MS = 5_000;
const CREATURE_LOAD = 0.1;
export const VISIBLE_PAIR_LOAD = 0.15;

interface RunningNode {
  self: string;
  store: ClusterStore;
  registry: NodeRegistry;
  blocks: BlockTable;
  /** Names of the maps this node has loaded, without ".json". */
  maps: string[];
  /** The grace still to run, in time without a coordinator seen, as of `checkedAt`. */
  graceLeft: number;
  /** Whether the last look (on the beat) found a coordinator holding the lock, and when that look was. */
  coordinatorSeen: boolean;
  checkedAt: number;
  /** Whether blocks no one owns are this node's to spawn in: the grace has run out with no coordinator seen. */
  unownedOpen: boolean;
  stopped: boolean;
  timers: Array<ReturnType<typeof setTimeout>>;
  /** The links to the neighbouring nodes; null when the node runs without them. */
  links: NodeLinks | null;
  /** The bus this node listens on, its directory, and when it started (the start time other nodes know it by). */
  bus: ClusterBus;
  directory: PlayerDirectory;
  startedAt: number;
  /** Who is on the region's other nodes. */
  census: Census;
  /** What stopCluster takes off again. */
  teardown: Teardown;
  beating: Promise<void> | null;
  /** The event-loop delay, reported with the load so the coordinator moves no block to or from a lagging node. */
  lag: LoopLagMeter;
  failing: boolean;
  refreshing: Promise<void> | null;
  refreshFailing: boolean;
  /** Gives the links the live nodes of the region (a no-op without links), and whether the last read of them failed. */
  followLive: (live: string[]) => void;
  peersFailing: boolean;
  /** The block mover (it answers BLOCK_MOVE over the links); null on a node without links. */
  mover: BlockMover | null;
  /** Whether the mover's seed has run: until it has, no creature or gathering node spawns here. True without a mover. */
  seeded: boolean;
  /** Whether the spawn gate (lease, run, seed) was open at the last look: a gate that opens tells the spawners. */
  gateOpen: boolean;
  /** Whether the last seed failed: logged when it starts failing, not on every try. */
  seedFailing: boolean;
  /** Whether the node was fenced: nothing spawns here again, whatever the lease says. */
  fenced: boolean;
  /** Fences the node: its players are sent away and the process exits. Runs once. */
  fence(why: string): void;
}

let running: RunningNode | null = null;
let creatures: (() => Iterable<CreaturePosition>) | null = null;
let creaturesTotal: (() => number) | null = null;
const blockListeners = new Set<(maps: string[]) => void>();

gameLoop.addAfterTickHook(() => ghosts.flushTick());

const bare = (map: string) => map.replace(/\.json$/, "");

/** How long the directory keeps a handed-off player under this node while the new node has not claimed them. */
export const HANDOFF_PRESENCE_HOLD_MS = 10_000;

export interface EngineHooks {
  /** A login claimed here: takes the owner epoch (adoptOwnerEpoch). Answers the epoch the entry holds now, or null. */
  claimed(player: any, entry: DirectoryEntry, directory: PlayerDirectory): Promise<number | null>;
  /** Ends a player's session on this node. */
  kick(player: any, why: string): void;
  /** A player handed to another node never arrived there: nobody holds them now. */
  lost?(player: any): void;
}

let engine: EngineHooks | null = null;

/** Answers the hooks set before. */
export function useEngineHooks(hooks: EngineHooks | null): EngineHooks | null {
  const previous = engine;
  engine = hooks;
  return previous;
}

/** What a peer's death frees here. The creature module sets these at load (this module does not load it). */
export interface PeerDeathHandlers {
  /** Away slots the dead peer held, respawned here. How many. */
  releaseAwayHeldBy(peer: string): number;
  /** Creatures here whose home was the dead peer, despawned. How many. */
  dropForeignFrom(home: string): number;
}

let peerDeath: PeerDeathHandlers | null = null;

/** Answers the handlers set before. */
export function usePeerDeathHandlers(handlers: PeerDeathHandlers | null): PeerDeathHandlers | null {
  const previous = peerDeath;
  peerDeath = handlers;
  return previous;
}

/** A run of a node is over: its players are gone. `restarted`: the node is back, and what it holds now is its new run's. */
type PlayersLost = (peer: string, restarted: boolean) => void;

let playersLost: PlayersLost | null = null;

/** Who hears that a node's players are gone: the socket layer (this module does not import it). */
export function onPlayersLost(listener: PlayersLost | null): void {
  playersLost = listener;
}

let panelSource: PanelSource | null = null;

/** What this node tells other nodes' control panels: the control panel sets it (this module does not load that). */
export function servePanelFrom(source: PanelSource | null): void {
  panelSource = source;
}

/** What an admin ordered of the whole server, sent from the node that was asked to the region's others. */
export type ServerOrder =
  | { what: "restart"; endsAt: number }
  | { what: "restart-off" }
  | { what: "shutdown" }
  | { what: "whitelist"; enabled?: boolean; add?: string; remove?: string };

let serverOrders: ((order: ServerOrder) => void) | null = null;

/** Who carries out another node's orders: the socket layer (this module does not import it). */
export function followServerOrders(handler: ((order: ServerOrder) => void) | null): void {
  serverOrders = handler;
}

/** How long past its end a restart is kept. A node that starts then has nothing to join, so it reads the time and drops it. */
const RESTART_KEPT_MS = 60_000;

const whitelistKey = (): string => `cells:whitelist:${regionId()}`;
const restartKey = (): string => `cells:restart:${regionId()}`;

export async function sendServerOrder(order: ServerOrder): Promise<void> {
  const bus = clusterBus();
  const store = clusterStore();
  if (!bus || !store) return;
  try {
    if (order.what === "restart") await store.set(restartKey(), String(order.endsAt), order.endsAt - Date.now() + RESTART_KEPT_MS);
    if (order.what === "restart-off") await store.del(restartKey());
    if (order.what === "whitelist" && typeof order.enabled === "boolean") await store.set(whitelistKey(), order.enabled ? "on" : "off");
    await bus.toWorld("server-order", { ...order, region: regionId() });
  } catch (error) {
    log.warn(`The other nodes could not be told of a ${order.what} order, so it holds on this node only: ${error}`);
  }
}

/** What a node starting now has to join: a whitelist switched, a restart counting down. Nothing outside cluster mode. */
export async function serverOrdersKept(): Promise<{ whitelist: boolean | null; restartEndsAt: number | null }> {
  const store = clusterStore();
  if (!store) return { whitelist: null, restartEndsAt: null };
  const [whitelist, endsAt] = await Promise.all([store.get(whitelistKey()), store.get(restartKey())]);
  return {
    whitelist: whitelist === null ? null : whitelist === "on",
    restartEndsAt: endsAt === null ? null : Number(endsAt),
  };
}

/** A region that starts from nothing goes by its WHITELIST setting again, as a lone server does. */
export async function forgetServerOrders(): Promise<void> {
  await clusterStore()?.del(whitelistKey());
}

/** A fenced node waits this long for its players' disconnect saves, then exits. */
export const FENCE_EXIT_MS = 3_000;

let exitProcess: (code: number) => void = (code) => process.exit(code);

/** Answers the exit set before. Tests record the exit instead of ending the test run. */
export function setFenceExit(exit: (code: number) => void): (code: number) => void {
  const previous = exitProcess;
  exitProcess = exit;
  return previous;
}

function fenceNode(self: string, why: string, exitMs: number): void {
  log.error(`Cluster node ${self} stops (${why}): its players are sent away, and the process exits in ${exitMs} ms`);
  for (const p of Object.values(playerCache.list()) as any[]) {
    try {
      if (engine) engine.kick(p, "fenced");
      else p?.wt?.close?.();
    } catch (error) {
      log.error(`Could not end the session of ${p?.username} on fenced node ${self}: ${error}`);
    }
  }
  // Not unref'd: the exit must come even when nothing else keeps the process up.
  setTimeout(() => {
    grants.detach();
    exitProcess(1);
  }, exitMs);
}

export function requireSharedCache(env: Record<string, string | undefined> = process.env): void {
  if (!usesSharedCache(env)) throw new Error("Cluster mode needs CACHE=redis: the nodes must share one copy of the player rows");
}

export async function startCluster(
  store: ClusterStore | undefined,
  address: NodeAddress,
  timing: ClusterTiming = {},
  links?: ClusterLinkOptions
): Promise<{ ids: IdAllocator; directory: PlayerDirectory } | null> {
  if (!clusterEnabled()) return null;
  const startedAt = Date.now();
  const ownsStore = !store;
  store ??= new RedisStore();
  const self = nodeId();
  // Whatever is attached below is pushed here as it is, and undone newest first if the start fails (stopCluster runs the same lists).
  const teardown: Teardown = { quiet: [], links: [], rest: [] };
  if (ownsStore) teardown.rest.push({ what: "close its store", run: () => store!.close() });
  try {
    requireSharedCache();
    const keys = requireClusterKeys();
    store = sealStore(store, keys.store);
    // Phase 7: the store's health is read from the start. Handoffs, delivery, presence and snapshots ask it (Task 19).
    storeHealth.attach(store, timing.healthPollMs);
    teardown.rest.push({ what: "stop watching its store", run: () => storeHealth.detach() });
    const registry = new NodeRegistry(store);
    const blocks = new BlockTable(store);
    const mayAct = () => registry.leaseValid() && !registry.taken();
    // Fenced once, by whichever finds it first: the tombstone watch, a node-dead naming this run, or the beat.
    let fenced = false;
    let fencedNode: RunningNode | null = null;
    const fence = (why: string) => {
      if (fenced) return;
      fenced = true;
      // The node is made below: a fence before then (the first beat) reaches it through this flag.
      if (fencedNode) fencedNode.fenced = true;
      fenceNode(self, why, timing.fenceExitMs ?? FENCE_EXIT_MS);
    };
    grants.attach(store, self, { run: startedAt, mayAct: () => mayAct() && !fenced });
    teardown.rest.push({ what: "detach its grants", run: () => grants.detach() });
    let mover: BlockMover | null = null;
    let nodeLinks: NodeLinks | null = null;
    let followBlocks = () => {};
    // The live nodes of the region as last read (watchPeers): the owner of no block borders no one, so it is found here.
    let liveNodes: string[] = [];
    let followLive = (_live: string[]) => {};
    if (links?.transport) {
      const linked = new NodeLinks({ self, secret: keys.link, transport: links.transport, nodeInfo: (id) => registry.info(id), pingMs: links.pingMs, deadMs: links.deadMs });
      nodeLinks = linked;
      const { attachAoiEvents, detachAoiEvents } = await import("./aoievent");
      const { loadGhostKinds } = await import("./kinds");
      await loadGhostKinds();
      // Newest first they run: ghosts, link calls, AOI events, the follower, then the links.
      let stopFollowing = () => {};
      teardown.links.push({ what: "stop its links", run: () => stopWithin(LINKS_STOP_MS, "its links", () => linked.stop()) });
      teardown.links.push({ what: "stop following the block table", run: () => stopFollowing() });
      teardown.links.push({ what: "detach its AOI events", run: () => detachAoiEvents() });
      teardown.links.push({ what: "detach its link calls", run: () => linkCalls.detach() });
      teardown.links.push({ what: "detach its ghosts", run: () => ghosts.detach() });
      // Targets per map and 64 px square; the cache drops a map's squares when its block table is replaced.
      const targetCache = new TargetCache((map) => blocks.ownersOf(map), self);
      ghosts.attach(
        linked,
        (map, x, y, previous) => targetCache.targets(map, x, y, previous),
        new BorderBand((map) => blocks.ownersOf(map), self, () => blocks.maps()),
      );
      attachAoiEvents(linked, (map) => blocks.ownersOf(map));
      linkCalls.attach(linked);
      linkCalls.setRedirect(redirectCall(forwardTable));
      const previousForwarder = delivery.setForwarder((username) => forwardTable.to(`user:${username.toLowerCase()}`));
      teardown.links.push({
        what: "stop forwarding",
        run: () => {
          linkCalls.setRedirect(null);
          delivery.setForwarder(previousForwarder);
          forwardTable.clear();
        },
      });
      const undoHooks = runLinkHooks({
        calls: linkCalls,
        links: linked,
        self,
        ownerAt: (map, x, y) => blocks.ownerOf(map, x, y)?.nodeId ?? null,
        store,
      });
      teardown.links.push({ what: "undo its link hooks", run: () => undoHooks() });
      const { registerObjectMoves } = await import("./kinds/objectmoves");
      const undoObjectMoves = registerObjectMoves({ ghosts, now: Date.now, blockOf: (map, x, y) => blocks.blockOf(map, x, y) });
      teardown.links.push({ what: "unregister its object moves", run: () => undoObjectMoves() });
      const moveStore = store;
      const blockMover = new BlockMover({
        self,
        orders: new BlockMoveOrders(moveStore),
        calls: linkCalls,
        ownerOf: (map, bx, by) => blocks.ownersOf(map)[blockKey(bx, by)] ?? null,
        // A node fenced, past its lease or taken over takes no block in: the coordinator may already have forgotten it.
        canOwn: () => !fenced && mayAct(),
        // The probe waits longer when this node's own loop is behind (the same lag its load report carries).
        lagMs: () => fencedNode?.lag.max() ?? 0,
        // A new owner that cannot say whether it took a block in: only its run's tombstone lets the parts back here.
        runOf: async (id) => {
          const startedAt = (await registry.info(id))?.startedAt;
          return typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : null;
        },
        buriedRun: async (id) => {
          const raw = await moveStore.get(deadKey(id));
          const startedAt = raw ? (JSON.parse(raw) as { startedAt?: unknown } | null)?.startedAt : null;
          return typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : null;
        },
      });
      mover = blockMover;
      const stopMover = blockMover.start();
      teardown.links.push({ what: "stop answering block moves", run: () => stopMover() });
      await linked.start();
      followBlocks = () => {
        const follow = () => linked.want(linkPartners(blocks.maps().map((map) => blocks.ownersOf(map)), self, liveNodes));
        follow();
        stopFollowing = blocks.onChange(follow);
        followLive = (live) => { liveNodes = live; follow(); };
      };
    }

    const bus = new ClusterBus(store, self, keys.bus);
    // Handlers before the bus starts listening: no message can arrive before what handles it.
    const directory = new PlayerDirectory(store, self);
    const census = new Census(registry, bus, self, regionId(), () => panelSource);
    delivery.attach(bus, directory);
    teardown.rest.push({ what: "detach delivery", run: () => delivery.detach() });
    // The world channel reaches every region.
    bus.on("server-order", (data, from) => {
      if (from !== self && data?.region === regionId()) serverOrders?.(data);
    });
    // What happens here that the region's other nodes show their own players too (cluster/peernews.ts).
    peerNews.attach(bus, self, regionId());
    teardown.rest.push({ what: "detach the peer news", run: () => peerNews.detach() });
    const ASSET_CHANGED = "asset-changed";
    const stopTellingWrites = onWrite((key) => void peerNews.tell(ASSET_CHANGED, key === null ? { all: true } : { key }));
    peerNews.on(ASSET_CHANGED, (news: { key?: unknown; all?: unknown }) => {
      if (news?.all === true) changedElsewhere(null);
      else if (typeof news?.key === "string" && news.key) changedElsewhere(news.key);
    });
    teardown.rest.push({ what: "stop telling the cache's writes", run: () => { stopTellingWrites(); peerNews.on(ASSET_CHANGED, null); } });
    // Phase 7: trade settle marks are shared (Task 20b).
    tradeSettle.attach(store);
    teardown.rest.push({ what: "detach the settle marks", run: () => tradeSettle.detach() });
    const locks = new PlayerLocks(store, self);
    const localLockKey = (key: string) => {
      if (key.startsWith("name:")) return playerCache.getByUsername(key.slice(5)) != null;
      const id = Number(key.slice(5));
      return Object.values(playerCache.list() as Record<string, any>).some((p) => Number(p?.characterId) === id);
    };
    const previousLock = setClusterPlayerLock(async (names, work) =>
      locks.withLocks(await characterLockKeys(names, characterIdOf), work, { isLocal: localLockKey }));
    teardown.rest.push({ what: "release the cluster player lock", run: () => { setClusterPlayerLock(previousLock); } });
    const previousHandoffLock = playerHandoff.setLock((characterId) => holdPlayerLock(locks, characterId));
    teardown.rest.push({ what: "release the handoff lock", run: () => { playerHandoff.setLock(previousHandoffLock); } });
    invitations.attach(store);
    teardown.rest.push({ what: "detach invitations", run: () => invitations.attach(null) });
    // Phase 7: a peer that died, or this node found dead (Task 13). Handlers before the bus starts.
    const death = new NodeDeath(store, {
      self,
      startedAt,
      dropMirrors: (peer) => ghosts.dropPeer(peer),
      releaseAwayHeldBy: (peer) => peerDeath?.releaseAwayHeldBy(peer) ?? 0,
      dropForeignFrom: (home) => peerDeath?.dropForeignFrom(home) ?? 0,
      playersLost: (peer, restarted) => playersLost?.(peer, restarted),
      fence,
      adopt: (nodeId, runStartedAt) => {
        if (fenced) return;
        void grants.adoptFrom(nodeId, runStartedAt)
          .catch((error) => log.error(`The hand-overs of run ${runStartedAt} of node ${nodeId} could not be adopted: ${error}`));
      },
    });
    death.attach(bus);
    const moverHere = mover;
    if (moverHere) bus.on("block-move", (data) => moverHere.onBusMessage(data));
    blocks.attach(bus);
    teardown.rest.push({ what: "stop the bus", run: () => bus.stop() });
    await bus.start();
    // Before the store closes: a sweep that ran beside the close could be left with a closed connection and the entries behind.
    teardown.rest.push({ what: "clear its directory entries", run: () => directory.sweepNode(self) });
    const ids = new IdAllocator(store);
    await ids.init();
    // Creatures, loot and the rest take their ids from the same counter as the players.
    useWorldIds(ids);
    teardown.rest.push({ what: "release the world ids", run: () => useWorldIds(null) });
    // What this node held when it last stopped (or died) is not true any more: no one is on it yet.
    const stale = await directory.sweepNode(self);
    if (stale > 0) log.warn(`Cleared ${stale} directory entries left by this node's last run`);
    const stopPresence = trackPresence(directory, (previous, username, value) => {
      const accountId = Number(value?.accountId);
      delivery.runOnPlayerAt(previous.nodeId, previous.playerId, "displaced-login", Number.isSafeInteger(accountId) && accountId > 0 ? { username, accountId } : { username })
        .catch((error) => log.error(`Could not close ${username}'s old session on ${previous.nodeId}: ${error}`));
    }, {
      // A handoff arrival is not a second login: the old node released the player itself.
      quiet: (username) => playerHandoff.arrivedRecently(username),
      siblings: (value) => accountCharacterNames(Number(value?.accountId)),
      holdReleaseMs: (value) => (value?.handedOff === true ? HANDOFF_PRESENCE_HOLD_MS : 0),
      onLost: (value) => engine?.lost?.(value),
      // Phase 7: a login takes the owner epoch its saves are fenced on (Task 1). The receiver hands the hook in.
      onClaimed: (value, entry) => (engine ? engine.claimed(value, entry, directory) : Promise.resolve(null)),
    });
    teardown.rest.push({ what: "stop tracking presence", run: () => stopPresence() });
    const stopSnapshots = new SnapshotWriter(store, () => (mayAct() && !fenced ? Object.values(playerCache.list()) : []), {
      everyMs: timing.snapshotMs ?? SNAPSHOT_EVERY_MS,
    }).start();
    teardown.rest.push({ what: "stop its snapshots", run: () => stopSnapshots() });

    // Pushed before the announcement is made: a failure part way through it leaves nothing announced.
    teardown.rest.push({ what: "retire", run: () => registry.retire(self) });
    // No link, no port to dial: a neighbour reading the announcement must not try.
    await registry.announce({ nodeId: self, regionId: regionId(), ...address, linkPort: nodeLinks ? address.linkPort ?? 0 : 0, startedAt });
    // The coordinator lays out each map's blocks from the sizes the nodes publish.
    const extents = await loadedMaps();
    // A login's snapshot is read only on one of these maps, inside its size (security review H1).
    const previousSnapshotMaps = useSnapshotMaps(extents);
    teardown.rest.push({ what: "forget the snapshot maps", run: () => { useSnapshotMaps(previousSnapshotMaps); } });
    await new MapCatalogue(store).publish(extents);
    blocks.useExtents(extents);
    const maps = extents.map((extent) => extent.name);
    await blocks.preload(maps);
    const numbers = new LayerNumbers(store);
    await numbers.prefill(maps);
    layerManager.useLayerNumbers(numbers);
    teardown.rest.push({ what: "release the layer numbers", run: () => layerManager.useLayerNumbers(null) });
    followBlocks();

    const node: RunningNode = {
      self, store, registry, blocks, maps, links: nodeLinks, bus, directory, startedAt, census, teardown,
      graceLeft: timing.unownedGraceMs ?? UNOWNED_GRACE_MS,
      coordinatorSeen: false, checkedAt: startedAt, unownedOpen: false, stopped: false,
      timers: [],
      beating: null, lag: new LoopLagMeter(), failing: false, refreshing: null, refreshFailing: false, followLive, peersFailing: false,
      mover, seeded: mover === null, gateOpen: false, seedFailing: false, fenced, fence,
    };
    fencedNode = node;
    // clearTimeout clears an interval too.
    teardown.quiet.push({ what: "stop its timers", run: () => { node.stopped = true; for (const timer of node.timers) clearTimeout(timer); } });
    // Every change of a cached table goes through BlockTable.onChange (a message, a re-read, a write): told at once.
    const stopListening = blocks.onChange((map) => tellBlockChanges([map]));
    teardown.quiet.push({ what: "stop telling block changes", run: () => stopListening() });
    // A beat in flight would make the node live again after it retired.
    teardown.rest.push({ what: "wait for its beat", run: () => Promise.all([node.beating, node.refreshing]) });
    await beat(node);
    await watchPeers(node);
    await seedMover(node);
    node.timers.push(node.lag.start());
    node.timers.push(setInterval(() => { node.beating ??= beat(node).finally(() => { node.beating = null; }); }, timing.beatMs ?? BEAT_MS));
    node.timers.push(setInterval(() => { node.refreshing ??= refresh(node).finally(() => { node.refreshing = null; }); }, timing.refreshMs ?? REFRESH_MS));
    await census.read();
    let counting = false;
    node.timers.push(setInterval(() => {
      if (counting || node.stopped) return;
      counting = true;
      void census.read().finally(() => { counting = false; });
    }, timing.censusMs ?? CENSUS_MS));
    // The per-node player set is an index: a member whose entry names another node is dropped here, within DIRECTORY_REPAIR_MS.
    let repairing = false;
    node.timers.push(setInterval(() => {
      if (repairing || node.stopped) return;
      repairing = true;
      directory.repairIndex().catch((error) => log.debug(`Directory set repair failed: ${error}`)).finally(() => { repairing = false; });
    }, DIRECTORY_REPAIR_MS));
    if (mover) {
      let reviewing = false;
      node.timers.push(setInterval(() => {
        if (reviewing || node.stopped) return;
        reviewing = true;
        void reviewMover(node).finally(() => { reviewing = false; });
      }, timing.moverReviewMs ?? MOVER_REVIEW_MS));
    }
    for (const timer of node.timers) (timer as any).unref?.();
    // Phase 7: a node the coordinator took over while it was stalled finds its tombstone, and stops (Task 13).
    const stopDeathWatch = death.start(timing.deadCheckMs);
    teardown.quiet.push({ what: "stop looking for its tombstone", run: () => stopDeathWatch() });
    node.gateOpen = spawnGateOpen(node);
    running = node;
    log.success(`Cluster node ${self} joined the world`);
    return { ids, directory };
  } catch (error) {
    // A start that failed leaves no listener, timer, handler or announcement behind.
    await tearDown(self, teardown);
    throw error;
  }
}

/** Graceful shutdown: the node stops beating and leaves the live nodes at once, without waiting for its beat to expire. */
export async function stopCluster(): Promise<void> {
  const node = running;
  if (!node) return;
  running = null;
  await tearDown(node.self, node.teardown);
}

/** One thing startCluster attached, and how to take it off. */
interface Undo {
  what: string;
  run: () => unknown;
}

interface Teardown {
  quiet: Undo[];
  links: Undo[];
  rest: Undo[];
}

// Links get this long to close: a listener slow to stop must not hold up leaving the cluster behind it.
const LINKS_STOP_MS = 1000;

/** Waits for `stop`, but logs and goes on after `ms`. */
async function stopWithin(ms: number, what: string, stop: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done: boolean;
  try {
    done = await Promise.race([stop().then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); })]);
  } finally {
    clearTimeout(timer);
  }
  if (!done)log.warn(`Cluster node did not finish stopping ${what} within ${ms / 1000} s`);
}

/** Each step is tried whatever the one before did (Redis may be away): a later startCluster begins clean, not half-attached. */
async function tearDown(self: string, teardown: Teardown): Promise<void> {
  for (const list of [teardown.quiet, teardown.links, teardown.rest]) {
    for (const { what, run } of [...list].reverse()) {
      try {
        await run();
      } catch (error) {
        log.error(`Cluster node ${self} could not ${what}: ${error}`);
      }
    }
    list.length = 0;
  }
}

export async function clusterMapAdded(name: string, widthPx: number, heightPx: number): Promise<void> {
  const node = running;
  if (!node) return;
  const extent = extentOf(name, widthPx, heightPx);
  addSnapshotMap(extent);
  await takeInMap(node, extent);
}

/** The node's links to its neighbours, or null (cluster off, or running without links). */
export function clusterLinks(): NodeLinks | null {
  return running?.links ?? null;
}

/** The block table this node keeps, or null outside cluster mode. */
export function clusterBlocks(): BlockTable | null {
  return running?.blocks ?? null;
}

/** The registry of the cluster's nodes, or null outside cluster mode. */
export function clusterNodes(): NodeRegistry | null {
  return running?.registry ?? null;
}

/** The store of the running cluster, or null (cluster off or stopped). */
export function clusterStore(): ClusterStore | null {
  return running?.store ?? null;
}

/** This node's id while the cluster runs, or null. */
export function clusterSelf(): string | null {
  return running?.self ?? null;
}

/** The bus this node listens on, or null outside cluster mode. */
export function clusterBus(): ClusterBus | null {
  return running?.bus ?? null;
}

/** The player directory, or null outside cluster mode. */
export function clusterDirectory(): PlayerDirectory | null {
  return running?.directory ?? null;
}

/** What the admin's CLUSTER_DEBUG answer is built from (cluster/nodedebug.ts): this node's own memory, read-only. Null outside cluster mode. */
export function clusterDebugSource(): ClusterDebugSource | null {
  const node = running;
  if (!node) return null;
  return {
    self: () => node.self,
    ownersOf: (map) => node.blocks.ownersOf(map),
    epochOf: (map) => node.blocks.epochOf(map),
    extentOf: (map) => node.blocks.extentOf(map),
    blockOf: (map, x, y) => node.blocks.blockOf(map, x, y),
    givenAway: (map, bx, by) => node.mover?.givenAway(map, bx, by) ?? false,
  };
}

/** When this run of the node started (its announcement's startedAt), or null outside cluster mode. */
export function clusterStartedAt(): number | null {
  return running?.startedAt ?? null;
}

/** The players on the region's other nodes; 0 outside cluster mode. */
export function peersOnline(): number {
  return running?.census.othersOnline() ?? 0;
}

/** The load reports of the region's other nodes; none outside cluster mode. */
export function peerReports(): readonly LoadReport[] {
  return running?.census.reports() ?? [];
}

/** What each of the region's other nodes says of itself; none outside cluster mode. Resolves within a short wait. */
export function peerRoster(): Promise<PeerRoster[]> {
  return running?.census.roster() ?? Promise.resolve([]);
}

/** Tells the other nodes' control panels what an admin did here. Does nothing outside cluster mode. */
export function sharePanelActivity(entry: unknown): void {
  running?.census.shareActivity(entry);
}

export function spawnsHere(map: string, x: number, y: number): boolean {
  const node = running;
  if (!node) return true;
  if (!spawnGateOpen(node)) {
    node.gateOpen = false;
    return false;
  }
  const owner = node.blocks.ownerOf(map, x, y);
  if (owner && owner.nodeId !== node.self) return false;
  // A block this node gave away keeps its slots off here until the table shows where it went (Task 20).
  if (node.mover) {
    const { bx, by } = node.blocks.blockOf(map, x, y);
    if (node.mover.givenAway(map, bx, by)) return false;
  }
  return owner ? true : node.unownedOpen;
}

/** Whether the node spawns at all: it is not fenced, holds its lease, its run is not taken, and the mover's seed has run. */
function spawnGateOpen(node: RunningNode): boolean {
  return !node.fenced && node.seeded && node.registry.leaseValid() && !node.registry.taken();
}

/** The gate was shut and is open now: the slots skipped meanwhile are looked at again. */
function watchSpawnGate(node: RunningNode): void {
  const open = spawnGateOpen(node);
  const opened = open && !node.gateOpen;
  node.gateOpen = open;
  if (opened && running === node && !node.stopped) tellBlockChanges(node.maps);
}

/** Runs the mover's seed once; a store that cannot be read leaves the gate shut, for the mover's timer to try again. */
async function seedMover(node: RunningNode): Promise<void> {
  if (node.seeded || !node.mover) return;
  try {
    await node.mover.seed();
    node.seeded = true;
  } catch (error) {
    if (!node.seedFailing) log.error(`Cluster node ${node.self} could not read its open move orders, so nothing spawns here until it can: ${error}`);
    node.seedFailing = true;
    return;
  }
  if (node.seedFailing) log.info(`Cluster node ${node.self} has read its open move orders: it spawns again`);
  node.seedFailing = false;
  watchSpawnGate(node);
}

/** The mover's timer: the seed until it has run, then the review of the blocks given away. */
async function reviewMover(node: RunningNode): Promise<void> {
  const mover = node.mover;
  if (!mover) return;
  if (!node.seeded) {
    await seedMover(node);
    return;
  }
  const before = mover.givenCount();
  try {
    await mover.review();
  } catch (error) {
    log.error(`Cluster node ${node.self} could not review the blocks it gave away: ${error}`);
  }
  // A block given back (its order read aborted) is this node's to spawn in again.
  if (mover.givenCount() < before && running === node && !node.stopped) tellBlockChanges(node.maps);
}

export function onBlocksChanged(listener: (maps: string[]) => void): () => void {
  blockListeners.add(listener);
  return () => { blockListeners.delete(listener); };
}

/** Where the load report counts creatures from: the creature system (this module does not load it). */
export function reportCreaturesFrom(source: (() => Iterable<CreaturePosition>) | null, total: (() => number) | null = null): void {
  creatures = source;
  creaturesTotal = total;
}

/** This node's players and awake creatures, per block (`${map}|${bx},${by}`): players + 0.1 x creatures + 0.15 x visible pairs. */
export function loadReport(self: string, at: number, table?: BlockTable, lagMs?: number): LoadReport {
  const blocks: Record<string, number> = {};
  const add = (map: string, x: number, y: number, load: number) => {
    // No position yet (logging in, changing maps): counted in the totals, but blockAt would put it in block 0,0.
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    // Clamped like ownerOf: a position on the far edge counts in the edge block the coordinator weighs.
    const { bx, by } = table?.blockOf(map, x, y) ?? blockAt(x, y);
    const key = `${bare(map)}|${blockKey(bx, by)}`;
    blocks[key] = (blocks[key] ?? 0) + load;
  };
  let players = 0;
  for (const player of Object.values(playerCache.list())) {
    const location = (player as any)?.location;
    if (!location?.map) continue;
    players++;
    const seen = Number((player as any)?.aoi?.playersInAOI?.size) || 0;
    add(String(location.map), Number(location.position?.x), Number(location.position?.y), 1 + seen * VISIBLE_PAIR_LOAD);
  }
  let active = 0;
  for (const creature of creatures?.() ?? []) {
    // A corpse is not load.
    if (creature.state === "dead") continue;
    active++;
    add(creature.map, creature.x, creature.y, CREATURE_LOAD);
  }
  // 0.1 + 0.1 + 0.1 is not 0.3 in floating point.
  for (const key in blocks) blocks[key] = Math.round(blocks[key]! * 10) / 10;
  // creaturesTotal is not load: it never enters `blocks`, which is all the rebalancer weighs.
  return { nodeId: self, at, players, creatures: active, creaturesTotal: creaturesTotal?.() ?? active, blocks, memoryMb: Math.round(process.memoryUsage().rss / 1048576), ...(lagMs === undefined ? {} : { lagMs }) };
}

async function beat(node: RunningNode): Promise<void> {
  try {
    await node.registry.beat(node.self);
    await node.registry.report(loadReport(node.self, Date.now(), node.blocks, node.lag.max()));
    node.failing = false;
  } catch (error) {
    // Logged when it starts failing, not every second while Redis is away.
    if (!node.failing) log.error(`Cluster node ${node.self} could not beat: ${error}`);
    node.failing = true;
  }
  // A beat that found this run taken (its tombstone, or its lease lapsed and its announcement gone) stops the node.
  if (node.registry.taken() && !node.stopped) node.fence("its run was taken over");
  watchSpawnGate(node);
  await watchCoordinator(node);
}

async function watchCoordinator(node: RunningNode): Promise<void> {
  const now = Date.now();
  if (!node.coordinatorSeen) node.graceLeft = Math.max(0, node.graceLeft - (now - node.checkedAt));
  node.checkedAt = now;
  try {
    node.coordinatorSeen = (await node.store.get(LOCK_KEY)) !== null;
  } catch {
    // Unknown: as last seen.
  }
  const open = !node.coordinatorSeen && node.graceLeft <= 0;
  // A beat that ends after stopCluster tells no one.
  if (open === node.unownedOpen || node.stopped) return;
  node.unownedOpen = open;
  // Slots skipped for a block no one owns are looked at again.
  if (open) tellBlockChanges(node.maps);
}

async function refresh(node: RunningNode): Promise<void> {
  try {
    // A map that changed tells the listeners through BlockTable.onChange.
    await node.blocks.refresh();
    node.refreshFailing = false;
  } catch (error) {
    if (!node.refreshFailing) log.error(`Cluster node ${node.self} could not re-read its block table: ${error}`);
    node.refreshFailing = true;
  }
  await watchPeers(node);
}

async function watchPeers(node: RunningNode): Promise<void> {
  try {
    const live = (await node.registry.live()).filter((info) => info.regionId === regionId()).map((info) => info.nodeId);
    if (!node.stopped) node.followLive(live);
    node.peersFailing = false;
  } catch (error) {
    if (!node.peersFailing) log.error(`Cluster node ${node.self} could not read the live nodes for its links: ${error}`);
    node.peersFailing = true;
  }
}

function tellBlockChanges(maps: string[]): void {
  for (const listener of blockListeners) {
    try {
      listener(maps);
    } catch (error) {
      log.error(`A block table listener failed: ${error}`);
    }
  }
}

/** The size of every loaded map, worlds included (their properties are in the same list). */
async function loadedMaps(): Promise<MapExtent[]> {
  const properties = ((await assetCache.get("mapProperties")) ?? []) as MapProperties[];
  return properties
    .filter((map) => map?.name && map.width > 0 && map.height > 0)
    .map((map) => extentOf(map.name, map.width * map.tileWidth, map.height * map.tileHeight));
}
