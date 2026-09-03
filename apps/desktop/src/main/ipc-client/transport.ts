import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";

/**
 * Connection abstraction of the IPC client. The client owns the returned
 * `Duplex` privately and never exposes it to the Renderer or Preload. The real
 * transport is a Windows Named Pipe via `node:net`; tests inject an in-process
 * duplex pair (or a fake socket) through {@link createDuplexTransport}.
 */

export interface IpcClientTransport {
  connect(): Promise<Duplex>;
}

/** Real transport: connects to the per-user Windows Named Pipe path. */
export function createNetPipeTransport(pipePath: string): IpcClientTransport {
  return {
    connect(): Promise<Duplex> {
      return new Promise((resolve, reject) => {
        const socket = netConnect(pipePath);
        socket.setNoDelay(true);
        socket.once("connect", () => resolve(socket));
        socket.once("error", (error) => {
          socket.destroy();
          reject(error);
        });
      });
    }
  };
}

/**
 * Test transport: resolves to a caller-provided `Duplex` (an in-process pair
 * from the Runner, or a fake socket). The factory is invoked per connection
 * attempt, so reconnect scenarios can hand out fresh pairs.
 */
export function createDuplexTransport(
  connect: () => Promise<Duplex> | Duplex
): IpcClientTransport {
  return {
    connect(): Promise<Duplex> {
      return Promise.resolve(connect());
    }
  };
}
