import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

export class DataRootLockedError extends Error {
  constructor(readonly pid: number) {
    super(`数据目录已被另一个 SWPanel 服务占用（进程 ${pid}）。请先停止该服务，或使用不同的 SWPANEL_DATA_ROOT。`);
    this.name = "DataRootLockedError";
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Single-instance guard for one data root: exclusive `server.lock` holding the owner pid.
 * A lock whose pid is not alive (or unreadable) is stale and is taken over.
 * Returns an idempotent release function.
 */
export function acquireDataRootLock(dataRoot: string): () => void {
  const file = join(dataRoot, "server.lock");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      try { writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); }
      finally { closeSync(fd); }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          const owner = (JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown }).pid;
          if (owner === process.pid) rmSync(file, { force: true });
        } catch {
          // Already removed or replaced by a newer owner.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let pid = -1;
    try {
      const parsed = (JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown }).pid;
      if (typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0) pid = parsed;
    } catch {
      // Unreadable or partially written lock: treated as stale below unless a live pid is found.
    }
    if (pid > 0 && pid !== process.pid && processAlive(pid)) throw new DataRootLockedError(pid);
    rmSync(file, { force: true });
  }
  throw new Error("无法获取数据目录锁，请稍后重试");
}
