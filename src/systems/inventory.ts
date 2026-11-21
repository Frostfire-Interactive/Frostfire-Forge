import query, { transaction } from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";
import { rowCache, turns } from "../services/datacache";
import type { Batch } from "../services/batch";
import log from "../modules/logger";
import { settledThen } from "../cluster/tradesettle";
import { characterIdOf, needCharacterId } from "./characterids";

async function getItems(): Promise<Item[]> {
  return await assetCache.get("items") as Item[] || [];
}

/** A row of the inventory table. */
interface InventoryRow {
  id: number;
  character_id: number;
  item: string;
  quantity: number;
  equipped: number;
  slot: number | null;
  bag_slot: number | null;
}

// Each player's rows, as the table has them: held under the character's name, kept by its id.
const rows = rowCache<InventoryRow[]>("inventory", async (username) => {
  const characterId = await characterIdOf(String(username));
  if (characterId === null) return [];
  return (await query(
    "SELECT id, character_id, item, quantity, equipped, slot, bag_slot FROM inventory WHERE character_id = ?",
    [characterId]
  )) as InventoryRow[] || [];
}, { perPlayer: true });

const oneAtATime = turns();

function change<T>(username: string, work: () => Promise<T>): Promise<T> {
  return oneAtATime(username, async () => {
    try {
      return await work();
    } catch (error) {
      await rows.drop(username);
      throw error;
    }
  });
}

// The rows a WHERE on a name picks: MySQL compares text without regard to case, the other engines exactly.
const sameName = (a: string, b: string) =>
  (process.env.DATABASE_ENGINE || "mysql") === "mysql" ? String(a).toLowerCase() === String(b).toLowerCase() : a === b;

/** The rows as an UPDATE ... WHERE item = ? leaves them: `fields` on every row of that item. */
const changed = (held: InventoryRow[], item: string, fields: Partial<InventoryRow>) =>
  held.map((row) => (sameName(row.item, item) ? { ...row, ...fields } : row));

/** The rows as a DELETE ... WHERE item = ? leaves them. */
const without = (held: InventoryRow[], item: string) => held.filter((row) => !sameName(row.item, item));

/** The id the database gave the row an INSERT made, when its answer says. */
function insertedId(result: any): number | null {
  const id = Number(result?.lastInsertRowid);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Whether an INT column holds `value` as it was given. Any other number the database rounds or clips its own way. */
const storedAsGiven = (value: unknown) => value == null || (Number.isInteger(value) && Math.abs(value as number) <= 2147483647);

async function hold(username: string, next: InventoryRow[], written: unknown[] = []) {
  if (written.every(storedAsGiven)) await rows.set(username, next);
  else await rows.drop(username);
}

/** An UPDATE of one item's rows, then the same `fields` on the rows held. `values` are what its SET is given, in order. */
function update(username: string, item: string, sql: string, values: unknown[], fields: Partial<InventoryRow>) {
  return change(username, async () => {
    const result = await query(sql, [...values, item, await needCharacterId(username)]);
    await hold(username, changed((await rows.get(username)) ?? [], item, fields), values);
    return result;
  });
}

/** What a batch has pending for a player: their rows as its statements so far leave them. */
interface Pending {
  held: InventoryRow[];
  /** The numbers its statements write, for `hold`. */
  written: unknown[];
  /** An INSERT of the batch was answered without an id: the rows cannot be worked out here. */
  unknown: boolean;
}

async function pendingIn(batch: Batch, username: string): Promise<Pending> {
  await batch.hold(oneAtATime, username);
  // Read once the player is settled: a trade lost across a border may still be swapped on its host (cluster/tradesettle.ts).
  return batch.pending(rows, username, () => settledThen(username, async () => {
    const state: Pending = { held: (await rows.get(username)) ?? [], written: [], unknown: false };
    batch.kept(() => (state.unknown ? rows.drop(username) : hold(username, state.held, state.written)));
    batch.undone(() => rows.drop(username));
    return state;
  }));
}

/** Collect objectives treat the inventory as the source of truth: the total now held of `item` is theirs to count. */
async function syncCollected(name: string, item: string) {
  try {
    const { sync: syncObjective } = await import("./quests/objectives");
    const stacks = await inventory.find(name, { name: item, quantity: 0 });
    const total = stacks?.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0) ?? 0;
    await syncObjective(name, "collect", item, total);
  } catch {
    // Quest sync is best-effort on the inventory path.
  }
}

