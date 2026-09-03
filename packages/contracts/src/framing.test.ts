import { describe, expect, it } from "vitest";

import { FrameCodec, FrameError, MAX_IPC_FRAME_BYTES } from "./index.js";

function collect(stream: FrameCodec, input: Buffer): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const frames: string[] = [];
    stream.on("data", (frame: string) => frames.push(frame));
    stream.on("error", reject);
    stream.on("end", () => resolve(frames));
    stream.end(input);
  });
}

describe("IPC framing (newline-delimited JSON)", () => {
  it("encodes a message as JSON plus a trailing newline", () => {
    const buffer = FrameCodec.encode({ hello: "world" });
    expect(buffer.toString("utf8")).toBe('{"hello":"world"}\n');
  });

  it("round-trips a message through the codec", async () => {
    const frames = await collect(new FrameCodec(), FrameCodec.encode({ a: 1, b: [2, 3] }));
    expect(frames).toEqual([JSON.stringify({ a: 1, b: [2, 3] })]);
  });

  it("splits multiple frames received in a single chunk", async () => {
    const payload = Buffer.concat([
      FrameCodec.encode({ n: 1 }),
      FrameCodec.encode({ n: 2 }),
      FrameCodec.encode({ n: 3 })
    ]);
    const frames = await collect(new FrameCodec(), payload);
    expect(frames).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
  });

  it("reassembles a frame split across chunks", async () => {
    const stream = new FrameCodec();
    const frames: string[] = [];
    stream.on("data", (frame: string) => frames.push(frame));
    const encoded = FrameCodec.encode({ payload: "x".repeat(5000) });
    const half = Math.floor(encoded.length / 2);
    stream.write(encoded.subarray(0, half));
    await Promise.resolve();
    stream.write(encoded.subarray(half));
    await new Promise<void>((resolve) => {
      stream.on("end", () => resolve());
      stream.end();
    });
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0] as string)).toEqual({ payload: "x".repeat(5000) });
  });

  it("drops an unterminated trailing fragment on end", async () => {
    const stream = new FrameCodec();
    const frames: string[] = [];
    stream.on("data", (frame: string) => frames.push(frame));
    stream.write(FrameCodec.encode({ ok: true }));
    stream.end(Buffer.from('{"partial":'));
    await new Promise<void>((resolve) => stream.on("end", () => resolve()));
    expect(frames).toEqual(['{"ok":true}']);
  });

  it("rejects an incoming frame larger than the cap with FRAME_TOO_LARGE", async () => {
    const stream = new FrameCodec();
    const errorPromise = new Promise<FrameError>((resolve) => {
      stream.on("error", (error: Error) => resolve(error as FrameError));
    });
    const oversized = Buffer.from("x".repeat(MAX_IPC_FRAME_BYTES + 1) + "\n");
    stream.write(oversized);
    const error = await errorPromise;
    expect(error).toBeInstanceOf(FrameError);
    expect(error.code).toBe("FRAME_TOO_LARGE");
  });

  it("honours a custom max frame size", async () => {
    const stream = new FrameCodec(16);
    const errorPromise = new Promise<FrameError>((resolve) => {
      stream.on("error", (error: Error) => resolve(error as FrameError));
    });
    stream.write(Buffer.from("this line is longer than sixteen bytes\n"));
    const error = await errorPromise;
    expect(error).toBeInstanceOf(FrameError);
    expect(error.code).toBe("FRAME_TOO_LARGE");
  });

  it("rejects an outgoing frame larger than the cap with FRAME_TOO_LARGE", () => {
    expect(() => FrameCodec.encode({ payload: "x".repeat(MAX_IPC_FRAME_BYTES + 1) })).toThrowError(
      expect.objectContaining({ code: "FRAME_TOO_LARGE" })
    );
  });

  it("rejects a non-serializable outgoing message with FRAME_INVALID", () => {
    expect(() => FrameCodec.encode(() => {})).toThrowError(
      expect.objectContaining({ code: "FRAME_INVALID" })
    );
  });
});
