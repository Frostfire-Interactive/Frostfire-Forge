import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { characterDatabaseModule as databaseModule } from "./setup";
import { receiverSource } from "./receiver-source";
import { applyPartyMembers, clearParty } from "../socket/partystate";

type Row = Record<string, any>;
let partiesTable: Row[];
let accountsTable: Row[];
let nextPartyId: number;
/** Every statement sent, with its values, in order. */
let queries: Array<[string, any[]]>;
/** A statement matching this is not answered: the connection is lost. */
let failing: RegExp | null;
/** The statement that was not answered was still made, as one that timed out can have been. Otherwise it was refused. */
let lostAfterWriting: boolean;
/** Whether an INSERT reports the id it gave the row. */
let reportsInsertId: boolean;

const LOAD = "SELECT id, leader, members, raid FROM parties";

const accountOf = (username: string) => accountsTable.find((row) => row.username === String(username).toLowerCase());

async function database(sql: string, params: any[] = []): Promise<any> {
  queries.push([sql, params]);
  const lost = !!failing?.test(sql);
  if (lost && !lostAfterWriting) throw new Error("connection lost");
  const answer = run(sql, params);
  if (lost) throw new Error("connection lost");
  return answer;
}

function run(sql: string, params: any[]): any {
  switch (sql) {
    case LOAD:
      return partiesTable.map((row) => ({ ...row }));
    // The leader is the character (character_id and leader_id), handed here by name.
    case "INSERT INTO parties (leader, members, username, leader_id) VALUES (?, ?, ?, ?)": {
      const [leader, members] = params;
      const id = nextPartyId++;
      partiesTable.push({ id, leader, members });
      return reportsInsertId ? { lastInsertRowid: id, affectedRows: 1 } : { affectedRows: 1 };
    }
    case "UPDATE parties SET members = ? WHERE id = ?": {
      const [members, id] = params;
      for (const row of partiesTable) if (row.id === id) row.members = members;
      return { affectedRows: 1 };
    }
    case "UPDATE parties SET members = ? WHERE id = ? AND members = ?": {
      const [members, id, was] = params;
      let changed = 0;
      for (const row of partiesTable) if (row.id === id && row.members === was) { row.members = members; changed++; }
      return { affectedRows: changed };
    }
    case "UPDATE parties SET raid = 1 WHERE id = ?":
      for (const row of partiesTable) if (row.id === params[0]) row.raid = 1;
      return { affectedRows: 1 };
    case "UPDATE parties SET leader = ?, leader_id = ?, members = ? WHERE id = ?": {
      const [leader, , members, id] = params;
      for (const row of partiesTable) if (row.id === id) { row.leader = leader; row.members = members; }
      return { affectedRows: 1 };
    }
    case "DELETE FROM parties WHERE id = ?":
      partiesTable = partiesTable.filter((row) => row.id !== params[0]);
      return { affectedRows: 1 };
    case "UPDATE accounts SET party_id = ? WHERE username = ?": {
      const row = accountOf(params[1]);
      if (row) row.party_id = params[0];
      return { affectedRows: 1 };
    }
    case "UPDATE accounts SET party_id = ? WHERE username IN (?, ?)": {
      const [id, ...usernames] = params;
      for (const username of usernames) {
        const row = accountOf(username);
        if (row) row.party_id = id;
      }
      return { affectedRows: usernames.length };
    }
    case "UPDATE accounts SET party_id = NULL WHERE username = ?": {
      const row = accountOf(params[0]);
      if (row) row.party_id = null;
      return { affectedRows: 1 };
    }
    case "UPDATE accounts SET party_id = NULL WHERE party_id = ?":
      for (const row of accountsTable) if (row.party_id === params[0]) row.party_id = null;
      return { affectedRows: 1 };
  }
  throw new Error(`The fake database does not understand: ${sql}`);
}

mock.module("../controllers/sqldatabase", () => databaseModule({ default: database }));

const datacache = await import("../services/datacache");
const { default: log } = await import("../modules/logger");
const { default: parties } = await import("../systems/parties");
const { capital, joinOutcome, newLeaderNotice } = await import("../systems/partyrules");

const reads = () => queries.map(([sql]) => sql).filter((sql) => sql.startsWith("SELECT"));
const writes = () => queries.filter(([sql]) => !sql.startsWith("SELECT"));
/** The accounts another system caches, that it was told to read again. */
const accountsDropped = () => dropRows.mock.calls.filter(([name]: any[]) => name === "accounts").map(([, key]: any[]) => key);
const partyIdOf = (username: string) => accountOf(username)?.party_id ?? null;
/** The parties the fake database holds, as `getAllParties` answers them. */
const inDatabase = () => partiesTable.map((row) => ({
  id: row.id,
  leader: row.leader,
  members: String(row.members ?? "").split(",").map((member) => member.trim()).filter(Boolean),
}));

let dropRows: ReturnType<typeof spyOn>;
let logged: Array<ReturnType<typeof spyOn>>;
beforeAll(() => {
  dropRows = spyOn(datacache, "dropRows");
  logged = [spyOn(log, "info"), spyOn(log, "warn"), spyOn(log, "error")].map((spy) => spy.mockImplementation(() => {}));
});
afterAll(() => {
  dropRows.mockRestore();
  for (const spy of logged) spy.mockRestore();
});

beforeEach(async () => {
  partiesTable = [
    { id: 1, leader: "user1", members: "user1, user2" },
    { id: 2, leader: "user4", members: "user4, user5, user6" },
  ];
  accountsTable = [
    { username: "user1", party_id: 1 },
    { username: "user2", party_id: 1 },
    { username: "user3", party_id: null },
    { username: "user4", party_id: 2 },
    { username: "user5", party_id: 2 },
    { username: "user6", party_id: 2 },
    { username: "user7", party_id: null },
  ];
  nextPartyId = 3;
  queries = [];
  failing = null;
  lostAfterWriting = false;
  reportsInsertId = true;
  await datacache.clearCaches();
  dropRows.mockClear();
});

