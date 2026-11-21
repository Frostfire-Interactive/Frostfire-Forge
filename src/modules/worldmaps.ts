import path from "path";
import fs from "fs";
import crypto from "crypto";
import log from "./logger";
import { removeUnlistedWorlds } from "./mapmirror";
import { leaveToSave } from "./mapsaves";
import { cleanZonesLenient, zonesOfKind } from "./zones";

const BITS_MAGIC = 0x42574646; // "FFWB"
const BITS_HEADER_BYTES = 32;
const FORMAT_VERSION = 1;
const ROLE_COLLISION = 1;
const ROLE_NOPVP = 2;

const WORLD_FILES = ["collision.bits", "nopvp.bits", "manifest.json"] as const;

/** One bit per tile. */
export class WorldBits {
  readonly width: number;
  readonly height: number;
  private readonly blockBytes: number;
  private readonly shift: number;
  private readonly mask: number;

  constructor(private bytes: Uint8Array, chunkSize: number, private readonly chunksX: number, chunksY: number) {
    this.width = chunksX * chunkSize;
    this.height = chunksY * chunkSize;
    this.blockBytes = (chunkSize * chunkSize) >>> 3;
    this.shift = Math.log2(chunkSize);
    this.mask = chunkSize - 1;
  }

  /** 1 when the tile is set, 0 when it is not or lies outside the world. */
  isSet(tileX: number, tileY: number): number {
    if (!(tileX >= 0 && tileY >= 0 && tileX < this.width && tileY < this.height)) return 0;
    const k = ((tileY & this.mask) << this.shift) | (tileX & this.mask);
    const byte = BITS_HEADER_BYTES + ((tileY >> this.shift) * this.chunksX + (tileX >> this.shift)) * this.blockBytes + (k >> 3);
    return (this.bytes[byte]! >> (k & 7)) & 1;
  }

  adopt(newer: WorldBits): void {
    if (newer.width !== this.width || newer.height !== this.height) throw new Error("the world changed size");
    this.bytes = newer.bytes;
  }
}

export interface WorldMap {
  id: string;
  /** "<id>.json" */
  name: string;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  /** Tiles along a side of a chunk, as the asset server serves the world's tiles (/map-chunk). */
  chunkSize: number;
  collision: WorldBits;
  nopvp: WorldBits;
  /** Where new players start, in pixels (the generator picks a town square). */
  spawn: { x: number; y: number } | null;
  /** The entry of the "maps" cache: the map without its tiles. */
  map: MapData;
  /** The entry of the "mapProperties" cache, set by the loader. Its warps are read by movement. */
  properties: MapProperties | null;
}

const worlds = new Map<string, WorldMap>();
/** The maps folder the worlds were loaded from. */
let worldsDir = "";

/** mapName with or without ".json" */
export function getWorldMap(mapName: string): WorldMap | undefined {
  return worlds.get(mapName.replace(".json", ""));
}

