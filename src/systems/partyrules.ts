import { setting } from "./gamesettings/store";

/** Most members of a party that is not a raid group (read when used). */
export const nonRaidCap = (): number => setting("partySize");
/** Most members of any party (read when used). */
export const partyCap = (): number => setting("raidSize");
/** How long the leader has to answer the offer to turn a full party into a raid group. */
export const RAID_CONVERT_MS = 60_000;

/** A player's name as it starts a sentence. */
export function capital(name: string): string {
    return name.charAt(0).toUpperCase() + name.slice(1);
}

/** What the members left are told when the lead has passed to `leader`. */
export function newLeaderNotice(leader: string): string {
    return `${capital(leader)} is now the party leader.`;
}

/** Whether a party with `count` members may invite anyone: a full party sends no invitations. */
export function canInvite(count: number): boolean {
    return count < partyCap();
}

/** What a player who accepts an invitation does, given the party's size: join, ask its leader to convert it to a raid, or be told it is full. */
export function joinOutcome(count: number, raid: boolean): "join" | "convert" | "full" {
    if (count >= partyCap()) return "full";
    if (count >= nonRaidCap() && !raid) return "convert";
    return "join";
}

/** The party once `username` has left it: the next member leads if the leader left, and one alone is no party. Members come back leader-first. */
export function afterLeaving(members: string[], leader: string, username: string): { kind: "disband" } | { kind: "stay"; leader: string; members: string[] } {
    const gone = username.toLowerCase();
    const rest = members.filter((member) => member.toLowerCase() !== gone);
    if (rest.length <= 1) return { kind: "disband" };
    const head = leader.toLowerCase() === gone ? rest[0] : rest.find((member) => member.toLowerCase() === leader.toLowerCase()) ?? rest[0];
    return { kind: "stay", leader: head, members: [head, ...rest.filter((member) => member !== head)] };
}
