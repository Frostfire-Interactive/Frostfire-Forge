import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";
import { rowCache, turns } from "../services/datacache";
import { characterIdOf, needCharacterId } from "./characterids";
import inventory from "./inventory";
import log from "../modules/logger";

/** Every slot an item can be worn in: the item columns of the equipment table. */
export const EQUIPMENT_SLOTS = [
    "helmet", "necklace", "shoulderguards", "cape", "chestplate", "wristguards", "gloves", "belt",
    "pants", "boots", "ring_1", "ring_2", "trinket_1", "trinket_2", "weapon", "off_hand_weapon",
] as const;

// Each player's equipment row (null: they have none). Held under the character's name, kept by its id.
const rows = rowCache<any>("equipment", async (username) => {
    const characterId = await characterIdOf(String(username));
    if (characterId === null) return null;
    const response = await query("SELECT * FROM equipment WHERE character_id = ?", [characterId]) as any[];
    return response[0] ?? null;
}, { perPlayer: true });

const oneAtATime = turns();

function setSlot(username: string, slot: string, item: string | null, write: () => Promise<unknown>) {
    return oneAtATime(username, async () => {
        try {
            await write();
        } catch (error) {
            await rows.drop(username);
            throw error;
        }
        await rows.patch(username, { [slot]: item });
    });
}

const equipment = {
    async list(username: string) {
        if (!username) return null;
        return await rows.get(username);
    },
    async equipItem(username: string, slot: string, item: string | null) {
        if (!username || !slot) return false;
        if (slot !== "helmet" && slot !== "necklace" && slot !== "shoulderguards" && slot !== "cape" && slot !== "chestplate" && slot !== "wristguards" && slot !== "gloves" && slot !== "belt" && slot !== "pants" && slot !== "boots" && slot !== "ring_1" && slot !== "ring_2" && slot !== "trinket_1" && slot !== "trinket_2" && slot !== "weapon" && slot !== "off_hand_weapon") {
            log.error(`Invalid equipment slot: ${slot}`);
            return false;
        }

        try {
            const currentEquipment = await equipment.list(username);
            if (currentEquipment && currentEquipment[slot as keyof Equipment] && item && currentEquipment[slot as keyof Equipment] !== item) {
                await equipment.unEquipItem(username, slot, currentEquipment[slot as keyof Equipment]);
            }
        } catch (error) {
            log.error(`Error checking current equipment for user ${username}: ${error}`);
            return false;
        }

        try {
            const equipmentItems = await assetCache.get("items") as Item[];
            if (item) {
                const itemObj = equipmentItems.find((i) => i.name.toLowerCase() === item.toLowerCase() && i.equipment_slot?.toLowerCase() === slot.toLowerCase());
                if (!itemObj) {
                    log.error(`Item ${item} cannot be equipped in slot ${slot} for user ${username}`);
                    return false;
                }

                await setSlot(username, slot, itemObj.name, () => needCharacterId(username).then((characterId) => query(`UPDATE equipment SET ${slot} = ? WHERE character_id = ?`, [itemObj.name, characterId])));
                await inventory.setEquipped(username, itemObj.name, true);
                return true;
            }
        } catch (error) {
            log.error(`Error equipping item ${item} for user ${username}: ${error}`);
            return false;
        }
    },
    unEquipItem: async (username: string, slot: string, item: string) => {
        if (!username || !slot) return false;
        if (slot !== "helmet" && slot !== "necklace" && slot !== "shoulderguards" && slot !== "cape" && slot !== "chestplate" && slot !== "wristguards" && slot !== "gloves" && slot !== "belt" && slot !== "pants" && slot !== "boots" && slot !== "ring_1" && slot !== "ring_2" && slot !== "trinket_1" && slot !== "trinket_2" && slot !== "weapon" && slot !== "off_hand_weapon") {
            log.error(`Invalid equipment slot: ${slot}`);
            return false;
        }
        try {
            await setSlot(username, slot, null, () => needCharacterId(username).then((characterId) => query(`UPDATE equipment SET ${slot} = NULL WHERE character_id = ?`, [characterId])));
            await inventory.setEquipped(username, item, false);
            return true;
        } catch (error) {
            log.error(`Error unequipping item from slot ${slot} for user ${username}: ${error}`);
            return false;
        }
    }
};

export default equipment;