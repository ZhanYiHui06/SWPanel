/**
 * Copy the repository Python PDFium rasterization helper into the compiled
 * runner dist so the packaged app ships it (Electron Forge packages
 * `apps/runner/dist/**` into the asar; `scripts/audit-asar.mjs` verifies the
 * helper entry is present). The helper is invoked as a real child-process
 * script by `PythonPdfiumRasterizer` (see
 * `src/adaptation/python-pdfium-rasterizer.ts`), so it must exist as a REAL
 * file next to the compiled JavaScript.
 */

import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runnerRoot = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(
  runnerRoot,
  "src",
  "adaptation",
  "pdfium-rasterizer-helper.py"
);
const targetDir = path.join(runnerRoot, "dist", "adaptation");
const target = path.join(targetDir, "pdfium-rasterizer-helper.py");

await mkdir(targetDir, { recursive: true });
await cp(source, target);
console.log(`Copied ${path.relative(runnerRoot, source)} -> ${path.relative(runnerRoot, target)}`);
