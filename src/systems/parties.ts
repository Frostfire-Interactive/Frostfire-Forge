import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import { tableCache, dropRows } from "../services/datacache";
import { characterIdOf, needCharacterId } from "./characterids";
import { afterLeaving, joinOutcome } from "./partyrules";

/** A party as the table has it: `members` is the comma-separated list, the leader first. */
type PartyRow = { id: number; leader: string; members: string | null; raid: boolean };

const rows = tableCache<PartyRow>("parties", async () => {
    const result = await query("SELECT id, leader, members, raid FROM parties", []) as any[];
    return (result || []).map((row: any) => ({ id: row.id, leader: row.leader, members: row.members, raid: !!Number(row.raid) }));
});

const lower = (value: string | null) => String(value ?? "").toLowerCase();
const listed = (members: string | null): string[] => (members ? members.split(",").map((member) => member.trim()).filter((member) => member) : []);
const byId = (partyId: number) => (row: PartyRow) => Number(row.id) === Number(partyId);
/** Whether a stored member list names `name` (in lower case). */
const names = (members: string | null, name: string): boolean =>
    !!members && members.toLowerCase().includes(name) && listed(members).some((member) => lower(member) === name);

/** The party whose list names `username`, in any case, as the accounts table matched it. The newest, should two name it. */
async function partyOf(username: string): Promise<PartyRow | null> {
    const name = lower(username);
    let found = null as PartyRow | null;
    // Looks at every row held and copies none: `find` copies only a row it returns, and is given none.
    await rows.find((row) => {
        if ((!found || Number(row.id) > Number(found.id)) && names(row.members, name)) found = row;
        return false;
    });
    return found ? { ...found } : null;
}

/** After an UPDATE of one party: the same change to the row held, if the party is still there. */
async function change(partyId: number, changed: Partial<PartyRow>): Promise<void> {
    const party = await rows.find(byId(partyId));
    if (party) await rows.put({ ...party, ...changed }, byId(partyId));
}

/** The rows a write changed: Bun reports `affectedRows` on MySQL and `count` elsewhere. */
const changedRows = (result: any): number => (typeof result?.affectedRows === "number" ? result.affectedRows : Number(result?.count ?? 0));

/** How often a join is tried again after another join or leave changed the list first. */
const ADD_ATTEMPTS = 3;

async function writing<T>(accounts: Array<string | null | undefined>, write: () => Promise<T>): Promise<T> {
    try {
        return await write();
    } catch (error) {
        await rows.reload().catch((failure) => log.error(`Error reading the parties again after a failed write: ${failure}`));
        throw error;
    } finally {
        for (const username of new Set(accounts)) {
            if (username) await dropRows("accounts", username);
        }
    }
}

