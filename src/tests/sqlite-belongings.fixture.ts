// Run by sqlite-belongings.test.ts in a process of its own, against a SQLite file made for it: the
// real systems that keep a character's rows (inventory, currency, home, stats, client settings,
// collectables, spells, bags, equipment, quests, cutscene views, achievements) over the real database
// layer, with the tables as src/utility/database_setup_sqlite.ts makes them. Their rows are a
// character's, kept by its id.

import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";
import { atomically } from "../services/batch";
import { clearCaches } from "../services/datacache";
import currency from "../systems/currency";
import homes from "../systems/homes";
import inventory from "../systems/inventory";
import { setupDatabase } from "../utility/database_setup_sqlite";
import player from "../systems/player";
import collectables from "../systems/collectables";
import spells from "../systems/spells";
import bags from "../systems/bags";
import equipment from "../systems/equipment";
import * as questLog from "../systems/quests/log";
import * as objectives from "../systems/quests/objectives";
import { buildIndexes, setCachedQuestsSync, setIndexesForTests } from "../systems/quests/definitions";
import { viewsForTests as views } from "../systems/cutsceneplayer";
import * as achievementStore from "../systems/achievements/store";
import { transaction } from "../controllers/sqldatabase";
import playerCache from "../services/playermanager";

const out: Record<string, unknown> = {};

await setupDatabase();
// Two accounts, each with its character.
for (const name of ["hero", "ally"]) {
  await query("INSERT INTO accounts (email, username, password_hash) VALUES (?, ?, 'x')", [`${name}@example.com`, `${name}_account`]);
  const [account] = (await query("SELECT id FROM accounts WHERE username = ?", [`${name}_account`])) as any[];
  await query("INSERT INTO characters (account_id, name, name_key, created_at) VALUES (?, ?, ?, 1)", [account.id, name, name]);
}
await assetCache.set("items", ["Iron Ore", "Rat's \"Tail\"", "Small Pouch"].map((name) => ({ name, quality: "common", type: "material", description: "", icon: null })));

// Each row named by the character its character_id is.
const held = () => query("SELECT c.name AS owner, i.item, i.quantity, i.slot FROM inventory i JOIN characters c ON c.id = i.character_id ORDER BY i.id");
const purses = () => query("SELECT c.name AS owner, p.copper, p.silver, p.gold FROM currency p JOIN characters c ON c.id = p.character_id ORDER BY c.name");
const tried = (work: Promise<unknown>) => work.then(() => "ran", (error) => String(error?.message ?? error));

// An item the player does not hold yet is an INSERT IGNORE; coins are always an upsert.
out.steps = [
  await tried(inventory.add("hero", { name: "Iron Ore", quantity: 5 })),
  await tried(inventory.add("hero", { name: "iron ore", quantity: 3 })),
  await tried(inventory.add("hero", { name: "Rat's \"Tail\"", quantity: 1 })),
  await tried(inventory.saveSlots("hero", [{ item: "Iron Ore", slot: 4, bag_slot: 0 }])),
  await tried(currency.add("hero", { copper: 50, silver: 2, gold: 1 })),
  await tried(currency.add("hero", { copper: 60, silver: 0, gold: 0 })),
  await tried(currency.remove("hero", { copper: 5, silver: 1, gold: 0 })),
];
out.afterSteps = { held: await held(), purses: await purses() };

// A purchase, as one batch: the coins and the new item are written together.
out.bought = await tried(atomically(["hero"], async (batch) => {
  await currency.remove("hero", { copper: 0, silver: 0, gold: 1 }, batch);
  await inventory.add("hero", { name: "Small Pouch", quantity: 2 }, batch);
}));

// A character's home: every write of it is an upsert on the character's one row.
const inn = (id: number, name: string, map: string, x: number, y: number) => ({ id, name, map, hidden: false, innkeeper: true, position: { x, y, direction: "down" } });
await assetCache.set("npcs", [inn(7, "The Rusty Anchor", "harbor", 400, 300), inn(12, "Leaf Lodge", "forest.json", 100, 100)]);
const at = (username: string, map: string, x: number, y: number) => ({ username, location: { map, position: { x, y } } });
const WENT = 1_700_000_000_000;
out.homeSteps = [
  await tried(homes.set(at("hero", "harbor", 430, 340), inn(7, "", "harbor", 400, 300))),
  await tried(homes.arrive("hero", WENT)),
  await tried(homes.set(at("hero", "forest", 95, 108), inn(12, "", "forest", 100, 100))),
  await tried(homes.arrive("ally", WENT + 500)),
  await tried(homes.set(at("ally", "harbor", 430, 340), inn(7, "", "harbor", 400, 300))),
];
await homes.innGone(7);
out.homes = await query("SELECT c.name AS owner, h.npc_id, h.offset_x, h.offset_y, h.used_at FROM player_home h JOIN characters c ON c.id = h.character_id ORDER BY h.used_at");
// No row a character's system wrote names an account: they are by character_id only.
out.byName = await query("SELECT (SELECT COUNT(*) FROM inventory WHERE username IS NOT NULL) + (SELECT COUNT(*) FROM currency WHERE username IS NOT NULL) + (SELECT COUNT(*) FROM player_home WHERE username IS NOT NULL) AS count");

