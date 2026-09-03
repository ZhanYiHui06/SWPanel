import { Duplex } from "node:stream";

/**
 * In-process `net.Socket`-compatible transport used for unit tests and the
 * in-process Runner host (WP4): a pair of byte-mode `Duplex` streams wired in
 * both directions. The pipe server attaches its {@link FrameCodec} to each end
 * exactly as it does to a real socket, so protocol validation, idempotency and
 * the handshake are exercised without a Windows pipe.
 *
 * The two ends are coupled ONE-DIRECTIONALLY: bytes written to one end are
 * delivered to the OTHER end's readable side (exactly one crossing, mirroring
 * a real socket pair). The receiving end never echoes them back, so the
 * forward loop that a naive "forward every data event in both directions"
 * design produces cannot happen.
 */

export interface DuplexPipePair {
  server: Duplex;
  client: Duplex;
}

/**
 * Creates a connected pair of framing duplexes. `server` is fed to
 * {@link IpcServer.attach}; `client` is fed to the client side (IpcClient in
 * tests, or the host-side proxy in the in-process adapter).
 */
export function createDuplexPipePair(): DuplexPipePair {
  const server = new BufferedDuplex();
  const client = new BufferedDuplex();
  server.setPeer(client);
  client.setPeer(server);
  return { server, client };
}

/**
 * Byte-mode Duplex whose writable side forwards straight into its peer's
 * readable side. Queued bytes are only pushed once a consumer exists, and an
 * end on one side ends the other once its queue drains.
 */
class BufferedDuplex extends Duplex {
  private queue: Buffer[] = [];
  private ended = false;
  private peer: BufferedDuplex | null = null;

  constructor() {
    super();
    // Destroying one end signals EOF to the other end, mirroring how a real
    // socket close surfaces as `end` on the peer.
    this.once("close", () => {
      this.peer?.deliverEnd();
    });
  }

  /** Binds the peer this end forwards its writes into. */
  setPeer(peer: BufferedDuplex): void {
    this.peer = peer;
  }

  override _read(): void {
    while (this.queue.length > 0) {
      const frame = this.queue.shift();
      if (frame === undefined) break;
      if (!this.push(frame)) break;
    }
    if (this.ended && this.queue.length === 0) {
      this.push(null);
    }
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    if (this.ended) {
      callback();
      return;
    }
    this.peer?.deliver(Buffer.from(chunk));
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.ended = true;
    callback();
    // EOF must reach the peer once everything queued has been pushed out.
    this._read();
    this.peer?.deliverEnd();
  }

  /** Delivers bytes received from the peer into this end's readable side. */
  private deliver(chunk: Buffer): void {
    if (this.ended) return;
    this.queue.push(Buffer.from(chunk));
    this._read();
  }

  /** Marks this end ended; the readable side ends once the queue drains. */
  private deliverEnd(): void {
    if (this.ended) return;
    this.ended = true;
    this._read();
  }
}