function isPositiveInt(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function readBits(file: string, role: number, chunkSize: number, chunksX: number, chunksY: number, expectedHash: unknown): WorldBits {
  const bytes = new Uint8Array(fs.readFileSync(file));
  const name = path.basename(file);
  if (bytes.byteLength < BITS_HEADER_BYTES) throw new Error(`${name} is cut short`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== BITS_MAGIC) throw new Error(`${name} is not a bitset file`);
  if (view.getUint16(4, true) !== FORMAT_VERSION || view.getUint16(6, true) !== BITS_HEADER_BYTES) throw new Error(`${name} has an unknown format version`);
  if (view.getUint16(8, true) !== chunkSize || view.getUint16(10, true) !== chunksX || view.getUint16(12, true) !== chunksY) {
    throw new Error(`${name} does not match the size in manifest.json`);
  }
  if (view.getUint16(14, true) !== role) throw new Error(`${name} holds the wrong kind of data`);
  if (bytes.byteLength !== BITS_HEADER_BYTES + chunksX * chunksY * ((chunkSize * chunkSize) >>> 3)) throw new Error(`${name} has the wrong length`);
  const bodyHash = BigInt.asUintN(64, BigInt(Bun.hash.xxHash64(bytes.subarray(BITS_HEADER_BYTES))));
  if (bodyHash !== view.getBigUint64(16, true)) throw new Error(`${name} is damaged`);
  // A sync cut short can leave bitsets of one build beside the manifest of another
  if (bodyHash.toString(16).padStart(16, "0") !== expectedHash) throw new Error(`${name} belongs to another build of the world than manifest.json`);
  return new WorldBits(bytes, chunkSize, chunksX, chunksY);
}

export interface Desert {
  name: string;
  /** The zone's bounds in tiles. */
  bbox: { x: number; y: number; w: number; h: number };
  /** Its rings in tiles, each [[x, y], ...]: a point is inside when an odd number of them surround it. */
  outline: number[][][];
}

/** The zones of a manifest whose kind is "desert", with what is not a number left out. */
export function desertsOf(zones: unknown): Desert[] {
  return zonesOf(zones, "desert");
}

/** The zones of a manifest whose kind is "snow" (a blizzard is only drawn inside them), as desertsOf. */
export function snowfieldsOf(zones: unknown): Desert[] {
  return zonesOf(zones, "snow");
}

/** The zones of a manifest of one kind, with what is not a number left out. */
function zonesOf(zones: unknown, kind: string): Desert[] {
  return zonesOfKind(zones, kind);
}

function openWorld(dir: string, id: string): WorldMap {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf-8"));

  if (manifest?.format !== "ffworld") throw new Error("manifest.json is not a world manifest");
  if (manifest.formatVersion !== FORMAT_VERSION) throw new Error(`unsupported world format version ${manifest.formatVersion}`);

  const { width, height, tilewidth, tileheight, chunkSize } = manifest;
  if (!isPositiveInt(width) || !isPositiveInt(height) || !isPositiveInt(tilewidth) || !isPositiveInt(tileheight) || !isPositiveInt(chunkSize)) {
    throw new Error("manifest.json has no valid size");
  }
  if ((chunkSize & (chunkSize - 1)) !== 0 || chunkSize < 8 || width % chunkSize !== 0 || height % chunkSize !== 0) {
    throw new Error("the world size is not a whole number of chunks");
  }
  if (!Array.isArray(manifest.layers) || !Array.isArray(manifest.objects)) throw new Error("manifest.json has no layers or objects");

  const chunksX = width / chunkSize;
  const chunksY = height / chunkSize;
  const collision = readBits(path.join(dir, "collision.bits"), ROLE_COLLISION, chunkSize, chunksX, chunksY, manifest.bitsets?.collision?.hash);
  const nopvp = readBits(path.join(dir, "nopvp.bits"), ROLE_NOPVP, chunkSize, chunksX, chunksY, manifest.bitsets?.nopvp?.hash);

  // The layer list of a Tiled map, in the same order: tile layers without data, object layers with their objects
  const layers = manifest.layers.map((layer: any) => {
    if (layer.type === "objectgroup") {
      return {
        id: layer.id,
        name: layer.name,
        type: "objectgroup",
        visible: layer.visible !== false,
        objects: manifest.objects.filter((object: any) => object.layer === layer.name),
      };
    }
    return {
      id: layer.id,
      name: layer.name,
      type: "tilelayer",
      visible: layer.visible !== false,
      width,
      height,
      ...(layer.properties ? { properties: layer.properties } : {}),
    };
  });

  const name = `${id}.json`;
  const { zones, dropped, fixed } = cleanZonesLenient(manifest.zones, width, height);
  for (const problem of dropped) log.warn(`World ${id}: zone left out: ${problem}`);
  for (const note of fixed) log.info(`World ${id}: ${note}`);
  const deserts = desertsOf(zones), snowfields = snowfieldsOf(zones);
  const spawn = manifest.spawn && Number.isFinite(manifest.spawn.x) && Number.isFinite(manifest.spawn.y)
    ? { x: Number(manifest.spawn.x), y: Number(manifest.spawn.y) }
    : null;

  return {
    id,
    name,
    width,
    height,
    tileWidth: tilewidth,
    tileHeight: tileheight,
    chunkSize,
    collision,
    nopvp,
    spawn,
    map: {
      name,
      world: true,
      data: {
        width,
        height,
        tilewidth,
        tileheight,
        tilesets: manifest.tilesets || [],
        infinite: false,
        layers,
        ...(manifest.warps ? { warps: manifest.warps } : {}),
        ...(manifest.graveyards ? { graveyards: manifest.graveyards } : {}),
        // the named zones drawn in the map editor (zone text and music, modules/zones.ts), sent to the client with the map
        zones,
        // the cave systems of an underworld, as rectangles in tiles (sent to the client with the map)
        ...(Array.isArray(manifest.sections) ? { sections: manifest.sections } : {}),
        // the desert zones, as outlines in tiles: a sandstorm is only drawn inside them (sent to the client with the map)
        ...(deserts.length ? { deserts } : {}),
        // the snow zones, the same way: a blizzard is only drawn inside them
        ...(snowfields.length ? { snowfields } : {}),
      },
      compressed: Buffer.alloc(0),
    } as any,
    properties: null,
  };
}

export function loadWorldMaps(mapDir: string, tiledMapNames: Set<string>): WorldMap[] {
  worldsDir = mapDir;
  worlds.clear();
  if (!fs.existsSync(mapDir)) return [];

  for (const entry of fs.readdirSync(mapDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".world")) continue;
    const id = entry.name.slice(0, -".world".length);
    if (!id) continue;
    if (tiledMapNames.has(`${id}.json`)) {
      log.error(`World ${entry.name} skipped: ${id}.json is already a map. Remove one of the two.`);
      continue;
    }
    try {
      const world = openWorld(path.join(mapDir, entry.name), id);
      worlds.set(id, world);
      log.debug(`Loaded world: ${entry.name} (${world.width} x ${world.height} tiles)`);
    } catch (error: any) {
      log.error(`World ${entry.name} skipped: ${error?.message ?? error}`);
    }
  }

  return [...worlds.values()];
}

