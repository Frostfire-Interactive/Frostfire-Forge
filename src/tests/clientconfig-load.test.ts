import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { databaseModule } from "./setup";

// USER REPORT 2026-11-18: "Not all settings in clientconfig are saving to the database when changed." They were saved;
// a login then read them back as their defaults, and the next change saved those defaults over them.
//
// A real in-memory SQLite database behind the engine's query function, so a statement that leaves a column out really
// gets no value for it. A table the test did not create is an empty one (the login reads many).

let db: Database;

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, params: any[] = []) => {
    try {
      const statement = db.query(sql);
      if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params);
      statement.run(...params);
      return { affectedRows: 1 };
    } catch (error: any) {
      if (/no such table/.test(String(error?.message))) return [];
      throw error;
    }
  },
}));

const { clearCaches } = await import("../services/datacache");
const { default: player } = await import("../systems/player");
const { packetManager } = await import("../socket/packet_manager");

const ACCOUNTS = `CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
  map TEXT DEFAULT 'overworld', position TEXT DEFAULT '0,0', direction TEXT DEFAULT 'down',
  role INTEGER DEFAULT 0, guest_mode INTEGER DEFAULT 0, stealth INTEGER DEFAULT 0, noclip INTEGER DEFAULT 0,
  party_id INTEGER, guild_id INTEGER, is_dead INTEGER DEFAULT 0, corpse_map TEXT, corpse_x INTEGER, corpse_y INTEGER,
  subscribed INTEGER DEFAULT 0
)`;
/** clientconfig as the setup scripts make it now. */
const CLIENTCONFIG = `CREATE TABLE clientconfig (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
  fps INTEGER NOT NULL DEFAULT 60, music_volume INTEGER NOT NULL DEFAULT 50, effects_volume INTEGER NOT NULL DEFAULT 30,
  ambience_volume INTEGER NOT NULL DEFAULT 50, weather_volume INTEGER NOT NULL DEFAULT 60,
  muted INTEGER NOT NULL DEFAULT 0, auto_loot INTEGER NOT NULL DEFAULT 0, hotbar_config TEXT, inventory_config TEXT
)`;
/** clientconfig of a database set up before the Ambience, Weather and Auto loot settings. */
const OLD_CLIENTCONFIG = `CREATE TABLE clientconfig (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
  fps INTEGER NOT NULL DEFAULT 60, music_volume INTEGER NOT NULL DEFAULT 100, effects_volume INTEGER NOT NULL DEFAULT 100,
  muted INTEGER NOT NULL DEFAULT 0, hotbar_config TEXT, inventory_config TEXT
)`;

function setUp(clientconfig: string) {
  db = new Database(":memory:");
  db.run(ACCOUNTS);
  db.run(clientconfig);
  db.run("INSERT INTO accounts (username) VALUES ('loot_fan')");
}

beforeEach(async () => {
  await clearCaches();
});

describe("a login's settings", () => {
  // The login read runs on a login worker (socket/authentication.ts), a thread of its own where the step that adds
  // these columns at start (ensureAmbienceColumn) never ran. Nothing in this file runs it either.
  test("are every setting saved, read on a thread that never added the newer columns", async () => {
    setUp(CLIENTCONFIG);
    db.run(`INSERT INTO clientconfig (username, fps, music_volume, effects_volume, ambience_volume, weather_volume, muted, auto_loot)
      VALUES ('loot_fan', 90, 23, 29, 37, 41, 0, 1)`);

    const data = (await player.GetPlayerLoginData("loot_fan")) as any;

    expect(data.config).toHaveLength(1);
    expect(data.config[0]).toMatchObject({
      fps: 90, music_volume: 23, effects_volume: 29, ambience_volume: 37, weather_volume: 41, auto_loot: true,
    });
    expect(Boolean(data.config[0].muted)).toBe(false);
  });

  test("are the newer settings' defaults on a database from before them", async () => {
    setUp(OLD_CLIENTCONFIG);
    db.run("INSERT INTO clientconfig (username, fps, music_volume, effects_volume, muted) VALUES ('loot_fan', 90, 23, 29, 1)");

    const data = (await player.GetPlayerLoginData("loot_fan")) as any;

    expect(data.config[0]).toMatchObject({
      fps: 90, music_volume: 23, effects_volume: 29, ambience_volume: 50, weather_volume: 60, auto_loot: false,
    });
    expect(Boolean(data.config[0].muted)).toBe(true);
  });
});

describe("the CLIENTCONFIG packet", () => {
  const sent = (config: any[]) => JSON.parse(new TextDecoder().decode(packetManager.clientConfig(config)[0])).data;

  // Equipping from a bag sends the settings again from the row they are held in (socket/handlers/items.ts), where Auto
  // loot is 1 or 0. The client turns its box on only for true, and the next change it sends would save it off.
  test("says Auto loot as true or false, though the held row has it as 1 or 0", () => {
    expect(sent([{ fps: 60, music_volume: 50, effects_volume: 50, auto_loot: 1, muted: 0 }])[0].auto_loot).toBe(true);
    expect(sent([{ fps: 60, music_volume: 50, effects_volume: 50, auto_loot: 0, muted: 0 }])[0].auto_loot).toBe(false);
  });

  test("leaves a login's settings as they are", () => {
    const config = [{ fps: 60, music_volume: 50, effects_volume: 50, ambience_volume: 37, weather_volume: 41, auto_loot: true, muted: false, spell_cooldowns: { frost_bolt: 900 }, spell_lockout: 0 }];
    expect(sent(config)).toEqual(config);
  });
});
