import { describe, expect, test } from "bun:test";
import { receiverSource } from "./receiver-source";

// A player's guild name is drawn over their head for everyone who sees them (client core/player.ts). When it changes,
// the player is sent again to their viewers (broadcastPlayerUpdate), which reaches the viewers of their mirrors on
// other nodes too. A change told to the player's own node as a player action (socket/receiver.ts: a join made from
// another node, such as in the player editor, or a kick) must do the same. receiver.ts cannot be imported: these read
// its source.

const receiver = receiverSource();
const transpiler = new Bun.Transpiler({ loader: "ts" });

function action(name: string) {
  const start = `registerPlayerAction("${name}", `;
  const at = receiver.indexOf(start);
  if (at < 0) throw new Error(`Not found in the source: ${start}`);
  const rest = receiver.slice(at);
  const code = rest.slice(0, rest.search(/\n\}\);/)) + "\n});";
  let run: (p: any, data?: any) => unknown = () => {};
  const shown: any[] = [];
  const given = {
    registerPlayerAction: (_: string, handler: any) => { run = handler; },
    playerCache: { set: () => {} },
    sendPacket: () => {},
    packetManager: { updateGuild: () => [], notify: () => [] },
    broadcastPlayerUpdate: (p: any) => { shown.push({ id: p.id, guild_id: p.guild_id, guild_name: p.guild_name }); },
  };
  const names = Object.keys(given);
  new Function(`"use strict";\n${transpiler.transformSync(`function make({ ${names.join(", ")} }: any) { ${code} }`)}\nreturn make;`)()(given);
  return { run, shown };
}

const member = (over: any = {}) => ({ id: "p", username: "pat", wt: {}, guild_id: null, guild: [], guild_name: null, ...over });

describe("a guild change told to the player's node", () => {
  test("a join is shown to those who see the player, with the new guild name", async () => {
    const a = action("guild-update");
    await a.run(member(), { guildId: 7, members: ["pat", "sam"], guildName: "Frostguard", packet: null });
    expect(a.shown).toEqual([{ id: "p", guild_id: 7, guild_name: "Frostguard" }]);
  });

  test("a new member list of the same guild shows nothing", async () => {
    const a = action("guild-update");
    await a.run(member({ guild_id: 7, guild: ["pat"], guild_name: "Frostguard" }), { guildId: 7, members: ["pat", "sam"], guildName: "Frostguard", packet: null });
    expect(a.shown).toEqual([]);
  });

  test("a kick is shown to those who see the player, without the guild name", async () => {
    const a = action("guild-kicked");
    await a.run(member({ guild_id: 7, guild: ["pat", "sam"], guild_name: "Frostguard" }));
    expect(a.shown).toEqual([{ id: "p", guild_id: null, guild_name: null }]);
  });
});
