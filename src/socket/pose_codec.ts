export const POSE_DATAGRAM_HEADER = 0x05;
export const POSE_DATAGRAM_HEADER_BYTES = 3;
/** The bytes of a record before its state. */
export const POSE_RECORD_FIXED_BYTES = 9;
/** The longest state a record holds. */
export const POSE_STATE_MAX_BYTES = 255;
/** The most a revision holds. */
export const POSE_REVISION_MAX = 0xffffffff;

const encoder = new TextEncoder();

/** The record of a pose, or null when a field does not fit its width. */
export function encodePoseRecord(id: string | number, revision: number, state: string): Uint8Array | null {
  const numeric = typeof id === "number" ? id : /^\d{1,10}$/.test(id) ? Number(id) : NaN;
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0xffffffff) return null;
  if (!Number.isInteger(revision) || revision < 0 || revision > POSE_REVISION_MAX) return null;
  if (typeof state !== "string" || state.length === 0 || state.length > POSE_STATE_MAX_BYTES) return null;
  const text = encoder.encode(state);
  if (text.length > POSE_STATE_MAX_BYTES) return null;
  const record = new Uint8Array(POSE_RECORD_FIXED_BYTES + text.length);
  const view = new DataView(record.buffer);
  view.setUint32(0, numeric, true);
  view.setUint32(4, revision, true);
  record[8] = text.length;
  record.set(text, POSE_RECORD_FIXED_BYTES);
  return record;
}

export function packPoseRecords(records: readonly Uint8Array[], maxBytes: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let group: Uint8Array[] = [];
  let size = POSE_DATAGRAM_HEADER_BYTES;
  const flush = () => {
    if (group.length === 0) return;
    const payload = new Uint8Array(size);
    payload[0] = POSE_DATAGRAM_HEADER;
    new DataView(payload.buffer).setUint16(1, group.length, true);
    let at = POSE_DATAGRAM_HEADER_BYTES;
    for (const record of group) {
      payload.set(record, at);
      at += record.length;
    }
    out.push(payload);
    group = [];
    size = POSE_DATAGRAM_HEADER_BYTES;
  };
  for (const record of records) {
    if (POSE_DATAGRAM_HEADER_BYTES + record.length > maxBytes) continue;
    if (size + record.length > maxBytes || group.length >= 0xffff) flush();
    group.push(record);
    size += record.length;
  }
  flush();
  return out;
}

export interface PoseEntry {
  id: string;
  revision: number;
  state: string;
}

const decoder = new TextDecoder();

/** The poses of a datagram; none for anything that is not a whole, well-formed one (never throws). Used by the tests; the client has its own decoder. */
export function decodePoseDatagram(bytes: Uint8Array): PoseEntry[] {
  const entries: PoseEntry[] = [];
  if (!bytes || bytes.length < POSE_DATAGRAM_HEADER_BYTES || bytes[0] !== POSE_DATAGRAM_HEADER) return entries;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(1, true);
  let at = POSE_DATAGRAM_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    if (at + POSE_RECORD_FIXED_BYTES > bytes.length) break;
    const n = bytes[at + 8];
    if (at + POSE_RECORD_FIXED_BYTES + n > bytes.length) break;
    entries.push({
      id: String(view.getUint32(at, true)),
      revision: view.getUint32(at + 4, true),
      state: decoder.decode(bytes.subarray(at + POSE_RECORD_FIXED_BYTES, at + POSE_RECORD_FIXED_BYTES + n)),
    });
    at += POSE_RECORD_FIXED_BYTES + n;
  }
  return entries;
}
