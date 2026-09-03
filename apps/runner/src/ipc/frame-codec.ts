/**
 * The newline-delimited JSON framing used over the Runner named pipe. The
 * implementation is the canonical shared wire contract in
 * `@swpanel/contracts` (see `framing.ts`); this module re-exports it so the
 * Runner's public surface keeps exporting `FrameCodec`, `FrameError` and
 * `MAX_IPC_FRAME_BYTES` from `@swpanel/runner` for existing hosts and tests.
 */

export { FrameCodec, FrameError, MAX_IPC_FRAME_BYTES } from "@swpanel/contracts";