// ------------------------------------------------- one read of the table

const questions: Array<[string, () => Promise<unknown>, unknown]> = [
  ["isInParty", () => parties.isInParty("user2"), true],
  ["isPartyLeader", () => parties.isPartyLeader("user1"), true],
  ["getPartyId", () => parties.getPartyId("user2"), 1],
  ["getPartyMembers", () => parties.getPartyMembers(1), ["user1", "user2"]],
  ["getPartyLeader", () => parties.getPartyLeader(1), "user1"],
  ["exists", () => parties.exists("user5"), true],
  ["getAllParties", () => parties.getAllParties(), [
    { id: 1, leader: "user1", members: ["user1", "user2"] },
    { id: 2, leader: "user4", members: ["user4", "user5", "user6"] },
  ]],
];

describe("a party question is answered from the table, read once", () => {
  test.each(questions)("%s: asked again, the database is not", async (_name, ask, answer) => {
    expect(await ask()).toEqual(answer);
    expect(await ask()).toEqual(answer);
    expect(queries).toEqual([[LOAD, []]]);
  });

  test("every question together costs that one read", async () => {
    for (const [, ask, answer] of questions) expect(await ask()).toEqual(answer);
    expect(queries).toEqual([[LOAD, []]]);
  });

  test("names match in any case, as the database matched them", async () => {
    expect(await parties.isInParty("USER2")).toBe(true);
    expect(await parties.getPartyId("User5")).toBe(2);
    expect(await parties.isPartyLeader("USER4")).toBe(true);
  });

  test("who is in a party is who its member list names", async () => {
    // An account pointing at a party that does not list it, and a list naming an account that points nowhere.
    accountOf("user3")!.party_id = 1;
    accountOf("user2")!.party_id = null;
    expect(await parties.isInParty("user3")).toBe(false);
    expect(await parties.getPartyId("user3")).toBeNull();
    expect(await parties.isInParty("user2")).toBe(true);
    expect(await parties.getPartyId("user2")).toBe(1);
    // Someone no list names, and someone the database has never heard of.
    expect(await parties.isInParty("user7")).toBe(false);
    expect(await parties.exists("nobody")).toBe(false);
    expect(await parties.isInParty("")).toBe(false);
    expect(await parties.getPartyId("")).toBeNull();
  });

  test("a member list is read as it is stored: trimmed, without blanks", async () => {
    partiesTable[0].members = " user1 ,user2,, ";
    partiesTable[1].members = null;
    expect(await parties.getPartyMembers(1)).toEqual(["user1", "user2"]);
    expect(await parties.getPartyMembers(2)).toEqual([]);
    expect((await parties.getAllParties()).map((party) => party.members)).toEqual([["user1", "user2"], []]);
    expect(await parties.isInParty("user5")).toBe(false);
  });

  test("a party that is not there has no leader or members", async () => {
    expect(await parties.getPartyLeader(9)).toBeNull();
    expect(await parties.getPartyMembers(9)).toEqual([]);
    expect(await parties.getPartyLeader(0)).toBeNull();
    // An id that arrived as text finds the same party.
    expect(await parties.getPartyLeader("2" as any)).toBe("user4");
    expect(queries).toEqual([[LOAD, []]]);
  });

  test("an answer is a copy: changing it changes nothing held", async () => {
    (await parties.getPartyMembers(1)).push("intruder");
    const all = await parties.getAllParties();
    all[0].leader = "intruder";
    all[0].members.length = 0;
    expect(await parties.getPartyMembers(1)).toEqual(["user1", "user2"]);
    expect(await parties.getAllParties()).toEqual(questions[6][2] as any);
  });

  test("no parties at all is an empty list, not asked for twice", async () => {
    partiesTable = [];
    expect(await parties.getAllParties()).toEqual([]);
    expect(await parties.isInParty("user1")).toBe(false);
    expect(await parties.isPartyLeader("user1")).toBe(false);
    expect(queries).toEqual([[LOAD, []]]);
  });
});

// ------------------------------------------- changes: database, then table

