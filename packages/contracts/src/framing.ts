import { Transform } from "node:stream";

/**
 * Canonical wire framing of the SWPanel IPC contract (architecture.md §12.1).
 * Both the Agent Runner server and the Electron Main client speak this exact
 * framing: one JSON document per message followed by `\n`. The codec enforces a
 * maximum frame size and rejects oversized frames (and non-JSON garbage)
 * instead of buffering without bound.
 *
 * Living in `@swpanel/contracts` makes the byte-level wire format a single
 * shared contract: the Runner re-exports it from `@swpanel/runner` and the
 * desktop Main client imports it directly, so the two implementations can never
 * drift apart.
 */

/** Maximum serialized frame size (1 MiB), architecture.md §12.1. */
export const MAX_IPC_FRAME_BYTES = 1048576;

/** Structured error emitted by the codec for an oversized or malformed frame. */
export class FrameError extends Error {
  readonly code: "FRAME_TOO_LARGE" | "FRAME_INVALID";

  constructor(code: "FRAME_TOO_LARGE" | "FRAME_INVALID", message: string) {
    super(message);
    this.name = "FrameError";
    this.code = code;
  }
}

interface FrameCodecState {
  buffer: Buffer;
  frames: string[];
}

/**
 * Transform stream splitting the incoming byte stream into JSON strings. The
 * raw buffer is capped at {@link MAX_IPC_FRAME_BYTES}; once a candidate frame
 * exceeds the cap, `FRAME_TOO_LARGE` fires and the stream emits an error, which
 * the connection owner translates into a structured error followed by a
 * disconnect. A final non-empty fragment (no trailing newline yet) is treated
 * as an incomplete frame and dropped on end.
 */
export class FrameCodec extends Transform {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly maxFrameBytes: number;

  constructor(maxFrameBytes: number = MAX_IPC_FRAME_BYTES) {
    super({ readableObjectMode: true });
    this.maxFrameBytes = maxFrameBytes;
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      const state = this.consume(chunk);
      for (const frame of state.frames) {
        this.push(frame);
      }
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  _flush(callback: (error?: Error | null) => void): void {
    // A trailing fragment without a newline is an incomplete frame. It is
    // dropped silently; the JSON.parse gate still rejects malformed content.
    this.buffer = Buffer.alloc(0);
    callback();
  }

  private consume(chunk: Buffer): FrameCodecState {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: string[] = [];
    let start = 0;
    for (let index = 0; index < this.buffer.length; index++) {
      if (this.buffer[index] === 0x0a) {
        // Enforce the cap on EVERY candidate frame, not just the leftover
        // partial buffer: a single frame longer than the cap (even when it
        // ends with a newline) must be rejected, never delivered.
        if (index - start > this.maxFrameBytes) {
          this.buffer = Buffer.alloc(0);
          throw new FrameError(
            "FRAME_TOO_LARGE",
            `Incoming IPC frame exceeds the ${this.maxFrameBytes}-byte limit`
          );
        }
        frames.push(this.buffer.subarray(start, index).toString("utf8"));
        start = index + 1;
      }
    }
    this.buffer = this.buffer.subarray(start);
    if (this.buffer.length > this.maxFrameBytes) {
      this.buffer = Buffer.alloc(0);
      throw new FrameError(
        "FRAME_TOO_LARGE",
        `Incoming IPC frame exceeds the ${this.maxFrameBytes}-byte limit`
      );
    }
    return { buffer: this.buffer, frames };
  }

  /** Encodes a message into a newline-delimited JSON buffer (size-bounded). */
  static encode(message: unknown): Buffer {
    const line = JSON.stringify(message);
    if (line === undefined) {
      throw new FrameError("FRAME_INVALID", "Message cannot be serialized to JSON");
    }
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > MAX_IPC_FRAME_BYTES) {
      throw new FrameError(
        "FRAME_TOO_LARGE",
        `Outgoing IPC frame (${bytes} bytes) exceeds the ${MAX_IPC_FRAME_BYTES}-byte limit`
      );
    }
    return Buffer.concat([Buffer.from(line, "utf8"), Buffer.from([0x0a])]);
  }
}