/** A world the asset server has just made (the map editor's New map): fetched like the others, then opened and kept. */
export async function addWorldMap(id: string): Promise<WorldMap> {
  if (!worldsDir) throw new Error("the worlds have not been loaded");
  if (worlds.has(id)) throw new Error(`${id} is already a world`);
  for (const synced of await syncWorldMaps(worldsDir)) if (synced !== id) changedElsewhere.add(synced);
  const world = openWorld(path.join(worldsDir, `${id}.world`), id);
  worlds.set(id, world);
  return world;
}

const changedElsewhere = new Set<string>();

export async function refreshWorldMap(mapName: string): Promise<void> {
  const world = getWorldMap(mapName);
  if (!world || !worldsDir) throw new Error(`${mapName} is not a loaded world`);
  for (const id of await syncWorldMaps(worldsDir)) if (id !== world.id) changedElsewhere.add(id);
  const dir = path.join(worldsDir, `${world.id}.world`);
  const fresh = openWorld(dir, world.id);
  world.collision.adopt(fresh.collision);
  world.nopvp.adopt(fresh.nopvp);
  // the world as the asset server holds it is now in place: a change of it left to this save is taken in
  changedElsewhere.delete(world.id);
  // a new version has clients drop the chunks they kept of the old one
  if (world.properties) world.properties.version = String(fs.statSync(path.join(dir, "manifest.json")).mtimeMs);
}