describe("a party change is written to the database, then to the table held", () => {
  test("create makes the party with its leader first", async () => {
    expect(await parties.create("user3", "user7")).toEqual(["user3", "user7"]);
    expect(writes()).toEqual([
      ["INSERT INTO parties (leader, members, username, leader_id) VALUES (?, ?, ?, ?)", ["user3", "user3, user7", "user3", "user3"]],
      ["UPDATE accounts SET party_id = ? WHERE username IN (?, ?)", [3, "user3", "user7"]],
    ]);
    expect(accountsDropped().sort()).toEqual(["user3", "user7"]);

    expect(await parties.getPartyId("user7")).toBe(3);
    expect(await parties.getPartyLeader(3)).toBe("user3");
    expect(await parties.getPartyMembers(3)).toEqual(["user3", "user7"]);
    expect(await parties.isPartyLeader("user3")).toBe(true);
    expect((await parties.getAllParties()).map((party) => party.id)).toEqual([1, 2, 3]);
    expect(reads()).toEqual([LOAD]);
  });

  test("create is refused to a leader already in a party, with nothing written", async () => {
    expect(await parties.create("user2", "user3")).toBe(false);
    expect(await parties.create("", "user3")).toBe(false);
    expect(await parties.create("user3", "")).toBe(false);
    expect(writes()).toEqual([]);
  });

  test("create is refused when the second player is already in a party: nobody is on two lists", async () => {
    expect(await parties.create("user3", "user2")).toBe(false);
    expect(await parties.create("user3", "USER5")).toBe(false);
    expect(writes()).toEqual([]);
    expect(partyIdOf("user2")).toBe(1);
    expect(await parties.getPartyId("user2")).toBe(1);
    expect(await parties.isInParty("user3")).toBe(false);
    expect(await parties.getAllParties()).toEqual(inDatabase());
  });

  test("create reads the table again when the database does not say which id it gave", async () => {
    reportsInsertId = false;
    expect(await parties.create("user3", "user7")).toEqual(["user3", "user7"]);
    expect(await parties.getPartyId("user7")).toBe(3);
    expect(await parties.getPartyLeader(3)).toBe("user3");
    expect(reads()).toEqual([LOAD, LOAD]);
  });

  test("add puts the account and the member list in step", async () => {
    expect(await parties.add("user3", 1)).toEqual(["user1", "user2", "user3"]);
    expect(writes()).toEqual([
      ["UPDATE parties SET members = ? WHERE id = ? AND members = ?", ["user1, user2, user3", 1, "user1, user2"]],
      ["UPDATE accounts SET party_id = ? WHERE username = ?", [1, "user3"]],
    ]);
    expect(accountsDropped()).toEqual(["user3"]);

    expect(await parties.getPartyMembers(1)).toEqual(["user1", "user2", "user3"]);
    expect(await parties.getPartyId("user3")).toBe(1);
    expect(await parties.isInParty("user3")).toBe(true);
    expect(reads()).toEqual([LOAD]);
  });

  test("two joining at once are both on the list", async () => {
    expect((await Promise.all([parties.add("user3", 1), parties.add("user7", 1)])).map((list) => list.length).sort()).toEqual([3, 4]);
    expect(inDatabase().find((party) => party.id === 1)!.members.sort()).toEqual(["user1", "user2", "user3", "user7"]);
    expect(partyIdOf("user3")).toBe(1);
    expect(partyIdOf("user7")).toBe(1);
  });

  test("a join after the list changed elsewhere reads it again, and is refused once the party is full", async () => {
    await parties.getPartyMembers(1);
    // Another node fills the party behind this one's back.
    partiesTable[0].members = "user1, user2, user8, user9, user10";
    expect(await parties.add("user3", 1)).toEqual([]);
    expect(partiesTable[0].members).toBe("user1, user2, user8, user9, user10");
    expect(partyIdOf("user3")).not.toBe(1);
  });

  test("add refuses a member of any party, a full party and a party that is not there", async () => {
    expect(await parties.add("user5", 1)).toEqual([]);
    expect(await parties.add("USER5", 1)).toEqual([]);
    expect(await parties.add("user3", 9)).toEqual([]);
    expect(await parties.add("", 1)).toEqual([]);
    partiesTable[1].members = "user4, user5, user6, user8, user9";
    await datacache.clearCaches();
    expect(await parties.add("user3", 2)).toEqual([]);
    expect(writes()).toEqual([]);
  });

  test("remove takes the member off the list, and those left are still a party", async () => {
    expect(await parties.remove("user6")).toEqual(["user4", "user5"]);
    expect(writes()).toEqual([
      ["UPDATE accounts SET party_id = NULL WHERE username = ?", ["user6"]],
      ["UPDATE parties SET members = ? WHERE id = ?", ["user4, user5", 2]],
    ]);
    expect(accountsDropped()).toEqual(["user6"]);

    expect(await parties.isInParty("user6")).toBe(false);
    expect(await parties.getPartyId("user5")).toBe(2);
    expect(await parties.getPartyLeader(2)).toBe("user4");
    expect(await parties.getPartyMembers(2)).toEqual(["user4", "user5"]);
    expect(partyIdOf("user4")).toBe(2);
    expect(await parties.getAllParties()).toEqual(inDatabase());
    expect(reads()).toEqual([LOAD]);
  });

  test("remove finds the member whatever case the name came in, as the account was found", async () => {
    expect(await parties.remove("USER6")).toEqual(["user4", "user5"]);
    expect(partiesTable[1].members).toBe("user4, user5");
    expect(await parties.isInParty("user6")).toBe(false);
  });

  test("remove ends the party when one member would be left", async () => {
    expect(await parties.remove("user2")).toBe(true);
    expect(writes()).toEqual([
      ["UPDATE accounts SET party_id = NULL WHERE username = ?", ["user2"]],
      ["UPDATE parties SET members = ? WHERE id = ?", ["user1", 1]],
      ["DELETE FROM parties WHERE id = ?", [1]],
      ["UPDATE accounts SET party_id = NULL WHERE party_id = ?", [1]],
    ]);
    expect([...new Set(accountsDropped())].sort()).toEqual(["user1", "user2"]);

    expect(await parties.isInParty("user1")).toBe(false);
    expect(await parties.isPartyLeader("user1")).toBe(false);
    expect((await parties.getAllParties()).map((party) => party.id)).toEqual([2]);
    expect(reads()).toEqual([LOAD]);
  });

  // Three or more: the next member leads. Two: one alone is no party, and it ends.
  test("remove of the leader passes the lead on when three or more were in the party", async () => {
    expect(await parties.remove("user4")).toEqual(["user5", "user6"]);
    expect(await parties.getPartyLeader(2)).toBe("user5");
    expect(await parties.getPartyMembers(2)).toEqual(["user5", "user6"]);
    expect(partiesTable[1]).toMatchObject({ leader: "user5", members: "user5, user6" });
    expect(partyIdOf("user4")).toBeNull();
    expect([partyIdOf("user5"), partyIdOf("user6")]).toEqual([2, 2]);
    expect(await parties.getAllParties()).toEqual(inDatabase());
  });

  test("remove of the leader ends a party of two", async () => {
    expect(await parties.remove("user1")).toBe(true);
    expect(await parties.getAllParties()).toEqual([{ id: 2, leader: "user4", members: ["user4", "user5", "user6"] }]);
    expect(await parties.getAllParties()).toEqual(inDatabase());
    expect([partyIdOf("user1"), partyIdOf("user2")]).toEqual([null, null]);
  });

  test("leave by the leader of three writes the new leader and the members in one UPDATE and keeps the party", async () => {
    expect(await parties.leave("user4")).toEqual(["user5", "user6"]);
    const leaderWrites = writes().filter(([sql]) => sql.startsWith("UPDATE parties SET leader"));
    expect(leaderWrites).toEqual([["UPDATE parties SET leader = ?, leader_id = ?, members = ? WHERE id = ?", ["user5", expect.anything(), "user5, user6", 2]]]);
    expect(writes().some(([sql]) => sql.startsWith("DELETE"))).toBe(false);
    expect(await parties.getPartyId("user6")).toBe(2);
  });

  test("add refuses a sixth member unless the party is a raid, and the twenty-first always", async () => {
    partiesTable[1].members = "user4, user5, user6, user8, user9";
    await datacache.clearCaches();
    expect(await parties.isRaid(2)).toBe(false);
    expect(await parties.add("user3", 2)).toEqual([]);
    await parties.setRaid(2);
    expect(writes()).toContainEqual(["UPDATE parties SET raid = 1 WHERE id = ?", [2]]);
    expect(await parties.isRaid(2)).toBe(true);
    expect(await parties.add("user3", 2)).toEqual(["user4", "user5", "user6", "user8", "user9", "user3"]);

    partiesTable[1].members = Array.from({ length: 20 }, (_, i) => `m${i}`).join(", ");
    await datacache.clearCaches();
    expect(await parties.isRaid(2)).toBe(true);
    expect(await parties.add("user7", 2)).toEqual([]);
  });

  test("remove of someone in no party writes nothing", async () => {
    expect(await parties.remove("user3")).toEqual([]);
    expect(writes()).toEqual([]);
  });

  test("remove whose party the database refuses to delete holds what the database holds", async () => {
    failing = /^DELETE FROM parties/;
    expect(await parties.remove("user2")).toBe(true);
    failing = null;
    expect(partiesTable[0]).toEqual({ id: 1, leader: "user1", members: "user1" });
    expect(await parties.getAllParties()).toEqual(inDatabase());
    expect(await parties.isInParty("user2")).toBe(false);
    expect(reads()).toEqual([LOAD, LOAD]);
  });

  test("delete takes the party out and frees its members' accounts", async () => {
    expect(await parties.delete(1)).toBe(true);
    expect(writes()).toEqual([
      ["DELETE FROM parties WHERE id = ?", [1]],
      ["UPDATE accounts SET party_id = NULL WHERE party_id = ?", [1]],
    ]);
    expect(accountsDropped().sort()).toEqual(["user1", "user2"]);

    expect(await parties.getPartyLeader(1)).toBeNull();
    expect(await parties.isInParty("user2")).toBe(false);
    expect(await parties.isPartyLeader("user1")).toBe(false);
    expect((await parties.getAllParties()).map((party) => party.id)).toEqual([2]);
    expect(reads()).toEqual([LOAD]);
  });

  test("leave by the leader ends the party; by a member it is a removal", async () => {
    expect(await parties.leave("user3")).toBe(false);
    expect(writes()).toEqual([]);

    expect(await parties.leave("user1")).toBe(true);
    expect(writes()).toEqual([
      ["DELETE FROM parties WHERE id = ?", [1]],
      ["UPDATE accounts SET party_id = NULL WHERE party_id = ?", [1]],
    ]);
    expect(await parties.isInParty("user2")).toBe(false);

    // Three were in it: the two left are still a party.
    queries = [];
    expect(await parties.leave("user5")).toEqual(["user4", "user6"]);
    expect(writes()).toEqual([
      ["UPDATE accounts SET party_id = NULL WHERE username = ?", ["user5"]],
      ["UPDATE parties SET members = ? WHERE id = ?", ["user4, user6", 2]],
    ]);
    expect(await parties.getPartyMembers(2)).toEqual(["user4", "user6"]);

    // Two were in it: one alone is no party.
    queries = [];
    expect(await parties.leave("user6")).toBe(true);
    expect(writes().map(([sql]) => sql)).toEqual([
      "UPDATE accounts SET party_id = NULL WHERE username = ?",
      "UPDATE parties SET members = ? WHERE id = ?",
      "DELETE FROM parties WHERE id = ?",
      "UPDATE accounts SET party_id = NULL WHERE party_id = ?",
    ]);
    expect(await parties.getAllParties()).toEqual([]);
    expect(reads()).toEqual([]);
  });

  test("disband by the leader ends the party", async () => {
    expect(await parties.disband("user4")).toBe(true);
    expect(writes()).toEqual([
      ["UPDATE accounts SET party_id = NULL WHERE party_id = ?", [2]],
      ["DELETE FROM parties WHERE id = ?", [2]],
      ["UPDATE accounts SET party_id = NULL WHERE party_id = ?", [2]],
    ]);
    expect([...new Set(accountsDropped())].sort()).toEqual(["user4", "user5", "user6"]);

    expect(await parties.isInParty("user5")).toBe(false);
    expect(await parties.isPartyLeader("user4")).toBe(false);
    expect(await parties.getPartyMembers(2)).toEqual([]);
    expect(reads()).toEqual([LOAD]);
  });

  test("disband is refused to a member who does not lead, and to someone in no party", async () => {
    expect(await parties.disband("user5")).toBe(false);
    expect(await parties.disband("user3")).toBe(false);
    expect(writes()).toEqual([]);
  });

});

