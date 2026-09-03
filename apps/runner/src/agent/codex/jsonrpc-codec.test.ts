import { describe, expect, it } from "vitest";

import {
  decodeJsonRpcLine,
  encodeJsonRpcLine,
  JsonRpcCodecError,
  splitJsonRpcChunk,
  type JsonRpcMessage
} from "./jsonrpc-codec.js";

describe("JsonRpcCodec (0.147.0 used subset)", () => {
  it("encodes requests / notifications / responses / error responses without inventing a wire version", () => {
    // The encoded line is the exact wire JSON: NO `jsonrpc` version field is
    // ever invented (the 0.147.0 envelopes carry none).
    expect(encodeJsonRpcLine({ id: 1, method: "initialize", params: { a: 1 } })).toBe(
      '{"id":1,"method":"initialize","params":{"a":1}}'
    );
    expect(encodeJsonRpcLine({ method: "initialized" })).toBe('{"method":"initialized"}');
    expect(encodeJsonRpcLine({ id: "sw-1", result: { thread: { id: "t" } } })).toBe(
      '{"id":"sw-1","result":{"thread":{"id":"t"}}}'
    );
    expect(
      encodeJsonRpcLine({ id: 2, error: { code: -32601, message: "method not found" } })
    ).toBe('{"id":2,"error":{"code":-32601,"message":"method not found"}}');
  });

  it("decodes every envelope kind of the used subset", () => {
    expect(decodeJsonRpcLine('{"id":1,"method":"thread/start"}')).toEqual({
      kind: "request",
      message: { id: 1, method: "thread/start" }
    });
    expect(decodeJsonRpcLine('{"method":"turn/started","params":{"x":1}}')).toEqual({
      kind: "notification",
      message: { method: "turn/started", params: { x: 1 } }
    });
    expect(decodeJsonRpcLine('{"id":3,"result":true}')).toEqual({
      kind: "response",
      message: { id: 3, result: true }
    });
    expect(decodeJsonRpcLine('{"id":4,"error":{"code":-1,"message":"boom"}}')).toEqual({
      kind: "error_response",
      message: { id: 4, error: { code: -1, message: "boom" } }
    });
  });

  it("rejects malformed envelopes with the structured codec error", () => {
    const cases: Array<[string, string]> = [
      ["not json", "MALFORMED"],
      ["42", "MALFORMED"],
      ['"str"', "MALFORMED"],
      ["[]", "MALFORMED"],
      ['{"id":null,"method":"x"}', "MALFORMED"], // RequestId is never null
      ['{"id":1.5,"method":"x"}', "MALFORMED"], // non-integer id
      ['{"id":true,"method":"x"}', "MALFORMED"],
      ['{"method":""}', "MALFORMED"], // empty method
      ['{"id":1}', "MALFORMED"], // id without method/result/error
      ['{"id":1,"result":1,"error":{"code":1,"message":"m"}}', "MALFORMED"], // ambiguous
      ['{"id":1,"result":1,"method":"x"}', "MALFORMED"],
      ['{"id":1,"error":{"message":"no code"}}', "MALFORMED"],
      ['{"id":1,"error":{"code":1}}', "MALFORMED"], // missing message
      ['{"id":"a","error":{"code":1,"message":"m"},"result":1}', "MALFORMED"]
    ];
    for (const [line, code] of cases) {
      try {
        decodeJsonRpcLine(line);
        expect.unreachable(`expected ${line} to be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(JsonRpcCodecError);
        if (!(error instanceof JsonRpcCodecError)) throw new Error("expected JsonRpcCodecError", { cause: error });
        expect(error.code).toBe(code);
      }
    }
  });

  it("rejects an oversized line before parsing it", () => {
    const huge = `{"id":1,"method":"x","params":"${"a".repeat(64)}"}`;
    expect(() => decodeJsonRpcLine(huge, 32)).toThrowError(
      expect.objectContaining({ code: "OVERSIZED" })
    );
    expect(() => encodeJsonRpcLine({ id: 1, method: "x", params: "b".repeat(64) }, 32)).toThrowError(
      expect.objectContaining({ code: "OVERSIZED" })
    );
  });

  it("rejects an encoded envelope that is not a well-formed message", () => {
    // Deliberately malformed envelopes enter the typed encoder through parsed
    // JSON (the same shape a caller could construct at runtime).
    const asMessage = (json: string): JsonRpcMessage => JSON.parse(json) as JsonRpcMessage;
    expect(() => encodeJsonRpcLine(asMessage("{}"))).toThrowError(JsonRpcCodecError);
    expect(() => encodeJsonRpcLine(asMessage('{"id":null,"method":"x"}'))).toThrowError(
      JsonRpcCodecError
    );
    expect(() =>
      encodeJsonRpcLine(asMessage('{"id":1,"method":"x","result":1}'))
    ).toThrowError(JsonRpcCodecError);
  });

  it("splits NDJSON chunks at line boundaries and keeps the partial tail", () => {
    const chunk = '{"id":1,"method":"a"}\n{"id":2,"method":"b"}\r\n{"id":3,"m';
    const split = splitJsonRpcChunk(chunk);
    expect(split.lines).toEqual([
      '{"id":1,"method":"a"}',
      '{"id":2,"method":"b"}' // trailing \r stripped
    ]);
    expect(split.remainder).toBe('{"id":3,"m');

    // The incomplete tail is PREPENDED to the next incoming chunk.
    const finished = splitJsonRpcChunk(split.remainder + 'ethod":"c"}\n');
    expect(finished.lines).toEqual(['{"id":3,"method":"c"}']);
    expect(finished.remainder).toBe("");
  });

  it("rejects an oversized complete line during chunk splitting", () => {
    const chunk = `{"id":1,"method":"${"a".repeat(128)}"}\n`;
    expect(() => splitJsonRpcChunk(chunk, 64)).toThrowError(
      expect.objectContaining({ code: "OVERSIZED" })
    );
    // An incomplete tail is never size-checked yet (it is not a complete line).
    const partial = splitJsonRpcChunk("x".repeat(1024), 64);
    expect(partial.lines).toEqual([]);
    expect(partial.remainder.length).toBe(1024);
  });
});