// What the systems answer, once everything they hold is forgotten, is what the tables hold.
await clearCaches();
out.homeRead = { hero: await homes.where("hero"), ally: await homes.where("ally"), cooldown: await homes.cooldownLeft("hero", WENT + 1000) };
out.read = {
  held: (await inventory.get("hero")).map((row: any) => [row.name, row.quantity]),
  purse: await currency.get("hero"),
};
out.tables = { held: await held(), purses: await purses() };

// ---------------------------------------------------------------- two characters of one account
// "rider" is made as a new player is (player.register: the account, its character, and the character's first rows);
// "rider_alt" is a second character of the same account, given the rows register gives. Each system writes for one
// and then the other, and each character reads back only its own.
const madeRider = await player.register("rider", "hash", "rider@example.com", { ip: "127.0.0.1", headers: {} }, false);
const [riderAccount] = (await query("SELECT id, active_character_id FROM accounts WHERE username = 'rider'")) as any[];
await query("INSERT INTO characters (account_id, name, name_key, created_at) VALUES (?, 'rider_alt', 'rider_alt', 1)", [riderAccount.id]);
const [alt] = (await query("SELECT id FROM characters WHERE name_key = 'rider_alt'")) as any[];
await query("INSERT INTO stats (character_id, health, max_health, stamina, max_stamina, xp, max_xp, level, stat_critical_damage, stat_critical_chance) VALUES (?, 100, 100, 100, 100, 0, 100, 1, 10, 10)", [alt.id]);
await query("INSERT INTO equipment (character_id) VALUES (?)", [alt.id]);
const [rider] = (await query("SELECT id FROM characters WHERE name_key = 'rider'")) as any[];
out.register = { made: madeRider, active: Number(riderAccount.active_character_id) === Number(rider.id), twoCharacters: rider.id !== alt.id };

await assetCache.set("items", [
  ...["Iron Ore", "Rat's \"Tail\"", "Small Pouch"].map((name) => ({ name, quality: "common", type: "material", description: "", icon: null })),
  { name: "Iron Helm", quality: "common", type: "equipment", equipment_slot: "helmet", description: "", icon: null },
]);
const kill = {
  id: 1, name: "Rats", zone: null, offer_text: "", description: "", progress_text: "", completion_text: "", required_level: 1, quest_level: 1,
  xp_reward: 0, copper_reward: 0, repeatable: "none", next_quest_id: null, sort_order: 0, rewards: [], prerequisites: [],
  objectives: [{ id: 11, quest_id: 1, type: "kill", target: "Rat", required_count: 5, target_radius: null, sort_order: 0 }],
} as any;
setCachedQuestsSync([kill]);
setIndexesForTests(buildIndexes([kill], []));
await achievementStore.ensureAchievementSchema();
await query("INSERT INTO achievements (name, type, count) VALUES ('First', 'kill', 1), ('Second', 'kill', 1)");

const CHARACTER_ROW_TABLES = ["stats", "clientconfig", "currency", "collectables", "learned_spells", "bags", "equipment", "quest_log", "quest_objective_progress", "cutscene_views", "player_achievements"];
const owned = async () => ({
  stats: await query("SELECT c.name AS owner, s.health, s.level FROM stats s JOIN characters c ON c.id = s.character_id ORDER BY c.name"),
  collectables: await query("SELECT c.name AS owner, t.type, t.item FROM collectables t JOIN characters c ON c.id = t.character_id ORDER BY c.name, t.item"),
  spells: await query("SELECT c.name AS owner, l.spell FROM learned_spells l JOIN characters c ON c.id = l.character_id ORDER BY c.name, l.spell"),
  bags: await query("SELECT c.name AS owner, b.slot_1 FROM bags b JOIN characters c ON c.id = b.character_id ORDER BY c.name"),
  equipment: await query("SELECT c.name AS owner, e.helmet FROM equipment e JOIN characters c ON c.id = e.character_id ORDER BY c.name"),
  questLog: await query("SELECT c.name AS owner, q.quest_id, q.state FROM quest_log q JOIN characters c ON c.id = q.character_id ORDER BY c.name"),
  questProgress: await query("SELECT c.name AS owner, p.quest_id, p.objective_id, p.count FROM quest_objective_progress p JOIN characters c ON c.id = p.character_id ORDER BY c.name"),
  views: await query("SELECT c.name AS owner, v.cutscene FROM cutscene_views v JOIN characters c ON c.id = v.character_id ORDER BY c.name"),
  achievements: await query("SELECT c.name AS owner, a.achievement_id, a.progress, a.completed_at IS NOT NULL AS done FROM player_achievements a JOIN characters c ON c.id = a.character_id ORDER BY c.name, a.achievement_id"),
});