const inventory = {
  async find(name: string, item: InventoryItem) {
    if (!name || !item.name) return;
    return ((await rows.get(name)) ?? []).filter((row) => sameName(row.item, item.name));
  },
  async heldIn(batch: Batch, name: string, item: string): Promise<{ quantity: number; equipped: boolean } | null> {
    const row = (await pendingIn(batch, name)).held.find((held) => sameName(held.item, item));
    return row ? { quantity: Number(row.quantity), equipped: Number(row.equipped) === 1 } : null;
  },
  async add(name: string, item: InventoryItem, batch?: Batch) {
    if (!name || !item?.quantity || !item?.name) return;
    if (Number(item.quantity) <= 0) return;
    const items = await getItems();
    const matchedItem = items.find((i) => i.name.toLowerCase() === item.name.toLowerCase());
    if (!matchedItem) return;
    const resolvedName = matchedItem.name;

    if (batch) {
      const state = await pendingIn(batch, name);
      const characterId = await needCharacterId(name);
      const stack = state.held.filter((row) => sameName(row.item, resolvedName));
      if (stack.length === 0) {
        const quantity = Number(item.quantity);
        state.held = [...state.held, { id: 0, character_id: characterId, item: resolvedName, quantity, equipped: 0, slot: null, bag_slot: null }];
        state.written.push(quantity);
        batch.add({
          sql: "INSERT IGNORE INTO inventory (character_id, item, quantity) VALUES (?, ?, ?)",
          values: [characterId, resolvedName, quantity],
          mustChange: true,
        }, (result) => {
          const id = insertedId(result);
          if (id === null) state.unknown = true;
          else state.held = changed(state.held, resolvedName, { id });
        });
      } else {
        const quantity = Number(stack[0].quantity) + Number(item.quantity);
        state.held = changed(state.held, resolvedName, { quantity });
        state.written.push(quantity);
        batch.add({
          sql: "UPDATE inventory SET quantity = ? WHERE item = ? AND character_id = ?",
          values: [quantity.toString(), resolvedName, characterId],
          mustChange: true,
        });
      }
      // Once the batch has ended: the count is the quest system's to write, in a turn of its own.
      batch.after(() => syncCollected(name, resolvedName));
      return true;
    }

    // The count written is worked out from the rows held: read once the player is settled (cluster/tradesettle.ts).
    const result = await change(name, () => settledThen(name, async () => {
      const characterId = await needCharacterId(name);
      const held = (await rows.get(name)) ?? [];
      const response = held.filter((row) => sameName(row.item, resolvedName));

      if (response.length === 0) {
        const quantity = Number(item.quantity);
        const result = await query(
          "INSERT IGNORE INTO inventory (character_id, item, quantity) VALUES (?, ?, ?)",
          [characterId, resolvedName, quantity]
        );
        const id = insertedId(result);
        if (id === null) await rows.drop(name);
        else await hold(name, [...held, { id, character_id: characterId, item: resolvedName, quantity, equipped: 0, slot: null, bag_slot: null }], [quantity]);
        return result;
      }

      const quantity = Number(response[0].quantity) + Number(item.quantity);
      const result = await query(
        "UPDATE inventory SET quantity = ? WHERE item = ? AND character_id = ?",
        [
          quantity.toString(),
          resolvedName,
          characterId,
        ]
      );
      await hold(name, changed(held, resolvedName, { quantity }), [quantity]);
      return result;
    }));
    // Sync the new total so picking up quest items credits immediately.
    await syncCollected(name, resolvedName);
    return result;
  },
  async setEquipped(name: string, item: string, equipped: boolean, targetSlot?: number, targetBagSlot?: number) {
    if (!name || !item || typeof equipped !== "boolean") return;
    if (equipped) {
      return await update(name, item,
        "UPDATE inventory SET equipped = 1 WHERE item = ? AND character_id = ?",
        [], { equipped: 1 }
      );
    } else {
      return await update(name, item,
        "UPDATE inventory SET equipped = 0, slot = ?, bag_slot = ? WHERE item = ? AND character_id = ?",
        [targetSlot ?? null, targetBagSlot ?? null], { equipped: 0, slot: targetSlot ?? null, bag_slot: targetBagSlot ?? null }
      );
    }
  },
  async setUnequippedSlot(name: string, item: string, slot: number | null, bagSlot: number | null) {
    if (!name || !item) return;
    return await update(name, item,
      "UPDATE inventory SET equipped = 0, slot = ?, bag_slot = ? WHERE item = ? AND character_id = ?",
      [slot, bagSlot ?? null], { equipped: 0, slot: slot ?? null, bag_slot: bagSlot ?? null }
    );
  },
  /** The item takes up no slot of the grid any more (every one of it is in use as a bag). */
  async clearSlot(name: string, item: string) {
    if (!name || !item) return;
    return await update(name, item,
      "UPDATE inventory SET slot = NULL, bag_slot = NULL WHERE item = ? AND character_id = ?",
      [], { slot: null, bag_slot: null }
    );
  },
  async saveSlots(username: string, slots: Array<{ item: string; slot: number; bag_slot: number }>) {
    if (!username) return;
    await change(username, async () => {
      const characterId = await needCharacterId(username);
      let held = (await rows.get(username)) ?? [];
      const written: unknown[] = [];
      await transaction(slots.map((s) => ({
        sql: "UPDATE inventory SET slot = ?, bag_slot = ? WHERE item = ? AND character_id = ?",
        values: [s.slot, s.bag_slot ?? null, s.item, characterId],
      })));
      for (const s of slots) {
        held = changed(held, s.item, { slot: s.slot ?? null, bag_slot: s.bag_slot ?? null });
        written.push(s.slot, s.bag_slot);
      }
      if (written.length > 0) await hold(username, held, written);
    });
  },
  /** With a `batch`: as `add` is. Undefined when the player holds none of the item, and nothing is added then. */
  async remove(name: string, item: InventoryItem, batch?: Batch) {
    if (!name || !item?.quantity || !item?.name) return;
    if (Number(item.quantity) <= 0) return;
    const items = await getItems();
    const matchedItem = items.find((i) => i.name.toLowerCase() === item.name.toLowerCase());
    if (!matchedItem) return;
    const resolvedName = matchedItem.name;

    if (batch) {
      const state = await pendingIn(batch, name);
      const stack = state.held.filter((row) => sameName(row.item, resolvedName));
      if (stack.length === 0) return;
      const characterId = await needCharacterId(name);
      if (Number(item.quantity) >= Number(stack[0].quantity)) {
        state.held = without(state.held, resolvedName);
        batch.add({ sql: "DELETE FROM inventory WHERE item = ? AND character_id = ?", values: [resolvedName, characterId], mustChange: true });
      } else {
        const quantity = Number(stack[0].quantity) - Number(item.quantity);
        state.held = changed(state.held, resolvedName, { quantity });
        state.written.push(quantity);
        batch.add({
          sql: "UPDATE inventory SET quantity = ? WHERE item = ? AND character_id = ?",
          values: [quantity.toString(), resolvedName, characterId],
          mustChange: true,
        });
      }
      // Giving away or using a quest item walks progress back down.
      batch.after(() => syncCollected(name, resolvedName));
      return true;
    }

    // As in add: read once the player is settled.
    const removed = await change(name, () => settledThen(name, async () => {
      const held = (await rows.get(name)) ?? [];
      const response = held.filter((row) => sameName(row.item, resolvedName));
      if (response.length === 0) return null;
      const characterId = await needCharacterId(name);

      if (Number(item.quantity) >= Number(response[0].quantity)) {
        const result = await query(
          "DELETE FROM inventory WHERE item = ? AND character_id = ?",
          [resolvedName, characterId]
        );
        await rows.set(name, without(held, resolvedName));
        return { result };
      }

      const quantity = Number(response[0].quantity) - Number(item.quantity);
      const result = await query(
        "UPDATE inventory SET quantity = ? WHERE item = ? AND character_id = ?",
        [
          quantity.toString(),
          resolvedName,
          characterId,
        ]
      );
      await hold(name, changed(held, resolvedName, { quantity }), [quantity]);
      return { result };
    }));
    if (!removed) return;
    // Dropping or using a quest item walks progress back down.
    await syncCollected(name, resolvedName);
    return removed.result;
  },
  async delete(name: string, item: InventoryItem) {
    if (!name || !item.name) return;
    return await change(name, () => settledThen(name, async () => {
      const result = await query(
        "DELETE FROM inventory WHERE item = ? AND character_id = ?",
        [item.name, await needCharacterId(name)]
      );
      await rows.set(name, without((await rows.get(name)) ?? [], item.name));
      return result;
    }));
  },
  async get(name: string) {
    if (!name) return [];

    const _items = ((await rows.get(name)) ?? []).map(({ item, quantity, equipped, slot, bag_slot }) => ({ item, quantity, equipped, slot, bag_slot })) as any[];

    if (!_items || _items.length === 0) return [];

    const items = await getItems();
    const itemsByName = new Map(items.map((i: any) => [i.name, i]));

    const details = await Promise.all(
      _items.map(async (item: any) => {

        const itemDetails = itemsByName.get(item.item);
        if (itemDetails) {
          return {
            ...itemDetails,
            ...item,
          };
        } else {

          log.error(`Item details not found for: ${item.item}`);
          return {
            ...item,
            name: item.item,
            quality: "unknown",
            description: "unknown",
            icon: null,
          };
        }

      })
    );
    return details;
  }
};

export default inventory;
