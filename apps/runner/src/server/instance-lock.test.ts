import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDataRootLock, DataRootLockedError } from "./instance-lock.js";

const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), "swpanel-lock-")); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("data root single-instance lock", () => {
  it("rejects a second holder while the owner is alive and releases idempotently", () => {
    const dataRoot = root();
    // Pid 1 (init) is alive and not this process, standing in for another running server.
    writeFileSync(join(dataRoot, "server.lock"), JSON.stringify({ pid: 1 }));
    expect(() => acquireDataRootLock(dataRoot)).toThrow(DataRootLockedError);
  });
  it("acquires, blocks nothing after release, and can be re-acquired", () => {
    const dataRoot = root();
    const release = acquireDataRootLock(dataRoot);
    expect(existsSync(join(dataRoot, "server.lock"))).toBe(true);
    release();
    release();
    expect(existsSync(join(dataRoot, "server.lock"))).toBe(false);
    acquireDataRootLock(dataRoot)();
  });
  it("takes over stale and corrupt locks", () => {
    const dataRoot = root();
    writeFileSync(join(dataRoot, "server.lock"), JSON.stringify({ pid: 2 ** 22 + 12345 }));
    acquireDataRootLock(dataRoot)();
    writeFileSync(join(dataRoot, "server.lock"), "not json");
    acquireDataRootLock(dataRoot)();
  });
});