// --------------------------------- a write the database does not answer

const unanswered: Array<[string, RegExp, () => Promise<unknown>, unknown, string[]]> = [
  ["create (the party)", /^INSERT INTO parties/, () => parties.create("user3", "user7"), false, []],
  ["create (the accounts)", /^UPDATE accounts/, () => parties.create("user3", "user7"), false, ["user3", "user7"]],
  ["add (the account)", /^UPDATE accounts/, () => parties.add("user3", 1), [], ["user3"]],
  // The list is written first: the account is not touched when that fails.
  ["add (the member list)", /^UPDATE parties/, () => parties.add("user3", 1), [], []],
  ["remove (the account)", /^UPDATE accounts/, () => parties.remove("user6"), [], ["user6"]],
  ["remove (the member list)", /^UPDATE parties/, () => parties.remove("user6"), [], ["user6"]],
  ["delete (the party)", /^DELETE FROM parties/, () => parties.delete(1), false, []],
  ["delete (the accounts)", /^UPDATE accounts/, () => parties.delete(1), false, ["user1", "user2"]],
  ["leave by the leader", /^DELETE FROM parties/, () => parties.leave("user1"), false, []],
  ["leave by a member", /^UPDATE parties/, () => parties.leave("user5"), [], ["user5"]],
  ["disband (the accounts)", /^UPDATE accounts/, () => parties.disband("user4"), false, ["user4", "user5", "user6"]],
  ["disband (the party)", /^DELETE FROM parties/, () => parties.disband("user4"), false, ["user4", "user5", "user6"]],
];

