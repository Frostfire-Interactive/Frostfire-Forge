import query from "../controllers/sqldatabase";

// Character names and look-ups. The name rule is for names players choose; stored names that predate it (guests
// are 30 characters) still resolve, because look-ups go by nameKey, the lowercased name.

export type CharacterRow = {
  id: number;
  accountId: number;
  name: string;
  classId: number | null;
  deletedAt: number | null;
};

type Query = (sql: string, params?: any[]) => Promise<any>;

const NAME_RULE = /^[a-zA-Z0-9_]{3,15}$/;

export const isValidCharacterName = (name: string): boolean => typeof name === "string" && NAME_RULE.test(name);

export const nameKey = (name: string): string => String(name).toLowerCase();

const toRow = (r: any): CharacterRow => ({
  id: Number(r.id),
  accountId: Number(r.account_id),
  name: String(r.name),
  classId: r.class_id === null || r.class_id === undefined ? null : Number(r.class_id),
  deletedAt: r.deleted_at === null || r.deleted_at === undefined ? null : Number(r.deleted_at),
});

export function makeCharacterStore(q: Query) {
  const characterById = async (id: number): Promise<CharacterRow | null> => {
    const rows = (await q("SELECT id, account_id, name, class_id, deleted_at FROM characters WHERE id = ? LIMIT 1", [id])) as any[];
    return rows && rows.length ? toRow(rows[0]) : null;
  };

  const characterByName = async (name: string): Promise<CharacterRow | null> => {
    const rows = (await q("SELECT id, account_id, name, class_id, deleted_at FROM characters WHERE name_key = ? AND deleted_at IS NULL LIMIT 1", [nameKey(name)])) as any[];
    return rows && rows.length ? toRow(rows[0]) : null;
  };

  const nameTaken = async (name: string, accountId: number): Promise<boolean> => {
    const key = nameKey(name);
    const chars = (await q("SELECT id FROM characters WHERE name_key = ? LIMIT 1", [key])) as any[];
    if (chars && chars.length) return true;
    const accounts = (await q("SELECT id FROM accounts WHERE LOWER(username) = ? AND id <> ? LIMIT 1", [key, accountId])) as any[];
    return !!(accounts && accounts.length);
  };

  return { characterById, characterByName, nameTaken };
}

// Through the module's binding at each call, not the function it held when this module was first loaded.
const store = makeCharacterStore(((sql: string, values?: any[]) => (query as Query)(sql, values)) as Query);
export const characterById = store.characterById;
export const characterByName = store.characterByName;
export const nameTaken = store.nameTaken;