const parties = {
    async isInParty(username: string): Promise<boolean> {
        if (!username) return false;
        try {
            return (await partyOf(username)) !== null;
        } catch (error) {
            log.error(`Error checking if user is in party: ${error}`);
            return false;
        }
    },
    async isPartyLeader(username: string): Promise<boolean> {
        if (!username) return false;
        try {
            const name = lower(username);
            return (await rows.find((row) => lower(row.leader) === name)) !== null;
        } catch (error) {
            log.error(`Error checking if user is party leader: ${error}`);
            return false;
        }
    },
    async getPartyId(username: string): Promise<number | null> {
        if (!username) return null;
        try {
            const party = await partyOf(username);
            if (!party || !party.id) return null;
            return party.id;
        } catch (error) {
            log.error(`Error getting party ID for user: ${error}`);
            return null;
        }
    },
    async getPartyMembers(partyId: number): Promise<string[]> {
        if (!partyId) return [];
        try {
            const party = await rows.find(byId(partyId));
            if (!party || !party.members) return [];
            return listed(party.members);
        } catch (error) {
            log.error(`Error getting party members: ${error}`);
            return [];
        }
    },
    /** Whether the party has been made a raid group. */
    async isRaid(partyId: number): Promise<boolean> {
        if (!partyId) return false;
        try {
            const party = await rows.find(byId(partyId));
            return !!party?.raid;
        } catch (error) {
            log.error(`Error reading whether a party is a raid: ${error}`);
            return false;
        }
    },
    /** Makes the party a raid group, which may hold up to the party cap. */
    async setRaid(partyId: number): Promise<void> {
        if (!partyId) return;
        await writing([], () => query("UPDATE parties SET raid = 1 WHERE id = ?", [partyId]));
        await change(partyId, { raid: true });
    },
    async getPartyLeader(partyId: number): Promise<string | null> {
        if (!partyId) return null;
        try {
            const party = await rows.find(byId(partyId));
            if (!party || !party.leader) return null;
            return party.leader;
        } catch (error) {
            log.error(`Error getting party leader: ${error}`);
            return null;
        }
    },
    async exists(username: string): Promise<boolean> {
        if (!username) return false;
        const result = await this.getPartyId(username);
        return result !== null;
    },
    async add(username: string, partyId: number): Promise<string[]> {
        if (!username) return [];
        try {

            const existingParty = await this.exists(username);
            if (existingParty) return [];

            const joiningId = await needCharacterId(username);
            // The list is written only if it is still the one read: two joining at once, on any node, cannot drop each other or pass the cap together.
            for (let attempt = 0; attempt < ADD_ATTEMPTS; attempt++) {
                const party = await rows.find(byId(partyId));
                const members = listed(party?.members ?? null);
                if (!party || members.length === 0) return [];

                if (joinOutcome(members.length, !!party.raid) !== "join") return [];

                if (members.includes(username)) return [];

                const updatedMembers = [...members, username].join(", ");
                const written = await writing([], () => query("UPDATE parties SET members = ? WHERE id = ? AND members = ?", [updatedMembers, partyId, party.members]));
                if (changedRows(written) === 0) {
                    // Changed since it was read: read it again and decide again.
                    await rows.reload();
                    continue;
                }
                await change(partyId, { members: updatedMembers });
                await writing([username], () => query("UPDATE characters SET party_id = ? WHERE id = ?", [partyId, joiningId]));
                return updatedMembers.split(", ").map((member: string) => member.trim());
            }
            return [];
        } catch (error) {
            log.error(`Error adding user to party: ${error}`);
            return [];
        }
    },
    async remove(username: string): Promise<string[] | boolean> {
        if (!username) return [];
        try {
            const partyId = await this.getPartyId(username);
            if (!partyId) return [];

            const leader = await this.getPartyLeader(partyId);
            const leavingId = await needCharacterId(username);
            await writing([username], () => query("UPDATE characters SET party_id = NULL WHERE id = ?", [leavingId]));

            const members = await this.getPartyMembers(partyId);

            // In any case, as the account above was matched: the name must leave the list for the player to have left the party.
            const after = afterLeaving(members, leader ?? "", username);
            const memberArray = after.kind === "stay" ? after.members : members.filter((member: string) => lower(member) !== lower(username));
            const updatedMembers = memberArray.join(", ");
            if (after.kind === "stay" && lower(after.leader) !== lower(leader)) {
                // The leader left: the next member leads, in the same write as the list.
                const leaderId = await characterIdOf(after.leader);
                await writing([], () => query("UPDATE parties SET leader = ?, leader_id = ?, members = ? WHERE id = ?", [after.leader, leaderId, updatedMembers, partyId]));
                await change(partyId, { leader: after.leader, members: updatedMembers });
            } else {
                await writing([], () => query("UPDATE parties SET members = ? WHERE id = ?", [updatedMembers, partyId]));
                await change(partyId, { members: updatedMembers });
            }

            // One player alone is no party.
            if (after.kind === "disband") {
                await this.delete(partyId);
                return true;
            }

            return memberArray;
        } catch (error) {
            log.error(`Error removing user from party: ${error}`);
            return [];
        }
    },
    async delete(partyId: number): Promise<boolean> {
        if (!partyId) return false;
        try {
            const party = await rows.find(byId(partyId));
            await writing([], () => query("DELETE FROM parties WHERE id = ?", [partyId]));
            await rows.remove(byId(partyId));

            // The accounts that pointed at it: its members.
            const freed = party ? [...listed(party.members), party.leader] : [];
            await writing(freed, () => query("UPDATE characters SET party_id = NULL WHERE party_id = ?", [partyId]));
            log.info(`Party with ID ${partyId} deleted successfully.`);
            return true;
        } catch (error) {
            log.error(`Error deleting party: ${error}`);
            return false;
        }
    },
    async create(leader: string, username: string): Promise<string[] | boolean> {
        if (!leader || !username) return false;
        try {
            const existingParty = await this.exists(leader);
            if (existingParty) return false;

            // Nor may the second player be in one: they would be on two lists.
            const memberParty = await this.exists(username);
            if (memberParty) return false;

            const members = [leader, username].join(", ");
            const leaderId = await needCharacterId(leader);
            const memberId = await needCharacterId(username);
            const result = await writing([], () => query("INSERT INTO parties (leader, members, character_id, leader_id) VALUES (?, ?, ?, ?)", [leader, members, leaderId, leaderId])) as any;
            const partyId = result.lastInsertRowid;
            // Without the id the database gave it, the new row can only be had by reading the table again.
            if (Number(partyId) > 0) await rows.put({ id: Number(partyId), leader, members, raid: false }, byId(partyId));
            else await rows.reload();

            await writing([leader, username], () => query("UPDATE characters SET party_id = ? WHERE id IN (?, ?)", [partyId, leaderId, memberId]));
            return members.split(", ").map((member: string) => member.trim());
        } catch (error) {
            log.error(`Error creating party: ${error}`);
            return false;
        }
    },
    async leave(username: string): Promise<boolean | string[]> {
        if (!username) return false;
        try {
            const partyId = await this.getPartyId(username);
            if (!partyId) return false;

            const isLeader = await this.isPartyLeader(username);
            // The leader leaving a party of two ends it outright; with more, remove hands the lead on.
            if (isLeader && afterLeaving(await this.getPartyMembers(partyId), username, username).kind === "disband") return await this.delete(partyId);

            return await this.remove(username);
        } catch (error) {
            log.error(`Error leaving party: ${error}`);
            return false;
        }
    },
    async disband(username: string): Promise<boolean> {
        if (!username) return false;
        try {
            const partyId = await this.getPartyId(username);
            if (!partyId) return false;

            const isLeader = await this.isPartyLeader(username);
            if (!isLeader) return false;

            const members = await this.getPartyMembers(partyId);
            if (members.length === 0) return false;

            await writing(members, () => query("UPDATE characters SET party_id = NULL WHERE party_id = ?", [partyId]));

            return await this.delete(partyId);
        } catch (error) {
            log.error(`Error disbanding party: ${error}`);
            return false;
        }
    },
    async getAllParties(): Promise<Array<{ id: number; leader: string; members: string[] }>> {
        try {
            const result = await rows.all();
            if (!result || result.length === 0) return [];

            return result.map((row) => ({
                id: row.id,
                leader: row.leader,
                members: listed(row.members)
            }));
        } catch (error) {
            log.error(`Error getting all parties: ${error}`);
            return [];
        }
    }
}

export default parties;