for (const made of [false, true]) {
  describe(`a party write the database ${made ? "made but never answered" : "refused"}`, () => {
    test.each(unanswered)("%s: the table is read again, so what is held is what the database holds", async (_name, statement, write, answer, accounts) => {
      await parties.getAllParties();
      lostAfterWriting = made;
      failing = statement;
      expect(await write()).toEqual(answer);
      failing = null;

      expect(reads()).toEqual([LOAD, LOAD]);
      expect([...new Set(accountsDropped())].sort()).toEqual(accounts);
      expect(await parties.getAllParties()).toEqual(inDatabase());
      expect(reads()).toEqual([LOAD, LOAD]);
    });
  });
}

test("a write that was made but never answered is what the next read answers", async () => {
  await parties.getAllParties();
  lostAfterWriting = true;

  failing = /^UPDATE parties/;
  expect(await parties.add("user3", 1)).toEqual([]);
  expect(await parties.getPartyMembers(1)).toEqual(["user1", "user2", "user3"]);
  expect(await parties.getPartyId("user3")).toBe(1);

  failing = /^DELETE FROM parties/;
  expect(await parties.delete(2)).toBe(false);
  expect(await parties.getPartyLeader(2)).toBeNull();
  expect(await parties.isInParty("user5")).toBe(false);

  failing = /^INSERT INTO parties/;
  expect(await parties.create("user7", "user4")).toBe(false);
  expect(await parties.getPartyId("user7")).toBe(3);
  expect(await parties.getPartyLeader(3)).toBe("user7");
});

test("when the table cannot be read again either, the write still answers that it failed", async () => {
  await parties.getAllParties();
  failing = /^UPDATE parties|^SELECT/;
  expect(await parties.add("user3", 1)).toEqual([]);
  failing = null;
  expect(reads()).toEqual([LOAD, LOAD]);
});

const receiver = receiverSource();
const transpiler = new Bun.Transpiler({ loader: "ts" });

/** `source` from where `from` starts up to the first match of `until` after it. */
function cut(source: string, from: string, until: RegExp): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`Not found in the source: ${from}`);
  const rest = source.slice(start);
  const end = rest.search(until);
  if (end < 0) throw new Error(`No end found for: ${from}`);
  return rest.slice(0, end);
}

const caseNames = [
  "type", "data", "response", "inviterName", "currentPlayer", "wt", "parties", "player", "playerCache", "sendPacket", "packetManager",
  "listener", "Events", "syncPartyLayers", "sendAnimationTo", "queueSpawnPlayerPacket", "getAnimationNameForDirection",
  "getPlayerSpriteSheetData", "getMountSpriteUrl", "spellEffects", "queueSpawnForReceivers", "runOnPlayer", "deliverToPlayer", "greetContacts", "clusterEnabled", "partyViewChanged", "joinOutcome", "offerRaidConvert", "announceJoin", "clearParty",
  "invite", "isOnline", "capital", "newLeaderNotice",
];

/** One of the receiver's player actions (registerPlayerAction at module level), as a function of the names it uses. */
function receiverAction(name: string): (given: Row) => (member: any, args: any) => void {
  const from = `registerPlayerAction("${name}", `;
  const action = cut(receiver, from, /\r?\n\}\);\r?\n/).slice(from.length);
  return new Function(`"use strict";\n${transpiler.transformSync(`function make({ sendPacket, packetManager, playerCache, clusterEnabled, clearParty, trackPacket, applyPartyMembers, cacheIfHeld, parties, partyViewChanged }: any) { return ${action}\n}; }`)}\nreturn make;`)();
}

/** The module's announceJoin, as a function of the names it uses: the one copy of what follows a join. */
function announceJoinWith(given: Row): (...args: any[]) => Promise<void> {
  const from = "async function announceJoin(";
  const body = cut(receiver, from, /\r?\n\}\r?\n/) + "\n}";
  const names = "deliverToPlayer, packetManager, parties, runOnPlayer, player, playerCache, greetContacts, syncPartyLayers, sendAnimationTo, queueSpawnPlayerPacket, getAnimationNameForDirection, getPlayerSpriteSheetData, getMountSpriteUrl, spellEffects, queueSpawnForReceivers, capital";
  return new Function(`"use strict";
${transpiler.transformSync(`function make({ ${names} }: any) { return ${body}; }`)}
return make;`)()(given);
}

const partyActions: Record<string, ReturnType<typeof receiverAction>> = {
  "party-cleared": receiverAction("party-cleared"),
  "party-update": receiverAction("party-update"),
};

/** One `case` of a switch in the receiver, indented by `indent`, as a function of the names it uses. */
function receiverCase(name: string, indent: number): (given: Row) => Promise<void> {
  const body = cut(receiver, `\n${" ".repeat(indent)}case "${name}": {`, new RegExp(`\\r?\\n {${indent}}}\\r?\\n`));
  const code = `return (async () => { switch (type) {${body}\n}\n} })();`;
  return new Function(`"use strict";\n${transpiler.transformSync(`function make({ ${caseNames.join(", ")} }: any) { ${code} }`)}\nreturn make;`)();
}

const kickCase = receiverCase("KICK_PARTY_MEMBER", 6);
const leaveCase = receiverCase("LEAVE_PARTY", 6);
// The answer to an invitation, not the sending of one: the case inside INVITATION_RESPONSE.
const inviteAnswerCase = receiverCase("INVITE_PARTY", 10);
// The leader's answer to a joiner's offer to make the party a raid group.
const raidAnswerCase = receiverCase("RAID_CONVERT", 10);

