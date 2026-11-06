import { describe, expect, test } from "bun:test";
import { receiverSource } from "./receiver-source";

// Cluster mode: a notice for a map's players, its admins or the staff who handle reports reaches them on every node of
// the region, not only on the node it was sent from. noticeRegion shows it here and tells the other nodes (peer news
// "notice"), which show it to their own players it names. receiver.ts cannot be imported: these read its source.

const receiver = receiverSource();
const transpiler = new Bun.Transpiler({ loader: "ts" });

function cut(source: string, start: string, until: RegExp): string {
  const at = source.indexOf(start);
  if (at < 0) throw new Error(`Not found in the source: ${start}`);
  const rest = source.slice(at);
  const end = rest.search(until);
  if (end < 0) throw new Error(`No end found for: ${start}`);
  return rest.slice(0, end);
}
const fn = (header: string) => cut(receiver, header, /\n}\r?\n/) + "\n}";
const withNames = (names: string[], code: string): ((given: Record<string, any>) => any) =>
  new Function(`"use strict";\n${transpiler.transformSync(`function make({ ${names.join(", ")} }: any) { ${code} }`)}\nreturn make;`)();

/** Players here: on map "m" an admin, a reports moderator and a player; on map "n" another admin. */
function here() {
  const sent: Record<string, any[]> = { admin: [], mod: [], plain: [], far: [] };
  const players: Record<string, any> = {
    admin: { id: "admin", isAdmin: true, perms: ["admin.*"], map: "m" },
    mod: { id: "mod", isAdmin: false, perms: ["admin.reports"], map: "m" },
    plain: { id: "plain", isAdmin: false, perms: [], map: "m" },
    far: { id: "far", isAdmin: true, perms: ["admin.*"], map: "n" },
  };
  for (const p of Object.values(players)) p.wt = { id: p.id };
  return {
    sent,
    filterPlayersByMap: (map: string) => Object.values(players).filter((p) => p.map === map),
    playerCache: { list: () => players },
    moderation: { can: (p: any, perm: string) => p.perms.includes(perm) || p.perms.includes("admin.*") },
    packetManager: { notify: (data: any) => ({ notify: data.message }) },
    sendPacket: (wt: any, packet: any) => sent[wt.id].push(packet),
  };
}
const who = (sent: Record<string, any[]>) => Object.keys(sent).filter((id) => sent[id].length > 0).sort();

describe("a notice shown here", () => {
  const make = withNames(
    ["filterPlayersByMap", "playerCache", "moderation", "packetManager", "sendPacket"],
    fn("function noticeHere(") + "\nreturn noticeHere;",
  );

  test("to a map's players", () => {
    const world = here();
    make(world)("hello", { map: "m" });
    expect(who(world.sent)).toEqual(["admin", "mod", "plain"]);
    expect(world.sent.plain).toEqual([{ notify: "hello" }]);
  });

  test("to a map's admins", () => {
    const world = here();
    make(world)("hello", { map: "m", admins: true });
    expect(who(world.sent)).toEqual(["admin"]);
  });

  test("to the staff who hold a permission, on any map", () => {
    const world = here();
    make(world)("report", { permission: "admin.reports" });
    expect(who(world.sent)).toEqual(["admin", "far", "mod"]);
  });
});

describe("a notice from another node", () => {
  const install = withNames(["onPeerNews", "noticeHere"], cut(receiver, `onPeerNews("notice",`, /\n}\);\r?\n/) + "\n});");
  function heard() {
    let news: (data: any) => unknown = () => {};
    const shown: any[] = [];
    install({
      onPeerNews: (name: string, run: any) => { if (name === "notice") news = run; },
      noticeHere: (message: string, audience: any) => shown.push({ message, audience }),
    });
    return { news, shown };
  }

  test("is shown to this node's players it names", () => {
    const { news, shown } = heard();
    news({ message: "hi", map: "m", admins: true });
    news({ message: "report", permission: "admin.reports" });
    expect(shown).toEqual([
      { message: "hi", audience: { map: "m", admins: true, permission: undefined } },
      { message: "report", audience: { map: undefined, admins: false, permission: "admin.reports" } },
    ]);
  });

  test("with no message, or an audience of everyone, shows nothing", () => {
    const { news, shown } = heard();
    news({ map: "m" });
    news({ message: "" });
    // Everyone on every node is broadcastWorld's work, not this news.
    news({ message: "all" });
    expect(shown).toEqual([]);
  });
});

describe("what tells the other nodes", () => {
  test("noticeRegion shows it here and tells the region", () => {
    const body = fn("export function noticeRegion(");
    expect(body).toContain("noticeHere(message, audience)");
    expect(body).toContain(`tellPeers("notice", { message, ...audience })`);
  });

  test("/broadcast map and /broadcast admins", () => {
    const command = cut(receiver, `case "BROADCAST": {`, /\n {10}case "MUTE": \{/);
    expect(command).toContain("noticeRegion(message, { map: currentPlayer.location.map })");
    expect(command).toContain("noticeRegion(message, { map: currentPlayer.location.map, admins: true })");
    expect(command).not.toContain("filterPlayersByMap(");
  });

  test("a report filed, for the staff who handle reports", () => {
    const report = fn("export async function sendReport(");
    expect(report).toContain(`noticeRegion(notice, { permission: "admin.reports" })`);
    expect(report).not.toContain("playerCache.list()");
  });
});
