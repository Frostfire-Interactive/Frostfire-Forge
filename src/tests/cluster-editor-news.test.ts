import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { receiverSource } from "./receiver-source";

// Cluster mode: a save in an editor tells the other open copies of that editor to ask for the list again, on every
// node of the region (peer news "editor-updated"); the lists themselves are shared. A mailbox editor's save shows the
// map's mailboxes to its players on every node too (peer news "mailboxes"), and so does the achievement editor's nudge
// (peer news "achievement-editor-updated"). socket/handlers/editors.ts cannot be imported: these read its source.

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
const fnOf = (source: string, header: string) => cut(source, header, /\n}\r?\n/) + "\n}";
const fn = (header: string) => fnOf(receiver, header);
const caseOf = (name: string) => cut(receiver, `case "${name}": {`, /\n {8}break;\r?\n {6}\}/);
const withNames = (names: string[], code: string): ((given: Record<string, any>) => any) =>
  new Function(`"use strict";\n${transpiler.transformSync(`function make({ ${names.join(", ")} }: any) { ${code} }`)}\nreturn make;`)();

const KINDS = ["creature", "item", "mount", "cutscene", "spell", "weather", "class", "quest"];

function world() {
  const sent: Record<string, any[]> = { saver: [], builder: [], viewer: [], player: [], closed: [] };
  const players: Record<string, any> = {
    saver: { id: "saver", wt: { id: "saver", readyState: 1 }, editor: true, location: { map: "m.json" } },
    builder: { id: "builder", wt: { id: "builder", readyState: 1 }, editor: true, location: { map: "m" } },
    viewer: { id: "viewer", wt: { id: "viewer", readyState: 1 }, editor: true, location: { map: "n" } },
    player: { id: "player", wt: { id: "player", readyState: 1 }, location: { map: "m" } },
    closed: { id: "closed", wt: { id: "closed", readyState: 3 }, editor: true, location: { map: "n" } },
    gone: { id: "gone" },
  };
  const may = (p: any) => !!p?.editor;
  const editor = { canUseEditor: may, mayHaveEditorOpen: may };
  const packetManager: Record<string, (data: any) => any> = {};
  for (const kind of [...KINDS, "mailbox"]) packetManager[`${kind}EditorUpdated`] = (data: any) => ({ [kind]: data.by });
  return {
    sent,
    playerCache: { list: () => players, get: (id: string) => players[id] },
    sendPacket: (wt: any, packet: any) => sent[wt.id].push(packet),
    sendMailboxes: async (wt: any, map: string) => { sent[wt.id].push({ mailboxes: map }); },
    packetManager,
    creatures: { editorViewerIds: () => ["saver", "viewer", "nobody"] },
    itemEditor: editor, mountEditor: editor, cutsceneEditor: editor, spellEditor: editor,
    weatherEditor: editor, classEditor: editor, questEditor: editor, mailboxEditor: editor,
  };
}
const NAMES = Object.keys(world()).filter((name) => name !== "sent");

describe("the other open editors here", () => {
  const make = withNames(NAMES, `${cut(receiver, "const editorNudges", /\n};\r?\n/)}\n};\n${fn("function editorsUpdatedHere(")}\nreturn { editorsUpdatedHere, kinds: Object.keys(editorNudges) };`);

  test("every editor that tells its other open copies of a save", () => {
    expect(make(world()).kinds).toEqual(KINDS);
  });

  test("are told, but not the saver's, those who may not use it, nor one whose connection closed", () => {
    for (const kind of ["item", "mount", "cutscene", "spell", "weather", "class", "quest"]) {
      const here = world();
      make(here).editorsUpdatedHere(kind, "boss", "saver");
      expect(here.sent).toEqual({ saver: [], builder: [{ [kind]: "boss" }], viewer: [{ [kind]: "boss" }], player: [], closed: kind === "quest" ? [] : [{ [kind]: "boss" }] });
    }
  });

  test("of the creature editor are those that have it open", () => {
    const here = world();
    make(here).editorsUpdatedHere("creature", "boss", "saver");
    expect(here.sent).toEqual({ saver: [], builder: [], viewer: [{ creature: "boss" }], player: [], closed: [] });
  });

  test("from another node, every open editor here is told", () => {
    const here = world();
    make(here).editorsUpdatedHere("item", "boss");
    expect(here.sent.saver).toEqual([{ item: "boss" }]);
  });
});

describe("the mailboxes of a map changed", () => {
  const make = withNames(NAMES, `${fn("async function mailboxesChangedHere(")}\nreturn mailboxesChangedHere;`);

  test("its players here see them, and the other open editors are told", async () => {
    const here = world();
    await make(here)("m", "boss", "saver");
    expect(here.sent).toEqual({
      saver: [{ mailboxes: "m" }],
      builder: [{ mailboxes: "m" }, { mailbox: "boss" }],
      viewer: [{ mailbox: "boss" }],
      player: [{ mailboxes: "m" }],
      closed: [{ mailbox: "boss" }],
    });
  });
});