let online: Record<string, any>;
/** Who was sent what, in order. */
let sent: Array<[string, Row]>;
let emitted: any[][];
let synced: Array<[string, string[]]>;

function connect(username: string): any {
  const live = { id: `session-${username}`, username, isGuest: false, party: ["as", "it", "was"], party_id: -1, invitations: [], wt: { username } };
  online[live.id] = live;
  return live;
}

const sentTo = (username: string) => sent.filter(([to]) => to === username).map(([, packet]) => packet);
const notice = (message: string) => ({ type: "NOTIFY", data: { message } });
/** What UPDATE_PARTY now carries: the list, who leads (the first of it, as the lists here are leader-first) and whether it is a raid. A cleared party has only the empty list. */
const partyNow = (members: string[], raid = false) => ({ type: "UPDATE_PARTY", data: members.length ? { members, leader: members[0], raid } : { members } });

/** The raid conversion offers made: who asked, and of which leader. */
let converts: Array<[string, string]>;

const given = () => ({
  parties,
  applyPartyMembers,
  clearParty,
  joinOutcome,
  capital,
  newLeaderNotice,
  announceJoin: (...args: any[]) => announceJoinWith(given())(...args),
  offerRaidConvert: async (joiner: any, leader: string) => { converts.push([joiner.username, leader]); },
  player: { getSessionIdByUsername: async (username: string) => Object.values(online).find((live) => live.username === username)?.id },
  playerCache: { get: (id: string) => online[id], set: (id: string, value: any) => { online[id] = value; }, list: () => online },
  // One node: the party actions take their single-node path.
  clusterEnabled: () => false,
  sendPacket: (to: any, packet: Row) => { sent.push([to.username, packet]); },
  packetManager: {
    notify: (data: Row) => ({ type: "NOTIFY", data }),
    updateParty: (data: Row) => ({ type: "UPDATE_PARTY", data }),
    despawnPlayer: (id: string) => ({ type: "DESPAWN_PLAYER", data: { id } }),
  },
  listener: { emit: (...event: any[]) => { emitted.push(event); } },
  Events: { PARTY_CHANGED: "onPartyChanged" },
  syncPartyLayers: async (leader: string, members: string[]) => { synced.push([leader, members]); },
  sendAnimationTo: async () => {},
  queueSpawnPlayerPacket: () => null,
  getAnimationNameForDirection: () => "",
  getPlayerSpriteSheetData: async () => null,
  getMountSpriteUrl: () => null,
  spellEffects: { getEffectsPayload: () => [] },
  queueSpawnForReceivers: () => {},
  greetContacts: async () => {},
  // One node: no mirrors to show or hide, so only the change runs.
  partyViewChanged: async (_p: any, change: () => unknown) => { await change(); },
  // As cluster/deliver.ts on one node: the receiver's action runs at once on the member, when they are online.
  runOnPlayer: async (username: string, action: string, args: any) => {
    const live = Object.values(online).find((each) => each.username.toLowerCase() === username.toLowerCase());
    if (!live) return false;
    await partyActions[action]!(given())(live, args);
    return true;
  },
  // As cluster/deliver.ts on one node: sent to the player's connection, when they are online.
  deliverToPlayer: async (username: string, packet: Row) => {
    const live = Object.values(online).find((each) => each.username.toLowerCase() === username.toLowerCase());
    if (!live) return false;
    sent.push([live.username, packet]);
    return true;
  },
});

