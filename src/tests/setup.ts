import { afterAll, mock } from "bun:test";
import { leaveSaves, type LeaveSaveDeps, type LeaveSaves } from "../socket/leavesavecore";
import { GuardError, type TransactionStatement } from "../controllers/sqltransaction";

export async function standInFor(path: string, standIn: () => Record<string, any>): Promise<void> {
  const real = { ...(await import(path)) };
  mock.module(path, standIn);
  afterAll(() => {
    mock.module(path, () => real);
  });
}

export const mockQuery = async (_sql: string, _params?: any[]) => {
  return [];
};

export function databaseModule<T extends { default: (sql: string, values?: any) => any }>(standIn: T) {
  return {
    GuardError,
    transaction: async (statements: TransactionStatement[]) => {
      const results: any[] = [];
      for (const [index, statement] of statements.entries()) {
        const result = await standIn.default(statement.sql, statement.values || []);
        if (statement.mustChange && (result?.affectedRows === 0 || result?.count === 0)) throw new GuardError(index);
        results.push(result);
      }
      return results;
    },
    ...standIn,
  };
}

const characterIds = new Map<string, number>();
const characterNames = new Map<number, string>();
const accountIds = new Map<string, number>();
const accountNames = new Map<number, string>();

/** The id `characterKeyedByName` gives the character named `name`: the same each time it is asked. */
export function testCharacterId(name: string): number {
  const key = String(name).toLowerCase();
  let id = characterIds.get(key);
  if (id === undefined) {
    id = 900001 + characterIds.size;
    characterIds.set(key, id);
    characterNames.set(id, key);
  }
  return id;
}

export function testAccountId(name: string): number {
  const key = String(name).toLowerCase();
  let id = accountIds.get(key);
  if (id === undefined) {
    id = 800001 + accountIds.size;
    accountIds.set(key, id);
    accountNames.set(id, key);
  }
  return id;
}

const nameOfCharacter = (value: unknown) => (typeof value === "number" && characterNames.has(value) ? characterNames.get(value)! : value);

