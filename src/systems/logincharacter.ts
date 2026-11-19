import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import { makeCharacterStore, type CharacterRow } from "./characterstore";

// Which character a login plays. An account logs in with a token; the character is the account's
// accounts.active_character_id, chosen on the Gateway's character page. The client never names one. A player arriving
// on a node by handoff plays the character the handoff carries (pinned), never the active one read again.

export type LoginAccount = { id: number; username: string; activeCharacterId: number | null };

export type LoginCharacterRefusal = "no_account" | "no_active_character" | "character_missing" | "character_deleted" | "character_of_another_account";

export type LoginCharacterDecision =
  | { ok: true; accountId: number; accountUsername: string; characterId: number; characterName: string }
  | { ok: false; reason: LoginCharacterRefusal };

/** What the client is sent when a session of its account is kicked for this login. */
export const KICK_MESSAGE = "You have been logged in from another location.";

/** The account's active character, or why there is none to play. */
export function decideLoginCharacter(account: LoginAccount, character: CharacterRow | null): LoginCharacterDecision {
  if (account.activeCharacterId === null || account.activeCharacterId === undefined) return { ok: false, reason: "no_active_character" };
  if (!character || character.id !== Number(account.activeCharacterId)) return { ok: false, reason: "character_missing" };
  if (character.deletedAt !== null) return { ok: false, reason: "character_deleted" };
  if (character.accountId !== Number(account.id)) return { ok: false, reason: "character_of_another_account" };
  return { ok: true, accountId: Number(account.id), accountUsername: account.username, characterId: character.id, characterName: character.name };
}

type Query = (sql: string, params?: any[]) => Promise<any>;

export function makeLoginCharacter(q: Query) {
  const store = makeCharacterStore(q);
  /**
   * The character the account named `accountUsername` logs in as (the name setSessionId answers with): its active
   * character, or `pinnedCharacterId` when given (a handoff's). Either is refused when deleted or another account's.
   */
  return async (accountUsername: string, pinnedCharacterId?: number): Promise<LoginCharacterDecision> => {
    const rows = (await q("SELECT id, username, active_character_id FROM accounts WHERE username = ? LIMIT 1", [accountUsername])) as any[];
    const row = rows?.[0];
    if (!row) return { ok: false, reason: "no_account" };
    const account: LoginAccount = {
      id: Number(row.id),
      username: String(row.username),
      activeCharacterId: row.active_character_id === null || row.active_character_id === undefined ? null : Number(row.active_character_id),
    };
    const pinned = Number(pinnedCharacterId);
    if (pinnedCharacterId !== undefined && pinnedCharacterId !== null) {
      if (!Number.isSafeInteger(pinned) || pinned <= 0) return { ok: false, reason: "character_missing" };
      account.activeCharacterId = pinned;
    }
    const character = account.activeCharacterId === null ? null : await store.characterById(account.activeCharacterId);
    return decideLoginCharacter(account, character);
  };
}

// Through the module's binding at each call, not the function it held when this module was first loaded.
export const loginCharacterOf = makeLoginCharacter(((sql: string, values?: any[]) => (query as Query)(sql, values)) as Query);

/** The players in the game on this node under account `accountId`, whichever character they play. */
export function sessionsOfAccount<T extends { accountId?: unknown }>(players: Iterable<T>, accountId: number): T[] {
  const out: T[] = [];
  if (!Number.isFinite(Number(accountId))) return out;
  for (const p of players) {
    if (p && p.accountId !== undefined && p.accountId !== null && Number(p.accountId) === Number(accountId)) out.push(p);
  }
  return out;
}

export type KickDeps<T> = {
  /** Writes the player's state; awaited before the kick. A save that fails is logged and the kick goes on. */
  save: (p: T) => Promise<void>;
  /**
   * Runs what a disconnect runs for the player leaving (the PLAYER_DISCONNECT listeners), once, after the save and
   * before the new login's player is added. One that throws is logged and the kick goes on.
   */
  leave: (p: T) => void;
  /** Tells the old session why it ends. */
  notify: (p: T, message: string) => void;
  /** Takes the old session out of the world and closes it. */
  drop: (p: T) => Promise<void> | void;
};

/** Each session in turn: saved, left (its listeners run), told, then dropped. A drop that throws is logged. */
export async function kickDuplicateSessions<T extends { id?: unknown; username?: unknown }>(sessions: T[], deps: KickDeps<T>): Promise<void> {
  for (const p of sessions) {
    try {
      await deps.save(p);
    } catch (error) {
      log.error(`The kicked session of ${String(p.username ?? p.id)} could not be saved: ${error}`);
    }
    try {
      deps.leave(p);
    } catch (error) {
      log.error(`The leave of the kicked session of ${String(p.username ?? p.id)} failed: ${error}`);
    }
    deps.notify(p, KICK_MESSAGE);
    try {
      await deps.drop(p);
    } catch (error) {
      log.error(`The kicked session of ${String(p.username ?? p.id)} was not dropped cleanly: ${error}`);
    }
  }
}
