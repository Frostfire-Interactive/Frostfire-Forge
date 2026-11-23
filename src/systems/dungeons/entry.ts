import type { CopyBook } from "./copybook";
import type { dungeonCharacters } from "./characterstate";
import { decideEntry, refusalMessage } from "./rules";
import type { CopyRecord, DungeonDef, DungeonSize, RefusalReason } from "./types";

export interface EntryDeps {
    book: CopyBook;
    def(id: number): Promise<DungeonDef | null>;
    lockouts: Pick<typeof dungeonCharacters, "lockout" | "trySpend" | "refund">;
    openCopy(def: DungeonDef, size: DungeonSize): Promise<CopyRecord>;
    now(): number;
}

export interface EntryRequest {
    username: string; party: string[]; leader: string | null; dungeonId: number; size?: DungeonSize;
}

export type EntryResult =
    | { kind: "enter"; copy: CopyRecord; paid: boolean }
    | { kind: "choose_size"; sizes: DungeonSize[] }
    | { kind: "refuse"; reason: RefusalReason; message: string };

const refuse = (reason: RefusalReason, waitMs?: number): EntryResult =>
    ({ kind: "refuse", reason, message: refusalMessage({ kind: "refuse", reason, waitMs }) });

async function run(deps: EntryDeps, req: EntryRequest): Promise<EntryResult> {
    const { username, party, leader, dungeonId, size } = req;
    const def = await deps.def(dungeonId);
    const copies = await deps.book.list(dungeonId);

    if (!def) {
        const mine = copies
            .filter((c) => c.entered.includes(username))
            .sort((a, b) => b.openedAt - a.openedAt)[0];
        return mine ? { kind: "enter", copy: mine, paid: false } : refuse("disabled");
    }

    const now = deps.now();
    const decision = decideEntry({ username, party, leader, def, copies, lockout: await deps.lockouts.lockout(username), now, size });
    switch (decision.kind) {
        case "rejoin": return { kind: "enter", copy: decision.copy, paid: false };
        case "choose_size": return decision;
        case "refuse": return { kind: "refuse", reason: decision.reason, message: refusalMessage(decision) };
        case "join":
        case "open": {
            const spent = await deps.lockouts.trySpend(username, now);
            if (!spent.ok) return refuse("no_entries", spent.waitMs);
            try {
                const copy = decision.kind === "join" ? decision.copy : await deps.openCopy(def, decision.size);
                if (!copy.entered.includes(username)) copy.entered = [...copy.entered, username];
                await deps.book.put(copy);
                return { kind: "enter", copy, paid: true };
            } catch (error) {
                // Not let in: the entry is not lost.
                await deps.lockouts.refund(username, spent.windowStart).catch(() => {});
                throw error;
            }
        }
    }
}

export function enterDungeon(deps: EntryDeps, req: EntryRequest): Promise<EntryResult> {
    return deps.book.locked(req.dungeonId, () => run(deps, req));
}
