import bags from "./bags";
import equipment, { EQUIPMENT_SLOTS } from "./equipment";

export async function inUse(username: string, item: string, marked: boolean): Promise<number> {
  const holds = (slot: unknown) => typeof slot === "string" && slot.toLowerCase() === item.toLowerCase();
  const worn = await equipment.list(username);
  const carried = await bags.get(username);
  const counted = EQUIPMENT_SLOTS.filter((slot) => holds(worn?.[slot])).length + bags.SLOTS.filter((slot) => holds(carried?.[slot])).length;
  return Math.max(counted, marked ? 1 : 0);
}
