import { describe, expect, it } from "vitest";

import { COMMAND_NAMES, type Command } from "./commands.js";

describe("command contract", () => {
  it("defines the canonical command names", () => {
    expect(COMMAND_NAMES).toEqual([
      "drawing.create",
      "drawing.createRevision",
      "drawing.setCurrentRevision",
      "drawing.addRevisionFact",
      "drawing.addModelingFeedback",
      "drawing.deleteRevision",
      "run.create",
      "run.cancel",
      "run.delete",
      "clarification.submit",
      "model.review",
      "model.openInSolidWorks",
      "costData.update",
      "costReport.create",
      "costReport.delete",
      "storage.updateSettings",
      "secrets.setApiKey",
      "secrets.getApiKeyStatus",
      "secrets.clearApiKey",
      "system.getRecoveryStatus"
    ]);
  });

  it("accepts a run.create command carrying only the drawing/revision pair", () => {
    // The Renderer submits only the identity pair; the Runner freezes the
    // input snapshot in its own transaction, so the command cannot carry one.
    const command: Command = {
      command: "run.create",
      drawingId: "drawing-1",
      revisionId: "rev-3"
    };
    expect(command.command).toBe("run.create");
    expect(command.drawingId).toBe("drawing-1");
    expect(command.revisionId).toBe("rev-3");
    expect("inputSnapshot" in command).toBe(false);
    expect(JSON.parse(JSON.stringify(command))).toEqual(command);
  });

  it("accepts a drawing.create command with only file-library metadata (no Run implied)", () => {
    const command: Command = {
      command: "drawing.create",
      drawingNumber: "PDJF999.01.01",
      name: "测试图纸",
      sourceFile: {
        fileName: "PDJF999.01.01.pdf",
        format: "PDF",
        sizeBytes: 2_048_000,
        sha256: "b".repeat(64)
      },
      createdAt: "2026-08-12T10:00:00.000Z",
      createdBy: "user-1"
    };
    expect(command.command).toBe("drawing.create");
    // The command carries no run input snapshot and no run fields.
    expect("inputSnapshot" in command).toBe(false);
    expect(JSON.parse(JSON.stringify(command))).toEqual(command);
  });

  it("accepts a drawing.addRevisionFact command referencing a canonical fact source", () => {
    const command: Command = {
      command: "drawing.addRevisionFact",
      drawingId: "drawing-1",
      revisionId: "rev-3",
      field: "中心孔深度",
      value: "85 mm",
      source: "USER_SUPPLEMENT",
      createdAt: "2026-08-12T10:05:00.000Z"
    };
    expect(command.command).toBe("drawing.addRevisionFact");
    expect(JSON.parse(JSON.stringify(command))).toEqual(command);
  });

  it("accepts a storage.updateSettings command with the constrained data root", () => {
    const command: Command = {
      command: "storage.updateSettings",
      settings: {
        dataRoot: "C:\\Users\\engineer\\AppData\\Local\\JANGHI\\SWPanel",
        workspaceRoot: "C:\\Users\\engineer\\AppData\\Local\\JANGHI\\SWPanel\\workspaces",
        constraint: "LOCAL_FIXED_NTFS",
        updatedAt: "2026-08-12T11:00:00.000Z"
      }
    };
    expect(command.command).toBe("storage.updateSettings");
    expect(JSON.parse(JSON.stringify(command))).toEqual(command);
  });

  it("serializes commands as plain JSON", () => {
    const command: Command = {
      command: "model.review",
      modelId: "model-1",
      result: "REJECTED",
      comment: "右侧台阶直径错误",
      reviewerId: "user-1",
      reviewedAt: "2026-08-10T13:00:00.000Z"
    };
    expect(JSON.parse(JSON.stringify(command))).toEqual(command);
  });
});
