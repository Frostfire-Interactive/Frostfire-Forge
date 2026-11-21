const HEADER_BYTES = 4;

export const CONNECT_FRAME_BYTES = 4 * 1024;
/** After AUTH_CONNECT, until a player logs in: the AUTH packet only. */
export const LOGIN_FRAME_BYTES = 16 * 1024;
/** A logged-in player's packets, unless they use the tools: map saves and editor packets are large. */
export const PLAYER_FRAME_BYTES = 256 * 1024;

export function frameLimitFor(player: { isAdmin?: boolean; permissions?: unknown[] } | null | undefined, maxFrameSize: number, benchmark = false): number {
  if (benchmark) return maxFrameSize;
  if (!player) return Math.min(LOGIN_FRAME_BYTES, maxFrameSize);
  const holdsAny = Array.isArray(player.permissions) && player.permissions.some((p) => typeof p === "string" && p.trim() !== "");
  if (player.isAdmin || holdsAny) return maxFrameSize;
  return Math.min(PLAYER_FRAME_BYTES, maxFrameSize);
}

export function encodeCloseReason(code: number, reason: string): string {
  return `${code}|${reason || ""}`;
}

export function decodeCloseReason(reason: string | undefined): { code: number; reason: string } {
  if (!reason) {
    return { code: 0, reason: "" };
  }

  const separator = reason.indexOf("|");
  if (separator === -1) {
    return { code: 1, reason };
  }

  const code = parseInt(reason.slice(0, separator), 10);
  return {
    code: Number.isFinite(code) ? code : 1,
    reason: reason.slice(separator + 1),
  };
}

export function encodeFrame(payload: Uint8Array): Uint8Array {
  if (payload.length > 0xffffffff) {
    throw new Error(`Frame payload too large: ${payload.length} bytes`);
  }

  const frame = new Uint8Array(HEADER_BYTES + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, payload.length, true);
  frame.set(payload, HEADER_BYTES);
  return frame;
}

export class FrameDecoder {
  private buffer: Uint8Array = new Uint8Array(8192);
  private readOffset: number = 0;
  private writeOffset: number = 0;
  private maxFrameSize: number;
  private overflowed: boolean = false;

  constructor(maxFrameSize: number) {
    this.maxFrameSize = maxFrameSize;
  }

  push(chunk: Uint8Array): Uint8Array[] {
    if (this.overflowed) {
      return [];
    }

    if (this.writeOffset + chunk.length > this.buffer.length) {
      if (this.readOffset > 0) {
        this.buffer.copyWithin(0, this.readOffset, this.writeOffset);
        this.writeOffset -= this.readOffset;
        this.readOffset = 0;
      }

      if (this.writeOffset + chunk.length > this.buffer.length) {
        const newSize = Math.max(this.buffer.length * 2, this.writeOffset + chunk.length);
        const newBuffer = new Uint8Array(newSize);
        newBuffer.set(new Uint8Array(this.buffer.buffer, this.buffer.byteOffset, this.writeOffset));
        this.buffer = newBuffer;
      }
    }

    this.buffer.set(chunk, this.writeOffset);
    this.writeOffset += chunk.length;

    const frames: Uint8Array[] = [];

    while (this.writeOffset - this.readOffset >= HEADER_BYTES) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + this.readOffset, HEADER_BYTES);
      const length = view.getUint32(0, true);

      if (length > this.maxFrameSize) {
        this.overflowed = true;
        this.buffer = new Uint8Array(0);
        this.readOffset = 0;
        this.writeOffset = 0;
        break;
      }

      if (this.writeOffset - this.readOffset < HEADER_BYTES + length) {
        break;
      }

      const frameStart = this.readOffset + HEADER_BYTES;
      frames.push(this.buffer.slice(frameStart, frameStart + length));
      this.readOffset = frameStart + length;
    }

    if (this.readOffset > 0 && this.readOffset === this.writeOffset) {
      this.readOffset = 0;
      this.writeOffset = 0;
    }

    return frames;
  }

  /** The largest frame accepted from now on: a connection is allowed more as it proves who it is. */
  setMaxFrameSize(maxFrameSize: number): void {
    this.maxFrameSize = maxFrameSize;
  }

  isOverflowed(): boolean {
    return this.overflowed;
  }
}
