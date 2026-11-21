export const CREATURE_MOVE_HEADER = 0x04;
export const CREATURE_MOVE_HEADER_BYTES = 3;
export const CREATURE_MOVE_ENTRY_BYTES = 13;

/** The most a count field holds; a batch past it is split by the caller before it is built. */
export const CREATURE_MOVE_MAX_ENTRIES = 0xffff;

/** Direction names by code. Must equal the client's table. */
export const DIRECTION_ORDER = ["down", "up", "left", "right", "downleft", "downright", "upleft", "upright"] as const;
const DIRECTION_CODE: Record<string, number> = Object.fromEntries(DIRECTION_ORDER.map((name, i) => [name, i]));

const MOVING_BIT = 0x08;

/** The 13 byte record of a [id, x, y, dir, moving] entry, or null when a field does not fit its width. */
export function encodeCreatureMove(entry: readonly [number, number, number, string, 0 | 1]): Uint8Array | null {
  const [id, x, y, dir, moving] = entry;
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) return null;
  if (!Number.isInteger(x) || x < -0x80000000 || x > 0x7fffffff) return null;
  if (!Number.isInteger(y) || y < -0x80000000 || y > 0x7fffffff) return null;
  if (moving !== 0 && moving !== 1) return null;
  const code = Object.hasOwn(DIRECTION_CODE, dir) ? DIRECTION_CODE[dir] : -1;
  if (code < 0) return null;
  const record = new Uint8Array(CREATURE_MOVE_ENTRY_BYTES);
  const view = new DataView(record.buffer);
  view.setUint32(0, id, true);
  view.setInt32(4, x, true);
  view.setInt32(8, y, true);
  record[12] = code | (moving ? MOVING_BIT : 0);
  return record;
}

/** One payload from records made by encodeCreatureMove. */
export function joinCreatureMoves(records: readonly Uint8Array[]): Uint8Array {
  const payload = new Uint8Array(CREATURE_MOVE_HEADER_BYTES + records.length * CREATURE_MOVE_ENTRY_BYTES);
  payload[0] = CREATURE_MOVE_HEADER;
  new DataView(payload.buffer).setUint16(1, records.length, true);
  let at = CREATURE_MOVE_HEADER_BYTES;
  for (const record of records) {
    payload.set(record, at);
    at += CREATURE_MOVE_ENTRY_BYTES;
  }
  return payload;
}

/** The entries of a payload, as the JSON packet's [id, x, y, dir, moving]. Tests use it as the reference decoder. */
export function decodeCreatureMoves(payload: Uint8Array): [number, number, number, string, 0 | 1][] {
  if (payload.length < CREATURE_MOVE_HEADER_BYTES || payload[0] !== CREATURE_MOVE_HEADER) return [];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const count = Math.min(view.getUint16(1, true), Math.floor((payload.length - CREATURE_MOVE_HEADER_BYTES) / CREATURE_MOVE_ENTRY_BYTES));
  const out: [number, number, number, string, 0 | 1][] = [];
  for (let i = 0, at = CREATURE_MOVE_HEADER_BYTES; i < count; i++, at += CREATURE_MOVE_ENTRY_BYTES) {
    const flags = payload[at + 12];
    out.push([
      view.getUint32(at, true),
      view.getInt32(at + 4, true),
      view.getInt32(at + 8, true),
      DIRECTION_ORDER[flags & 0x07],
      flags & MOVING_BIT ? 1 : 0,
    ]);
  }
  return out;
}
