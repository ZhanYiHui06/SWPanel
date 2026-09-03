import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHash } from "node:crypto";

/**
 * Creates a disposable directory under the OS temp dir. Callers must remove it
 * in `afterAll`/`finally` so no test leaks runtime data.
 */
export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `swpanel-${prefix}-`));
}

/** Removes a directory tree created by `makeTempDir`. */
export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** SHA-256 hex digest of a byte buffer. */
export function sha256Of(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Sample PDF-ish bytes (non-empty, deterministic). */
export function samplePdfBytes(): Buffer {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
      `%%EOF\nSWPanel test drawing fixture, deterministic bytes.\n`
  );
}

/** Sample DWG-ish bytes. */
export function sampleDwgBytes(): Buffer {
  return Buffer.from(
    `AC1015\0` + `SWPanel test DWG fixture bytes, deterministic.\n`.repeat(4)
  );
}