/** The cases tell each member without waiting for it to be done: let that finish. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

async function kick(leader: any, username: string): Promise<void> {
  await kickCase({ ...given(), type: "KICK_PARTY_MEMBER", data: { username }, currentPlayer: leader, wt: leader.wt });
  await settled();
}
async function leave(live: any): Promise<void> {
  await leaveCase({ ...given(), type: "LEAVE_PARTY", data: {}, currentPlayer: live, wt: live.wt });
  await settled();
}
async function answerInvite(invited: any, inviter: any, response = "ACCEPT"): Promise<void> {
  await inviteAnswerCase({ ...given(), type: "INVITE_PARTY", response, inviterName: inviter.username, currentPlayer: invited, wt: invited.wt });
  await settled();
}

describe("what the socket layer does with a party's answer", () => {
  beforeEach(() => {
    online = {};
    sent = [];
    emitted = [];
    synced = [];
    converts = [];
  });

  test("a kick from a party of three: those left get the new list, the kicked player is told they have no party", async () => {
    const [leader, stays, kicked] = ["user4", "user5", "user6"].map(connect);
    await kick(leader, "user6");

    expect(partiesTable[1]).toEqual({ id: 2, leader: "user4", members: "user4, user5" });
    expect(sentTo("user4")).toEqual([notice("User6 has been kicked from the party"), partyNow(["user4", "user5"])]);
    expect(sentTo("user5")).toEqual([partyNow(["user4", "user5"]), notice("User4 has kicked User6 from the party")]);
    expect(sentTo("user6")).toEqual([partyNow([]), notice("You have been kicked from the party")]);
    expect([leader.party, stays.party, kicked.party]).toEqual([["user4", "user5"], ["user4", "user5"], []]);
    expect(synced).toEqual([["user4", ["user4", "user5"]]]);
    expect(emitted).toEqual([["onPartyChanged", { type: "kick", username: "user4", kickedUsername: "user6", members: ["user6"] }]]);
  });

  test("a kick from a party of two ends it, and both are told", async () => {
    const [leader, kicked] = ["user1", "user2"].map(connect);
    await kick(leader, "user2");

    expect(partiesTable.map((row) => row.id)).toEqual([2]);
    for (const username of ["user1", "user2"]) expect(sentTo(username)).toEqual([partyNow([]), notice("The party has been disbanded")]);
    expect([leader.party, kicked.party]).toEqual([[], []]);
    expect(emitted).toEqual([["onPartyChanged", { type: "disband", members: ["user1", "user2"] }]]);
  });

  test("a kick the database does not answer is reported as failed, and nobody is told anything else", async () => {
    connect("user5");
    connect("user6");
    failing = /^UPDATE parties/;
    await kick(connect("user4"), "user6");
    failing = null;

    expect(sent).toEqual([["user4", notice("Failed to kick User6 from the party")]]);
    expect(emitted).toEqual([]);
  });

  test("a member leaving a party of three is told they have no party, and those left get the new list", async () => {
    const [leader, stays, leaver] = ["user4", "user5", "user6"].map(connect);
    await leave(leaver);

    expect(partiesTable[1]).toEqual({ id: 2, leader: "user4", members: "user4, user5" });
    expect(sentTo("user6")).toEqual([notice("You have left the party"), partyNow([])]);
    expect(leaver.party_id).toBeNull();
    for (const username of ["user4", "user5"]) expect(sentTo(username)).toEqual([partyNow(["user4", "user5"]), notice("User6 has left the party")]);
    expect([leader.party, stays.party, leaver.party]).toEqual([["user4", "user5"], ["user4", "user5"], []]);
    expect(synced).toEqual([["user4", ["user4", "user5"]]]);
    expect(emitted).toEqual([["onPartyChanged", { type: "leave", username: "user6", members: ["user6"] }]]);
  });

  test("the leader leaving a party of three passes the lead to the next member, who is told", async () => {
    const three = ["user4", "user5", "user6"].map(connect);
    await leave(three[0]);
    expect(partiesTable[1]).toMatchObject({ leader: "user5", members: "user5, user6" });
    expect(sentTo("user4")).toEqual([notice("You have left the party"), partyNow([])]);
    for (const username of ["user5", "user6"]) {
      expect(sentTo(username)).toEqual([partyNow(["user5", "user6"]), notice("User4 has left the party"), notice("User5 is now the party leader.")]);
    }
    expect(three.map((live) => live.party)).toEqual([[], ["user5", "user6"], ["user5", "user6"]]);
    expect(synced).toEqual([["user5", ["user5", "user6"]]]);
    expect(emitted.map(([, event]) => event.type)).toEqual(["leave"]);
  });

  test("the notice that the lead has passed is the party rules' own", async () => {
    const three = ["user4", "user5", "user6"].map(connect);
    await leaveCase({ ...given(), newLeaderNotice: (leader: string) => `lead: ${leader}`, type: "LEAVE_PARTY", data: {}, currentPlayer: three[0], wt: three[0].wt });
    await settled();
    expect(sentTo("user6").at(-1)).toEqual(notice("lead: user5"));
  });

  test("one of only two leaving ends the party for everyone", async () => {
    const two = ["user1", "user2"].map(connect);
    await leave(two[1]);
    for (const username of ["user1", "user2"]) expect(sentTo(username)).toEqual([partyNow([]), notice("The party has been disbanded")]);
    expect(partiesTable.map((row) => row.id)).toEqual([2]);
    expect(emitted.map(([, event]) => event.type)).toEqual(["disband"]);
  });

  test("the leader leaving a party of two ends it for everyone", async () => {
    const two = ["user1", "user2"].map(connect);
    await leave(two[0]);
    for (const username of ["user1", "user2"]) expect(sentTo(username)).toEqual([partyNow([]), notice("The party has been disbanded")]);
    expect(emitted.map(([, event]) => event.type)).toEqual(["disband"]);
  });

  test("a leave the database does not answer is reported as failed", async () => {
    connect("user4");
    failing = /^UPDATE parties/;
    await leave(connect("user6"));
    failing = null;

    expect(sent).toEqual([["user6", notice("Failed to leave party")]]);
    expect(emitted).toEqual([]);
  });

  test("an invitation accepted joins the inviter's party, or makes one", async () => {
    const [leader, member, joins] = ["user1", "user2", "user3"].map(connect);
    await answerInvite(joins, leader);
    expect(partiesTable[0].members).toBe("user1, user2, user3");
    expect(sentTo("user3")).toEqual([notice("You have joined User1's party"), partyNow(["user1", "user2", "user3"])]);
    expect(sentTo("user2")).toEqual([partyNow(["user1", "user2", "user3"])]);
    // The inviter is reached by name (on whichever node holds them).
    expect(sentTo("user1")).toEqual([notice("User3 has joined your party"), partyNow(["user1", "user2", "user3"])]);
    expect(leader.party).toEqual(["user1", "user2", "user3"]);
    expect(member.party).toEqual(["user1", "user2", "user3"]);
    // The party's id goes with its list: a copy's party check reads it.
    expect([leader.party_id, member.party_id, joins.party_id]).toEqual([partiesTable[0].id, partiesTable[0].id, partiesTable[0].id]);

    const [inviter, invited] = [connect("user7"), connect("user8")];
    accountsTable.push({ username: "user8", party_id: null });
    await answerInvite(invited, inviter);
    expect(partiesTable[2]).toEqual({ id: 3, leader: "user7", members: "user7, user8" });
    // Each of the two is sent the new party once.
    expect(sentTo("user8")).toEqual([notice("You have joined User7's party"), partyNow(["user7", "user8"])]);
    expect(sentTo("user7")).toEqual([notice("User8 has joined your party"), partyNow(["user7", "user8"])]);
    expect(inviter.party).toEqual(["user7", "user8"]);
    expect(invited.party).toEqual(["user7", "user8"]);
  });

  test("an invitation into a party the player cannot join says so, and not that they joined", async () => {
    // Already in another party since the invitation was sent.
    const [leader, invited] = [connect("user1"), connect("user5")];
    await answerInvite(invited, leader);

    expect(sent).toEqual([["user5", notice("Failed to join party")]]);
    expect(writes()).toEqual([]);
    expect(invited.party).toEqual(["as", "it", "was"]);
    expect(emitted).toEqual([]);
  });

  test("an invitation accepted is announced as a join; one declined is not, and changes nothing", async () => {
    const [leader, , joins] = ["user1", "user2", "user3"].map(connect);
    await answerInvite(joins, leader);
    expect(emitted).toEqual([["onPartyChanged", { type: "join", username: "user3", members: ["user1", "user2", "user3"] }]]);

    emitted = [];
    const [inviter, invited] = [connect("user7"), connect("user8")];
    accountsTable.push({ username: "user8", party_id: null });
    const before = writes().length;
    await answerInvite(invited, inviter, "DECLINE");
    expect(emitted).toEqual([]);
    expect(writes()).toHaveLength(before);
  });

  test("a sixth accepts a full party: its leader is asked to convert it, and the joiner does not join yet", async () => {
    partiesTable[1].members = "user4, user5, user6, user8, user9";
    await datacache.clearCaches();
    const joins = connect("user3");
    const before = writes().length;
    await answerInvite(joins, connect("user4"));
    expect(converts).toEqual([["user3", "user4"]]);
    expect(writes()).toHaveLength(before);
    expect(sentTo("user3")).toEqual([]);
    expect(emitted).toEqual([]);
  });

  test("a raid group takes a sixth, and at twenty the joiner is told the party is full", async () => {
    partiesTable[1].members = "user4, user5, user6, user8, user9";
    partiesTable[1].raid = 1;
    await datacache.clearCaches();
    const joins = connect("user3");
    await answerInvite(joins, connect("user4"));
    expect(converts).toEqual([]);
    expect(partiesTable[1].members).toBe("user4, user5, user6, user8, user9, user3");
    expect(sentTo("user3")[0]).toEqual(notice("You have joined User4's party"));
    expect(sentTo("user3")[1]).toEqual(partyNow(["user4", "user5", "user6", "user8", "user9", "user3"], true));

    sent = [];
    partiesTable[1].members = Array.from({ length: 20 }, (_, i) => i === 0 ? "user4" : `m${i}`).join(", ");
    await datacache.clearCaches();
    const late = connect("user7");
    await answerInvite(late, connect("user4"));
    expect(sentTo("user7")).toEqual([notice("The party is full")]);
    expect(converts).toEqual([]);
  });

  test("an invitation from a player without a party is refused to one who has since joined another", async () => {
    const [inviter, invited] = [connect("user3"), connect("user2")];
    await answerInvite(invited, inviter);

    expect(sent).toEqual([["user2", notice("Failed to create party")]]);
    expect(writes()).toEqual([]);
    expect(await parties.getAllParties()).toEqual(inDatabase());
    expect(partiesTable.map((row) => row.members)).toEqual(["user1, user2", "user4, user5, user6"]);
    expect(emitted).toEqual([]);
  });

  describe("the leader's answer to an offer to make the party a raid group", () => {
    /** Party 1 grown to five, its leader online, and user3 the one asking to join as the sixth, by an offer for `offeredFor`. */
    async function offered(offeredFor: number) {
      partiesTable[0].members = "user1, user2, user8, user9, user10";
      await datacache.clearCaches();
      const leader = connect("user1");
      connect("user3");
      return (response = "ACCEPT") => raidAnswerCase({
        ...given(), type: "RAID_CONVERT", response, inviterName: "user3", currentPlayer: leader, wt: leader.wt,
        invite: { action: "RAID_CONVERT", originator: "session-user3", originatorName: "user3", authorization: "a", target: "user1", partyId: offeredFor },
        isOnline: async (name: string) => Object.values(online).some((live) => live.username === name),
      }).then(settled);
    }

    test("accepted: the party becomes a raid group and the joiner is in it", async () => {
      await (await offered(1))();
      expect(partiesTable[0].raid).toBe(1);
      expect(partiesTable[0].members).toBe("user1, user2, user8, user9, user10, user3");
      expect(partyIdOf("user3")).toBe(1);
    });

    test("an offer made for another party than the one the leader leads now: no raid, and the joiner is told the party is full", async () => {
      await (await offered(2))();
      expect(partiesTable[0].raid).toBeUndefined();
      expect(partyIdOf("user3")).toBeNull();
      expect(sentTo("user3")).toContainEqual(notice("The party is full"));
    });

    test("a member left since the offer, so there is room without a raid: no raid, and the joiner is told the party is full", async () => {
      const answer = await offered(1);
      partiesTable[0].members = "user1, user2, user8, user9";
      await datacache.clearCaches();
      await answer();
      expect(partiesTable[0].raid).toBeUndefined();
      expect(partyIdOf("user3")).toBeNull();
      expect(sentTo("user3")).toContainEqual(notice("The party is full"));
    });
  });
});