describe("news from another node", () => {
  function heard() {
    const news: Record<string, (data: any) => unknown> = {};
    const done: any[] = [];
    const given = {
      onPeerNews: (name: string, run: any) => { news[name] = run; },
      editorNudges: Object.fromEntries(KINDS.map((kind) => [kind, {}])),
      editorsUpdatedHere: (...args: any[]) => done.push(["editors", ...args]),
      mailboxesChangedHere: async (...args: any[]) => { done.push(["mailboxes", ...args]); },
    };
    withNames(Object.keys(given), cut(receiver, `onPeerNews("editor-updated",`, /\n}\);\r?\n/) + "\n});")(given);
    withNames(Object.keys(given), cut(receiver, `onPeerNews("mailboxes",`, /\n}\);\r?\n/) + "\n});")(given);
    return { news, done };
  }

  test("is carried out here", async () => {
    const { news, done } = heard();
    await news["editor-updated"]({ kind: "item", by: "boss" });
    await news["editor-updated"]({ kind: "quest" });
    await news.mailboxes({ map: "m", by: "boss" });
    await news.mailboxes({ map: "n" });
    expect(done).toEqual([["editors", "item", "boss"], ["editors", "quest", ""], ["mailboxes", "m", "boss"], ["mailboxes", "n", ""]]);
  });

  test("of an editor there is not, or of no map, is not", async () => {
    const { news, done } = heard();
    await news["editor-updated"]({ kind: "toString", by: "boss" });
    await news["editor-updated"]({ kind: "gathering" });
    await news["editor-updated"](null);
    await news.mailboxes({ by: "boss" });
    await news.mailboxes(null);
    expect(done).toEqual([]);
  });
});

test("each editor's save is told to the region", () => {
  expect(fn("function editorsUpdated(")).toContain(`void tellPeers("editor-updated", { kind, by: admin.username });`);
  const cases: Array<[string, string]> = [
    ["CREATURE_EDITOR_LIST", "creature"], ["ITEM_EDITOR_LIST", "item"], ["MOUNT_EDITOR_LIST", "mount"],
    ["CUTSCENE_EDITOR_LIST", "cutscene"], ["SPELL_EDITOR_LIST", "spell"], ["WEATHER_EDITOR_LIST", "weather"],
    ["CLASS_EDITOR_LIST", "class"],
  ];
  for (const [name, kind] of cases) {
    const body = cut(receiver, `case "${name}":`, /\n {8}break;\r?\n {6}\}/);
    expect(`${name}: ${body.includes(`editorsUpdated("${kind}", currentPlayer)`)}`).toBe(`${name}: true`);
    expect(`${name}: ${body.includes("EditorUpdated(")}`).toBe(`${name}: false`);
  }
  const quest = cut(receiver, 'case "QUEST_EDITOR_SAVE":', /\n {8}break;\r?\n {6}\}/);
  expect(quest).toContain(`editorsUpdated("quest", currentPlayer)`);
  expect(quest).not.toContain("questEditorUpdated(");
  const mailbox = caseOf("MAILBOX_EDITOR_DELETE");
  expect(mailbox).toContain("await mailboxesChangedHere(result.changed, currentPlayer.username, currentPlayer.id);");
  expect(mailbox).toContain(`void tellPeers("mailboxes", { map: result.changed, by: currentPlayer.username });`);
  expect(mailbox).not.toContain("playerCache.list()");
});

describe("the achievement editor", () => {
  const source = readFileSync(new URL("../systems/achievements/index.ts", import.meta.url), "utf8");

  test("tells its other open copies here, and every one when the save was made elsewhere", () => {
    const make = withNames(["playerCache", "packetManager", "send", "editor"], `${fnOf(source, "function achievementEditorsUpdatedHere(")}\nreturn achievementEditorsUpdatedHere;`);
    const sent: Record<string, any[]> = { boss: [], builder: [], player: [] };
    const given = {
      playerCache: { list: () => ({ boss: { id: "boss", wt: { id: "boss" }, editor: true }, builder: { id: "builder", wt: { id: "builder" }, editor: true }, player: { id: "player", wt: { id: "player" } } }) },
      packetManager: { achievementEditorUpdated: (data: any) => ({ updated: data.by }) },
      send: (wt: any, packet: any) => sent[wt.id].push(packet),
      editor: { mayHaveEditorOpen: (p: any) => !!p.editor },
    };
    make(given)("boss", "boss");
    expect(sent).toEqual({ boss: [], builder: [{ updated: "boss" }], player: [] });
    make(given)("boss");
    expect(sent.boss).toEqual([{ updated: "boss" }]);
  });

  test("hears a save made on another node, and tells the region of one made here", async () => {
    const installed = withNames(["onPeerNews", "achievementEditorsUpdatedHere"], cut(source, `onPeerNews("achievement-editor-updated",`, /\n}\);\r?\n/) + "\n});");
    let news: (data: any) => unknown = () => {};
    const told: any[] = [];
    installed({ onPeerNews: (name: string, run: any) => { if (name === "achievement-editor-updated") news = run; }, achievementEditorsUpdatedHere: (...args: any[]) => told.push(args) });
    await news({ by: "boss" });
    await news(null);
    expect(told).toEqual([["boss"], [""]]);
    const handler = fnOf(source, "export async function handleEditorPacket(");
    expect(handler).toContain("achievementEditorsUpdatedHere(admin.username, admin.id);");
    expect(handler).toContain(`void tellPeers("achievement-editor-updated", { by: admin.username });`);
    expect(handler).not.toContain("playerCache.list()");
  });
});