export function characterKeyedByName<T extends { default: (sql: string, values?: any) => any }>(standIn: T): T {
  type Asked = { sql: string; values: any[]; then?: (result: any) => any };
  const byName = (sql: string, values: any[] = []): Asked => {
    const text = sql.replace(/\s+/g, " ").trim();
    let match = /^UPDATE characters SET (.+) WHERE id = \? AND account_id IN \(SELECT id FROM accounts WHERE session_id = \?\)$/i.exec(text);
    if (match) return { sql: `UPDATE accounts SET ${match[1]} WHERE session_id = ?`, values: [...values.slice(0, -2), values[values.length - 1]] };
    match = /^UPDATE characters SET (.+) WHERE id = \?$/i.exec(text);
    if (match) return { sql: `UPDATE accounts SET ${match[1]} WHERE username = ?`, values: values.map(nameOfCharacter) };
    match = /^UPDATE characters SET (.+) WHERE id IN \((\?(?:, \?)*)\)$/i.exec(text);
    if (match) return { sql: `UPDATE accounts SET ${match[1]} WHERE username IN (${match[2]})`, values: values.map(nameOfCharacter) };
    match = /^UPDATE characters SET (.+) WHERE (party_id|guild_id) = \?$/i.exec(text);
    if (match) return { sql: `UPDATE accounts SET ${match[1]} WHERE ${match[2]} = ?`, values };
    match = /^UPDATE characters SET (.+) WHERE account_id = \?$/i.exec(text);
    if (match) {
      const account = values[values.length - 1];
      if (typeof account === "number" && accountNames.has(account)) return { sql: `UPDATE accounts SET ${match[1]} WHERE username = ?`, values: [...values.slice(0, -1), accountNames.get(account)] };
      return { sql: `UPDATE accounts SET ${match[1]} WHERE id = ?`, values };
    }
    match = /^UPDATE accounts SET (.+) WHERE id = \?(.*)$/i.exec(text);
    if (match) {
      const at = match[1].split("?").length - 1;
      const account = values[at];
      if (typeof account === "number" && accountNames.has(account)) {
        const given = [...values];
        given[at] = accountNames.get(account);
        return { sql: `UPDATE accounts SET ${match[1]} WHERE username = ?${match[2]}`, values: given };
      }
      return { sql, values };
    }
    if (/\bcharacter_id\b/.test(text)) {
      const select = /^SELECT\b/i.test(text);
      // The inventory names its columns now that one of them is not the name; the stand-ins answer every column.
      const asked = text === "SELECT id, character_id, item, quantity, equipped, slot, bag_slot FROM inventory WHERE character_id = ?"
        ? "SELECT * FROM inventory WHERE character_id = ?"
        : sql;
      return {
        sql: asked.replace(/\bcharacter_id\b/g, "username"),
        values: values.map(nameOfCharacter),
        // A row read back is keyed as the database keeps it: by the character's id.
        then: select ? (result) => Array.isArray(result) ? result.map((row) => {
          if (!row || typeof row !== "object" || !("username" in row) || "character_id" in row) return row;
          const { username, ...rest } = row;
          return { ...rest, character_id: typeof username === "string" ? testCharacterId(username) : username };
        }) : result : undefined,
      };
    }
    return { sql, values };
  };
  const ask = async (sql: string, values: any[]) => {
    const asked = byName(sql, values);
    const result = await standIn.default(asked.sql, asked.values);
    return asked.then ? asked.then(result) : result;
  };
  const answer = async (sql: string, values: any[] = []): Promise<any> => {
    const text = sql.replace(/\s+/g, " ").trim();
    if (/^SELECT id FROM characters WHERE name_key = \?/i.test(text)) return [{ id: testCharacterId(values[0]) }];
    if (/^INSERT INTO characters \(account_id, name, name_key/i.test(text)) {
      const id = testCharacterId(values[1]);
      return { affectedRows: 1, insertId: id, lastInsertRowid: id };
    }
    // Every character's name, for searches: each of the stand-in's accounts is a character of that name.
    if (/^SELECT account_id AS id, name AS username FROM characters WHERE deleted_at IS NULL$/i.test(text)) {
      return standIn.default("SELECT id, username FROM accounts", []);
    }
    // An account's characters (player.accountCharacters): here an account is the one character of its name.
    if (/^SELECT c\.name, c\.class_id, s\.level FROM characters c LEFT JOIN stats s ON s\.character_id = c\.id WHERE c\.account_id = \?/i.test(text)) {
      const rows = (await standIn.default("SELECT username FROM accounts WHERE id = ?", [values[0]])) as any[];
      return Array.isArray(rows) ? rows.map((row) => ({ name: String(row.username), class_id: null, level: 1 })) : [];
    }
    // A character's account (accountNameOf): each character is an account of its own here, of the same name.
    if (/^SELECT a\.username FROM characters c JOIN accounts a ON a\.id = c\.account_id WHERE c\.name_key = \?/i.test(text)) return [{ username: values[0] }];
    if (/FROM characters c JOIN accounts a ON a\.id = c\.account_id WHERE c\.name_key = \?/i.test(text)) {
      const rows = (await standIn.default(
        "SELECT id, username, role, banned, guest_mode, stealth, noclip, is_dead, corpse_map, corpse_x, corpse_y, map, position, direction, party_id, guild_id FROM accounts WHERE username = ?",
        [values[0]]
      )) as any[];
      return Array.isArray(rows) ? rows.map((row) => ({ ...row, character_name: row?.username ?? values[0], character_id: testCharacterId(row?.username ?? values[0]) })) : rows;
    }
    if (/^SELECT account_id FROM characters WHERE id = \?/i.test(text)) {
      const name = nameOfCharacter(values[0]);
      if (typeof name !== "string") return [];
      const rows = (await standIn.default("SELECT id FROM accounts WHERE username = ?", [name])) as any[];
      const id = Array.isArray(rows) && rows[0]?.id !== undefined ? rows[0].id : testAccountId(name);
      return [{ account_id: id }];
    }
    // A character by name (characterByName): the stand-in's account of that name, which is the character.
    if (/^SELECT id, account_id, name, class_id, deleted_at FROM characters WHERE name_key = \? AND deleted_at IS NULL/i.test(text)) {
      const rows = (await standIn.default("SELECT id, username FROM accounts WHERE username = ?", [values[0]])) as any[];
      if (!Array.isArray(rows) || !rows[0]?.username) return [];
      const name = String(rows[0].username);
      return [{ id: testCharacterId(name), account_id: rows[0].id ?? testAccountId(name), name, class_id: null, deleted_at: null }];
    }
    // The names characters go by (currentNames): each name the stand-in has an account of.
    if (/^SELECT name_key, name FROM characters WHERE deleted_at IS NULL AND name_key IN \(/i.test(text)) {
      const found: Array<{ name_key: string; name: string }> = [];
      for (const key of values) {
        const rows = (await standIn.default("SELECT id, username FROM accounts WHERE username = ?", [key])) as any[];
        if (Array.isArray(rows) && rows[0]?.username) found.push({ name_key: String(key), name: String(rows[0].username) });
      }
      return found;
    }
    // A character's account's characters (siblingNamesOf): each character is an account of its own here.
    if (/^SELECT o\.name FROM characters c JOIN characters o ON o\.account_id = c\.account_id WHERE c\.name_key = \?/i.test(text)) return [{ name: values[0] }];
    if (/^SELECT c\.name AS member_name, gm\.character_id, gm\.guild_id, gm\.rank_index, gm\.public_note, gm\.officer_note FROM guild_members gm JOIN characters c/i.test(text)) {
      const rows = (await standIn.default("SELECT username, guild_id, rank_index, public_note, officer_note FROM guild_members", [])) as any[];
      return Array.isArray(rows) ? rows.map(({ username, ...rest }) => ({ member_name: username, character_id: testCharacterId(username), ...rest })) : rows;
    }
    if (/^SELECT g\.id, g\.name, g\.leader, g\.motd, c\.name AS leader_name FROM guilds g LEFT JOIN characters c/i.test(text)) {
      return standIn.default("SELECT id, name, leader, motd FROM guilds", []);
    }
    if (/^SELECT c\.name FROM learned_spells l JOIN characters c ON c\.id = l\.character_id WHERE l\.spell = \?/i.test(text)) {
      const rows = (await standIn.default("SELECT username FROM learned_spells WHERE spell = ?", [values[0]])) as any[];
      return Array.isArray(rows) ? rows.map((row) => ({ name: row.username })) : rows;
    }
    return ask(sql, values);
  };
  const shimmed: any = { ...standIn, default: answer };
  // A stand-in's own transaction is given its statements by name, as its query is.
  const own = (standIn as any).transaction;
  if (typeof own === "function") {
    shimmed.transaction = async (statements: Array<{ sql: string; values?: any[]; mustChange?: boolean }>, ...rest: any[]) =>
      own(statements.map((statement) => { const { sql, values } = byName(statement.sql, statement.values || []); return { ...statement, sql, values }; }), ...rest);
  }
  return shimmed;
}

/** databaseModule for a stand-in that keeps a character's rows by its name (characterKeyedByName). */
export function characterDatabaseModule<T extends { default: (sql: string, values?: any) => any }>(standIn: T) {
  return databaseModule(characterKeyedByName(standIn));
}

export function withLeaveSaves<T extends Record<string, any>>(given: T): T & LeaveSaves {
  return { ...given, ...leaveSaves(given as unknown as LeaveSaveDeps) };
}

export const mockAssetCache = {
  get: async (key: string) => {
    const mockData: Record<string, any> = {
      items: [
        { name: "test_item", quality: "common", description: "A test item", type: "equipment", equipable: true, level_requirement: 1 },
      ],
      audio: [{ name: "test_audio" }],
      mounts: [{ name: "test_mount", description: "A test mount" }],
      spells: [{ name: "test_spell", id: 1, damage: 10, mana: 5 }],
      quests: [{ id: 1, name: "test_quest", zone: null, offer_text: "", description: "A test quest", progress_text: "", completion_text: "", required_level: 1, quest_level: 1, xp_reward: 50, copper_reward: 0, repeatable: "none", next_quest_id: null, sort_order: 0, objectives: [], rewards: [], prerequisites: [] }],
      weather: [{ name: "clear", temperature: 20, humidity: 50, wind_speed: 0, wind_direction: "N", precipitation: 0, ambience: "clear" }],
      worlds: [{ name: "test_world", weather: "clear" }],
      mapProperties: [{ name: "main", warps: [], tileWidth: 32, tileHeight: 32 }],
      particles: [{ name: "test_particle" }],
      npcs: [{ id: 1, map: "main", position: { x: 100, y: 100 } }],
    };
    return mockData[key] || [];
  },
  set: async (_key: string, _value: any) => {},
  getNested: async (_key: string, _nestedKey: string) => {
    return [512, 512, 0, 262144];
  },
  add: async (_key: string, _value: any) => {},
};

export const mockLog = {
  error: (msg: string) => console.error(msg),
  warn: (msg: string) => console.warn(msg),
  info: (msg: string) => console.log(msg),
  debug: (msg: string) => console.log(msg),
  success: (msg: string) => console.log(msg),
};

export const mockPlayerCache = {
  get: (playerId: string) => ({
    id: playerId,
    username: "test_player",
    level: 1,
    experience: 0,
  }),
  set: (_playerId: string, _data: any) => {},
  has: (_playerId: string) => true,
  delete: (_playerId: string) => {},
};

export function createMockQueryResult(data: any[] = [], affectedRows = 1, lastInsertRowid = 1) {
  return {
    ...data,
    affectedRows,
    lastInsertRowid,
    length: data.length,
    [Symbol.iterator]: function* () {
      yield* data;
    },
  };
}

export function createMockCurrency(copper = 0, silver = 0, gold = 0) {
  return { copper, silver, gold };
}

export function createMockItem(overrides: any = {}) {
  return {
    name: "test_item",
    quality: "common",
    description: "A test item",
    type: "equipment",
    level_requirement: 1,
    equipable: true,
    icon: null,
    stat_armor: 0,
    stat_damage: 0,
    stat_critical_chance: 0,
    stat_critical_damage: 0,
    stat_health: 0,
    stat_stamina: 0,
    stat_avoidance: 0,
    equipment_slot: "helmet",
    ...overrides,
  };
}

export function createMockCollectable(overrides: any = {}) {
  return {
    username: "test_user",
    item: "test_item",
    type: "rare_item",
    ...overrides,
  };
}