// ------------------------------------------------------------- behaviour

test("parties.isInParty returns true for users in party", async () => {
  const result = await parties.isInParty("user1");
  expect(result).toBe(true);
});

test("parties.isInParty returns false for users not in party", async () => {
  const result = await parties.isInParty("user3");
  expect(result).toBe(false);
});

test("parties.isPartyLeader returns true for party leaders", async () => {
  const result = await parties.isPartyLeader("user1");
  expect(result).toBe(true);
});

test("parties.isPartyLeader returns false for non-leaders", async () => {
  const result = await parties.isPartyLeader("user2");
  expect(result).toBe(false);
});

test("parties.getPartyId returns party id", async () => {
  const result = await parties.getPartyId("user1");
  expect(result).toBe(1);
});

test("parties.getPartyId returns null for non-members", async () => {
  const result = await parties.getPartyId("user3");
  expect(result).toBeNull();
});

test("parties.getPartyMembers returns members list", async () => {
  const result = await parties.getPartyMembers(1);
  expect(result).toContain("user1");
  expect(result).toContain("user2");
});

test("parties.getPartyLeader returns leader name", async () => {
  const result = await parties.getPartyLeader(1);
  expect(result).toBe("user1");
});

test("parties.getAllParties returns all parties", async () => {
  const result = await parties.getAllParties();
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBeGreaterThan(0);
});