/** markSeen writes once the id is found, without waiting: waits for `count` rows. */
const viewsWritten = async (count: number) => {
  for (let i = 0; i < 100; i++) {
    const [{ n }] = (await query("SELECT COUNT(*) AS n FROM cutscene_views")) as any[];
    if (Number(n) >= count) return;
    await Bun.sleep(10);
  }
  throw new Error(`fewer than ${count} cutscene views were written`);
};
// A quest log is an online player's: both are online for the quest steps (with no id carried, so it is looked up).
playerCache.set("session-rider", { id: "session-rider", username: "rider" });
playerCache.set("session-rider-alt", { id: "session-rider-alt", username: "rider_alt" });
const accepted = (result: any) => { if (!result?.ok) throw new Error(result?.error ?? "not accepted"); };

out.perCharacterSteps = {
  stats: [
    await tried(player.setStats("rider", { health: 50, max_health: 100, stamina: 90, max_stamina: 100, xp: 10, max_xp: 100, level: 2, stat_critical_damage: 10, stat_critical_chance: 10, stat_armor: 0, stat_damage: 0, stat_avoidance: 0 } as any)),
    await tried(player.increaseLevel("rider_alt")),
  ],
  collectables: [
    await tried(collectables.add({ type: "mount", item: "horse", username: "rider_alt" } as any)),
    await tried(collectables.remove({ type: "mount", item: "unicorn", username: "rider" } as any)),
  ],
  spells: [await tried(spells.learnSpell("rider_alt", "fire_ball")), await tried(spells.unlearnSpell("rider", "frost_bolt"))],
  bags: [await tried(bags.setBag("rider", "slot_1", "Small Pouch")), await tried(bags.ensure("rider_alt"))],
  equipment: [await tried(inventory.add("rider", { name: "Iron Helm", quantity: 1 })), await tried(equipment.equipItem("rider", "helmet", "Iron Helm"))],
  quests: [
    await tried(questLog.forceAccept("rider", 1).then(accepted)),
    await tried(questLog.forceAccept("rider_alt", 1).then(accepted)),
    // The first count is an INSERT, the next an UPDATE of the character's row.
    await tried(objectives.credit("rider", "kill", "Rat", 2)),
    await tried(objectives.credit("rider", "kill", "Rat", 1)),
    await tried(objectives.credit("rider_alt", "kill", "Rat", 4)),
  ],
  views: [
    await tried((async () => { await views.seenBy("rider"); views.markSeen("rider", "Intro"); await viewsWritten(1); views.markSeen("rider", "Intro"); })()),
    await tried((async () => { views.markSeen("rider_alt", "Outro"); await viewsWritten(2); })()),
  ],
  achievements: [
    await tried((async () => { achievementStore.markChanged("rider", 1, 1); await achievementStore.flush("rider"); })()),
    // The upsert on (character_id, achievement_id): the row is there, so it is raised in place.
    await tried((async () => {
      achievementStore.markChanged("rider", 2, 1);
      await achievementStore.flush("rider");
      achievementStore.markChanged("rider", 2, 3);
      await achievementStore.flush("rider");
    })()),
    await tried((async () => { achievementStore.markChanged("rider_alt", 2, 7); await achievementStore.flush("rider_alt"); })()),
    await tried((async () => { await transaction(await achievementStore.completionStatements("rider", 1, 1, 1_700_000_000_000)); })()),
  ],
};
playerCache.remove("session-rider");
playerCache.remove("session-rider-alt");
// Let a second markSeen of a scene seen already (an INSERT IGNORE) land before the tables are read.
await Bun.sleep(50);
out.perCharacter = await owned();

// What each character's systems answer once everything held is forgotten.
await clearCaches();
achievementStore.resetChanges();
views.forgetUser("rider");
views.forgetUser("rider_alt");
const both = async <T>(read: (u: string) => Promise<T>) => ({ rider: await read("rider"), rider_alt: await read("rider_alt") });
out.perCharacterRead = {
  stats: await both(async (u) => { const st: any = await player.getStats(u); return { health: st?.health, level: st?.level }; }),
  collectables: await both(async (u) => ((await collectables.list(u)) as any[]).map((row) => row.item).sort()),
  spells: await both(async (u) => (await spells.listLearned(u)).sort()),
  bags: await both(async (u) => ((await bags.get(u)) as any)?.slot_1 ?? null),
  equipment: await both(async (u) => ((await equipment.list(u)) as any)?.helmet ?? null),
  quests: await both(async (u) => (await questLog.rowsOf(u)).progress.map((row: any) => [row.quest_id, row.objective_id, row.count])),
  views: await both(async (u) => [...((await views.seenBy(u)) ?? [])]),
  achievements: await both(async (u) => (await achievementStore.rowsOf(u)).map((row) => [row.achievement_id, row.progress, row.completed_at !== null])),
};
const countWhere = (where: string) => query(`SELECT ${CHARACTER_ROW_TABLES.map((table) => `(SELECT COUNT(*) FROM ${table} WHERE ${where})`).join(" + ")} AS count`);
out.perCharacterByName = await countWhere("username IS NOT NULL");
out.perCharacterNoOwner = await countWhere("character_id IS NULL");

console.log("RESULT " + JSON.stringify(out));
process.exit(0);
