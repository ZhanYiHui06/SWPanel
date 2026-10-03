import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Runner } from "../runner.js";
import { makeTempDir, removeTempDir } from "../test-utils.js";

describe("immutable drawing source access", () => {
  it("binds the revision identity and verifies stored bytes on every read", () => {
    const root = makeTempDir("drawing-source-read");
    const runner = new Runner(root); runner.open();
    try {
      const sourcePath = join(root, "original.pdf"); writeFileSync(sourcePath, "%PDF-1.4 test");
      const { drawing, revision } = runner.importDrawing({ drawingNumber: "SRC-1", name: "Source test", sourceFile: { sourcePath, fileName: "test.pdf", format: "PDF", uploadedAt: "2026-08-18T01:00:00.000Z" }, createdAt: "2026-08-18T01:00:00.000Z" });
      expect(runner.readDrawingSource(drawing.id, revision.id)).toMatchObject({ fileName: "test.pdf", mimeType: "application/pdf", content: Buffer.from("%PDF-1.4 test") });
      expect(() => runner.readDrawingSource("another-drawing", revision.id)).toThrow(/not found/);
      writeFileSync(runner.resolveLedgerPath(revision.sourceFile.relativePath), "%PDF-1.4 evil");
      expect(() => runner.readDrawingSource(drawing.id, revision.id)).toThrow(/mismatch/);
    } finally { runner.close(); removeTempDir(root); }
  });
});