function sha256(data: Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function fileHash(file: string): string | null {
  try {
    return sha256(fs.readFileSync(file));
  } catch {
    return null;
  }
}

const syncedFiles = new Map<string, string>();

// The sync under way: a second one waits for it, so that one world's new files are fetched, and reported, once
let syncing: Promise<unknown> = Promise.resolve();

export function syncWorldMaps(mapDir: string): Promise<string[]> {
  const run = syncing.then(() => syncWorldMapsNow(mapDir));
  syncing = run.catch(() => {});
  return run;
}

async function syncWorldMapsNow(mapDir: string): Promise<string[]> {
  const synced: string[] = [];
  const assetServerUrl = process.env.ASSET_SERVER_INTERNAL_URL || process.env.ASSET_SERVER_URL;
  if (!assetServerUrl) return synced;

  const authKey = process.env.ASSET_SERVER_AUTH_KEY || process.env.GATEWAY_AUTH_KEY;
  const { serverFetch } = await import("./https_servers.ts");
  const post =(route: string, body: Record<string, unknown>) => serverFetch(`${assetServerUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, authKey }),
  });

  try {
    const response = await post("/world-list", { serverId: process.env.SERVER_ID || "game-server" });
    if (!response.ok) {
      // An asset server without world support answers 404 or a redirect: nothing to sync
      log.debug(`World sync skipped: the asset server answered ${response.status}`);
      return synced;
    }
    const result = await response.json().catch(() => null) as any;
    if (!result?.success || !Array.isArray(result.worlds)) return synced;

    for (const world of result.worlds) {
      const id = String(world?.id ?? "");
      if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(id) || id.includes("..")) {
        log.warn(`World sync: skipped a world with an unusable name (${JSON.stringify(world?.id)})`);
        continue;
      }
      const dir = path.join(mapDir, `${id}.world`);
      const listed = JSON.stringify(WORLD_FILES.map(file => world.files?.[file] ?? null));
      if (syncedFiles.get(id) === listed) continue;
      const outdated = WORLD_FILES.filter(file => fileHash(path.join(dir, file)) !== world.files?.[file]);
      if (outdated.length === 0) {
        syncedFiles.set(id, listed);
        continue;
      }

      log.info(`Syncing world ${id} from asset server (${outdated.join(", ")})...`);
      fs.mkdirSync(dir, { recursive: true });
      let complete = true;
      for (const file of outdated) {
        const fileResponse = await post("/world-file", { id, file });
        if (!fileResponse.ok) {
          log.error(`Failed to sync world ${id}: ${file} answered ${fileResponse.status}`);
          complete = false;
          break;
        }
        const bytes = new Uint8Array(await fileResponse.arrayBuffer());
        if (sha256(bytes) !== world.files[file]) {
          log.error(`Failed to sync world ${id}: ${file} arrived damaged`);
          complete = false;
          break;
        }
        const target = path.join(dir, file);
        fs.writeFileSync(`${target}.tmp`, bytes);
        fs.renameSync(`${target}.tmp`, target);
      }
      if (complete) {
        syncedFiles.set(id, listed);
        synced.push(id);
        log.success(`Synced world: ${id}`);
      }
    }

    // A local world the asset server no longer lists is removed (modules/mapmirror.ts).
    for (const id of removeUnlistedWorlds(mapDir, result.worlds.map((world: any) => String(world?.id ?? "")))) {
      log.warn(`Removed world ${id}.world: the asset server no longer has it`);
    }
  } catch (error) {
    log.warn(`Failed to sync worlds from asset server: ${error}`);
  }
  return synced;
}

export function warpsAndGraveyardsOf(manifest: any): { warps: any[] | null; graveyards: any[] | null } {
  const warps: any[] = [];
  const graveyards: any[] = [];
  for (const obj of Array.isArray(manifest?.objects) ? manifest.objects : []) {
    const layerName = String(obj?.layer ?? "");
    const type = String(obj?.class || obj?.type || layerName).toLowerCase();
    const props = new Map((Array.isArray(obj?.properties) ? obj.properties : []).map((p: any) => [p?.name, p?.value]));
    if (type === "warp") {
      const map = props.get("map"), x = props.get("x"), y = props.get("y");
      if (!map || x === undefined || y === undefined) continue;
      warps.push({
        name: obj.name, map, x, y,
        position: { x: Math.floor(obj.x), y: Math.floor(obj.y) },
        size: { width: Math.floor(obj.width), height: Math.floor(obj.height) },
        layer: layerName,
      });
    } else if (type === "graveyard") {
      graveyards.push({ name: obj.name, position: { x: Math.floor(obj.x), y: Math.floor(obj.y) }, layer: layerName });
    }
  }
  const listed = (value: any) => (Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : []);
  return {
    warps: warps.length ? warps : listed(manifest?.warps).length ? listed(manifest.warps) : null,
    graveyards: graveyards.length ? graveyards : listed(manifest?.graveyards).length ? listed(manifest.graveyards) : null,
  };
}

let checking = false;

export async function checkWorldChanges(): Promise<WorldMap[]> {
  if (!worldsDir || checking) return [];
  checking = true;
  try {
    const changed: WorldMap[] = [];
    const synced = await syncWorldMaps(worldsDir);
    const ids = new Set([...changedElsewhere, ...synced]);
    changedElsewhere.clear();
    for (const id of ids) {
      const world = worlds.get(id);
      if (!world) continue; // a world new to this server joins at the next start
      if (leaveToSave(id)) {
        // kept for the next check, unless the save takes the world in first
        changedElsewhere.add(id);
        log.debug(`World ${id} changed on the asset server: a save under way, which takes it in`);
        continue;
      }
      const dir = path.join(worldsDir, `${id}.world`);
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf-8"));
        const fresh = openWorld(dir, id);
        world.collision.adopt(fresh.collision);
        world.nopvp.adopt(fresh.nopvp);
        world.map.data = fresh.map.data;
        if (world.properties) {
          const { warps, graveyards } = warpsAndGraveyardsOf(manifest);
          world.properties.warps = warps;
          world.properties.graveyards = graveyards;
          world.properties.version = String(fs.statSync(path.join(dir, "manifest.json")).mtimeMs);
        }
        changed.push(world);
      } catch (error: any) {
        log.error(`World ${id} changed on the asset server but could not be taken in: ${error?.message ?? error}. Restart to load it.`);
      }
    }
    return changed;
  } finally {
    checking = false;
  }
}
