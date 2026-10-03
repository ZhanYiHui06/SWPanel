import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunRepository } from "../db/run-repository.js";
import { RunWorkspaceLedger } from "../ledger/run-workspace-ledger.js";
import { makeTempDir, removeTempDir } from "../test-utils.js";
import { readRegisteredArtifact } from "./registered-file.js";

describe("registered artifact files", () => {
  it("reads only owned files and rejects changed bytes, foreign runs and links", () => {
    const root = makeTempDir("registered-file");
    const workspace = new RunWorkspaceLedger({ workspaceRoot: root }); workspace.open();
    try {
      workspace.createAttemptWorkspace("run-1", 1);
      const stored = workspace.writeOwnedFile({ runId: "run-1", attemptSequence: 1, relativePath: "output/model.step", content: Buffer.from("CAD") });
      const metadata = { id: "a", runId: "run-1", kind: "STEP", fileName: "model.step", relativePath: stored.relativePath, sizeBytes: stored.sizeBytes, sha256: stored.sha256 };
      const runs = { getModelArtifact: (modelId: string) => modelId === "model-1" ? metadata : null } as unknown as RunRepository;
      expect(readRegisteredArtifact(runs, workspace, "model-1", "a").content.toString()).toBe("CAD");
      expect(() => readRegisteredArtifact(runs, workspace, "model-2", "a")).toThrow(/not found/);
      writeFileSync(stored.absolutePath, "BAD");
      expect(() => readRegisteredArtifact(runs, workspace, "model-1", "a")).toThrow(/integrity/);
      metadata.relativePath = "runs/run-2/attempt-001/output/model.step";
      expect(() => readRegisteredArtifact(runs, workspace, "model-1", "a")).toThrow(/outside/);
      metadata.relativePath = "/tmp/arbitrary";
      expect(() => readRegisteredArtifact(runs, workspace, "model-1", "a")).toThrow(/outside/);
      writeFileSync(join(root, "outside"), "CAD");
      symlinkSync(join(root, "outside"), join(workspace.workspaceLayout("run-1", 1).absoluteRoot, "output", "linked.step"));
      metadata.relativePath = "runs/run-1/attempt-001/output/linked.step";
      metadata.sha256 = createHash("sha256").update("CAD").digest("hex");
      expect(() => readRegisteredArtifact(runs, workspace, "model-1", "a")).toThrow(/symbolic link/);
    } finally { workspace.close(); removeTempDir(root); }
  });
});
