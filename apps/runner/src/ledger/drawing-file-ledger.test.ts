import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DrawingFileLedger,
  DRAWING_MIME_TYPES,
  DRAWING_LIBRARY_RELATIVE_DIR
} from "./drawing-file-ledger.js";
import {
  LedgerEscapeDetectedError,
  LedgerFileMissingError,
  LedgerHashMismatchError,
  LedgerPathUnsafeError,
  LedgerSizeMismatchError
} from "../errors.js";
import { makeTempDir, removeTempDir, samplePdfBytes, sha256Of } from "../test-utils.js";

describe("DrawingFileLedger", () => {
  let dir: string;
  let sourceDir: string;
  let ledger: DrawingFileLedger;

  beforeAll(() => {
    dir = makeTempDir("ledger");
    sourceDir = join(dir, "sources");
    mkdirSync(sourceDir, { recursive: true });
    ledger = new DrawingFileLedger({ dataRoot: dir });
    ledger.open();
  });
  afterAll(() => {
    ledger.close();
    removeTempDir(dir);
  });

  it("stores a file into a generated-id directory and returns canonical metadata", () => {
    const content = samplePdfBytes();
    const sourcePath = join(sourceDir, "图纸-A.pdf");
    writeFileSync(sourcePath, content);

    const stored = ledger.storeSourceFile({
      sourcePath,
      fileName: "图纸-A.pdf",
      format: "PDF",
      uploadedAt: "2026-08-12T00:00:00.000Z"
    });

    expect(stored.fileId).toMatch(/^[0-9a-f-]{36}$/);
    expect(stored.relativePath).toBe(`${DRAWING_LIBRARY_RELATIVE_DIR}/${stored.fileId}/source/original.pdf`);
    expect(stored.sizeBytes).toBe(content.byteLength);
    expect(stored.sha256).toBe(sha256Of(content));
    expect(ledger.toAbsolute(stored.relativePath)).toBe(stored.absolutePath);
    expect(existsSync(stored.absolutePath)).toBe(true);

    // Round-trip verification passes.
    const verification = ledger.verifyStoredFile(stored.absolutePath, stored.relativePath, stored.sizeBytes, stored.sha256);
    expect(verification.ok).toBe(true);
  });

  it("rejects a declared hash that does not match the source bytes", () => {
    const content = samplePdfBytes();
    const sourcePath = join(sourceDir, "badhash.pdf");
    writeFileSync(sourcePath, content);

    expect(() =>
      ledger.storeSourceFile({
        sourcePath,
        fileName: "badhash.pdf",
        format: "PDF",
        sha256: "f".repeat(64),
        uploadedAt: "2026-08-12T00:00:00.000Z"
      })
    ).toThrowError(LedgerHashMismatchError);
  });

  it("rejects a declared size that does not match the source bytes", () => {
    const content = samplePdfBytes();
    const sourcePath = join(sourceDir, "badsize.dxf");
    writeFileSync(sourcePath, content);

    expect(() =>
      ledger.storeSourceFile({
        sourcePath,
        fileName: "badsize.dxf",
        format: "DXF",
        sizeBytes: content.byteLength + 5,
        uploadedAt: "2026-08-12T00:00:00.000Z"
      })
    ).toThrowError(LedgerSizeMismatchError);
  });

  it("rejects an unsupported format and a mismatched file extension", () => {
    const sourcePath = join(sourceDir, "drawing.txt");
    writeFileSync(sourcePath, "plain text");

    expect(() =>
      ledger.storeSourceFile({
        sourcePath,
        fileName: "drawing.txt",
        format: "PDF",
        uploadedAt: "2026-08-12T00:00:00.000Z"
      })
    ).toThrowError(/extension does not match/);
  });

  it("reports a structured error when the source file is missing", () => {
    expect(() =>
      ledger.storeSourceFile({
        sourcePath: join(sourceDir, "does-not-exist.pdf"),
        fileName: "does-not-exist.pdf",
        format: "PDF",
        uploadedAt: "2026-08-12T00:00:00.000Z"
      })
    ).toThrowError(LedgerFileMissingError);
  });

  it("reports a structured error when a stored file has been deleted", () => {
    const content = samplePdfBytes();
    const sourcePath = join(sourceDir, "verify-missing.dwg");
    writeFileSync(sourcePath, content);
    const stored = ledger.storeSourceFile({
      sourcePath,
      fileName: "verify-missing.dwg",
      format: "DWG",
      uploadedAt: "2026-08-12T00:00:00.000Z"
    });
    ledger.deleteOwnedFile(stored.relativePath);

    const verification = ledger.verifyStoredFile(stored.absolutePath, stored.relativePath, stored.sizeBytes, stored.sha256);
    expect(verification.ok).toBe(false);
    expect(verification.ok === false && verification.error).toBeInstanceOf(LedgerFileMissingError);
  });

  it("rejects relative paths with traversal, absolute and drive segments", () => {
    for (const bad of ["../escape.pdf", "..\\escape.pdf", ".\\x.pdf", "a/b/../../c.pdf"]) {
      expect(() => ledger.toAbsolute(bad)).toThrowError(LedgerPathUnsafeError);
    }
    expect(() => ledger.toAbsolute("C:\\windows\\x.pdf")).toThrowError(LedgerPathUnsafeError);
    expect(() => ledger.toAbsolute("C:/windows/x.pdf")).toThrowError(LedgerPathUnsafeError);
    expect(() => ledger.toAbsolute("/etc/passwd")).toThrowError(LedgerPathUnsafeError);
  });

  it("rejects symlink/junction components inside the library (traversal escape)", () => {
    const content = samplePdfBytes();
    const sourcePath = join(sourceDir, "real.pdf");
    writeFileSync(sourcePath, content);

    // Pre-create the library root itself as a junction pointing outside the
    // data root. Because `library/drawings` is a fixed component of every
    // ledger path, the store must refuse to write through it.
    const libraryRoot = join(dir, DRAWING_LIBRARY_RELATIVE_DIR);
    const targetDir = join(dir, "outside");
    mkdirSync(targetDir, { recursive: true });
    try {
      symlinkSync(targetDir, libraryRoot, "junction");
    } catch {
      // Windows: creating a junction requires Developer Mode or elevated
      // privileges; when unavailable, skip this escape assertion rather than
      // failing the machine state.
      return;
    }

    expect(() =>
      ledger.storeSourceFile({
        sourcePath,
        fileName: "real.pdf",
        format: "PDF",
        uploadedAt: "2026-08-12T00:00:00.000Z"
      })
    ).toThrowError(LedgerEscapeDetectedError);
  });

  it("refuses to delete outside the drawing library allowlist", () => {
    expect(() => ledger.deleteOwnedFile("state/swpanel.db")).toThrowError(LedgerPathUnsafeError);
    expect(() => ledger.deleteOwnedFile("library/other/file.pdf")).toThrowError(LedgerPathUnsafeError);
  });

  it("reports a structured error when deleting a missing allowlisted file", () => {
    const relative = `${DRAWING_LIBRARY_RELATIVE_DIR}/ffffffff-0000-0000-0000-000000000000/source/original.pdf`;
    expect(() => ledger.deleteOwnedFile(relative)).toThrowError(LedgerFileMissingError);
  });

  it("deletes an owned stored file inside the allowlist", () => {
    const content = samplePdfBytes();
    const sourcePath = join(sourceDir, "delete-me.pdf");
    writeFileSync(sourcePath, content);
    const stored = ledger.storeSourceFile({
      sourcePath,
      fileName: "delete-me.pdf",
      format: "PDF",
      uploadedAt: "2026-08-12T00:00:00.000Z"
    });
    expect(existsSync(stored.absolutePath)).toBe(true);

    ledger.deleteOwnedFile(stored.relativePath);
    expect(existsSync(stored.absolutePath)).toBe(false);
  });

  it("maps the allowlisted formats to MIME types", () => {
    expect(DRAWING_MIME_TYPES).toEqual({
      PDF: "application/pdf",
      DWG: "application/acad",
      DXF: "application/dxf"
    });
  });

  it("verifies a tampered stored file and reports a hash mismatch", () => {
    const content = samplePdfBytes();
    const sourcePath = join(sourceDir, "tamper.pdf");
    writeFileSync(sourcePath, content);
    const stored = ledger.storeSourceFile({
      sourcePath,
      fileName: "tamper.pdf",
      format: "PDF",
      uploadedAt: "2026-08-12T00:00:00.000Z"
    });

    // Tamper with a stored byte in place, keeping the file size unchanged so
    // the size check stays green and only the hash verification can fail.
    const corrupted = Buffer.from(readFileSync(stored.absolutePath));
    corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] as number) ^ 0xff;
    writeFileSync(stored.absolutePath, corrupted);

    const verification = ledger.verifyStoredFile(stored.absolutePath, stored.relativePath, stored.sizeBytes, stored.sha256);
    expect(verification.ok).toBe(false);
    expect(verification.ok === false && verification.error).toBeInstanceOf(LedgerHashMismatchError);
  });
});
