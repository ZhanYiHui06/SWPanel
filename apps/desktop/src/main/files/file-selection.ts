/**
 * Drawing file selection (WP5).
 *
 * The ONLY way the Renderer can pick a PDF/DWG/DXF source file is the native
 * `dialog.showOpenDialog` opened by Main. Main validates the chosen file
 * (exactly one file, supported extension, local regular file, no symlink /
 * reparse / UNC / network, under the size cap), computes SHA-256 + size,
 * registers the source with the Runner and stages it in the one-use registry.
 * The Renderer only ever receives the opaque {@link SelectedDrawingFile} token
 * and metadata — never the absolute source path.
 *
 * The validation core is pure and injectable (`lstat` / read stream) so every
 * rejection branch is unit-tested without special filesystem privileges.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Stats } from "node:fs";
import { lstat as fsLstat } from "node:fs/promises";
import path from "node:path";

import type { DrawingFileFormat } from "@swpanel/domain";

import {
  bridgeErr,
  bridgeOk,
  type BridgeResult,
  type SelectDrawingFileResult,
  type SelectedDrawingFile
} from "../bridge/bridge-contract.js";
import { isUncOrNetworkPath } from "../bridge/runtime-root.js";
import type { SelectedFileRegistry } from "./selected-file-registry.js";

/** Sensible size cap for a user-picked drawing file (200 MiB). */
export const MAX_DRAWING_FILE_SIZE_BYTES = 200 * 1024 * 1024;

/** Supported drawing extensions (case-insensitive) with their canonical format. */
export const SELECTED_DRAWING_EXTENSIONS: Readonly<Record<DrawingFileFormat, string>> = {
  PDF: ".pdf",
  DWG: ".dwg",
  DXF: ".dxf"
};

/** File dialog filter shown to the user. */
export const DRAWING_FILE_DIALOG_FILTER = {
  name: "图纸文件 (PDF/DWG/DXF)",
  extensions: ["pdf", "dwg", "dxf"]
} as const;

export interface ValidatedDrawingFile {
  readonly absolutePath: string;
  readonly fileName: string;
  readonly format: DrawingFileFormat;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export type FileSelectionOutcome =
  | { readonly ok: true; readonly file: ValidatedDrawingFile }
  | {
      readonly ok: false;
      readonly code:
        | "FILE_PATH_UNSAFE"
        | "FILE_UNSUPPORTED_FORMAT"
        | "FILE_NOT_REGULAR"
        | "FILE_SYMLINK"
        | "FILE_TOO_LARGE"
        | "FILE_UNREADABLE";
      readonly message: string;
    };

type FileSelectionFailureCode = Extract<FileSelectionOutcome, { ok: false }>["code"];

function fail(code: FileSelectionFailureCode, message: string): FileSelectionOutcome {
  return { ok: false, code, message };
}

/** Injectable filesystem surface for tests. */
export interface FileValidationDependencies {
  lstat?: (candidate: string) => Promise<Stats>;
  /** Reads the file content for hashing; defaults to a read stream. */
  readFileContent?: (candidate: string) => Promise<Buffer>;
}

async function hashFile(
  candidate: string,
  deps: Required<Pick<FileValidationDependencies, "readFileContent">>
): Promise<{ sha256: string; sizeBytes: number }> {
  const content = await deps.readFileContent(candidate);
  const hash = createHash("sha256");
  hash.update(content);
  return { sha256: hash.digest("hex"), sizeBytes: content.byteLength };
}

function defaultReadFileContent(candidate: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let size = 0;
    const stream = createReadStream(candidate);
    stream.on("data", (chunk: string | Buffer) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      hash.update(buffer);
      chunks.push(buffer);
      size += buffer.length;
    });
    stream.on("end", () => resolve(Buffer.concat(chunks, size)));
    stream.on("error", reject);
  });
}

/**
 * Validates and hashes a candidate drawing file path. Every rejection maps to a
 * stable code. The path must be an absolute LOCAL path to a regular file with a
 * supported extension and under the size cap; symlinks/junctions (which Node
 * reports as symbolic links) and network/UNC paths are refused.
 */
export async function validateAndHashDrawingFile(
  candidate: string,
  deps: FileValidationDependencies = {}
): Promise<FileSelectionOutcome> {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0")) {
    return fail("FILE_PATH_UNSAFE", "选择路径无效");
  }
  if (!path.isAbsolute(candidate)) {
    return fail("FILE_PATH_UNSAFE", "选择路径必须是绝对路径");
  }
  if (isUncOrNetworkPath(candidate)) {
    return fail("FILE_PATH_UNSAFE", "不支持网络路径或 UNC 路径");
  }

  const extension = path.extname(candidate).toLowerCase();
  const formatEntry = (Object.entries(SELECTED_DRAWING_EXTENSIONS) as Array<
    [DrawingFileFormat, string]
  >).find(([, ext]) => ext === extension);
  if (formatEntry === undefined) {
    return fail("FILE_UNSUPPORTED_FORMAT", "仅支持 PDF / DWG / DXF 格式");
  }

  const lstat = deps.lstat ?? fsLstat;
  let stats: Stats;
  try {
    stats = await lstat(candidate);
  } catch {
    return fail("FILE_UNREADABLE", "无法读取所选文件");
  }
  if (stats.isSymbolicLink()) {
    return fail("FILE_SYMLINK", "不支持符号链接或 junction 文件");
  }
  if (!stats.isFile()) {
    return fail("FILE_NOT_REGULAR", "所选路径不是常规文件");
  }
  if (stats.size > MAX_DRAWING_FILE_SIZE_BYTES) {
    return fail("FILE_TOO_LARGE", "所选文件超过大小上限");
  }

  let digest: { sha256: string; sizeBytes: number };
  try {
    digest = await hashFile(candidate, {
      readFileContent: deps.readFileContent ?? defaultReadFileContent
    });
  } catch {
    return fail("FILE_UNREADABLE", "无法读取所选文件");
  }
  if (digest.sizeBytes > MAX_DRAWING_FILE_SIZE_BYTES) {
    return fail("FILE_TOO_LARGE", "所选文件超过大小上限");
  }

  return {
    ok: true,
    file: {
      absolutePath: candidate,
      fileName: path.basename(candidate),
      format: formatEntry[0],
      sizeBytes: digest.sizeBytes,
      sha256: digest.sha256
    }
  };
}

/** Minimal `dialog` surface consumed by the picker (injectable for tests). */
export interface OpenDialogLike {
  showOpenDialog(
    options: unknown
  ): Promise<{ canceled: boolean; filePaths: string[] }>;
  showOpenDialog(
    browserWindow: unknown,
    options: unknown
  ): Promise<{ canceled: boolean; filePaths: string[] }>;
}

/**
 * Adapter that maps the picker's `{ id }` parent handle to a REAL parent window
 * for the native dialog. Electron's `dialog.showOpenDialog` treats any first
 * argument that is not a `BaseWindow` as the OPTIONS object (silently dropping
 * the real options, including the PDF/DWG/DXF filter), so the picker must never
 * hand Electron a plain `{ id }` object. The adapter resolves the webContents id
 * to the parent window through the injectable resolver; when the window is gone
 * (or the picker was called unparented) it opens the dialog WITHOUT a parent
 * while always passing the REAL options object.
 */
export interface WindowedDialogAdapterDependencies {
  /** The real Electron dialog (or a test fake). */
  dialog: {
    showOpenDialog(
      options: unknown
    ): Promise<{ canceled: boolean; filePaths: string[] }>;
    showOpenDialog(
      browserWindow: unknown,
      options: unknown
    ): Promise<{ canceled: boolean; filePaths: string[] }>;
  };
  /** Resolves a webContents id to the parent window object (or undefined). */
  resolveWindow: (webContentsId: number) => unknown;
}

export function createWindowedDialogAdapter(
  deps: WindowedDialogAdapterDependencies
): OpenDialogLike {
  return {
    showOpenDialog(
      first: unknown,
      second?: unknown
    ): Promise<{ canceled: boolean; filePaths: string[] }> {
      if (second === undefined) {
        // Single-argument call: the first argument IS the options object.
        return deps.dialog.showOpenDialog(first);
      }
      const webContentsId = (first as { id?: unknown } | null)?.id;
      const parentWindow =
        typeof webContentsId === "number"
          ? deps.resolveWindow(webContentsId)
          : undefined;
      return parentWindow === undefined
        ? deps.dialog.showOpenDialog(second)
        : deps.dialog.showOpenDialog(parentWindow, second);
    }
  };
}

export interface DrawingFilePickerDependencies {
  dialog: OpenDialogLike;
  registry: SelectedFileRegistry;
  /** Registers the validated source with the Runner (by sha256). */
  registerSourceFile: (sha256: string, absolutePath: string) => void;
  /**
   * Optional injection for tests; may return the outcome synchronously or as a
   * promise (the default real validator hashes the file asynchronously).
   */
  validate?: (candidate: string) => FileSelectionOutcome | Promise<FileSelectionOutcome>;
}

/**
 * Opens the native file dialog, validates exactly one selected file, hashes it,
 * registers it with the Runner and stages it in the one-use registry. Returns a
 * bridge result; the Renderer receives metadata only.
 */
export class DrawingFilePicker {
  constructor(private readonly deps: DrawingFilePickerDependencies) {}

  async select(
    browserWindow: { id: number } | null
  ): Promise<BridgeResult<SelectDrawingFileResult>> {
    const options = {
      title: "选择图纸文件",
      buttonLabel: "选择",
      properties: ["openFile"],
      filters: [DRAWING_FILE_DIALOG_FILTER]
    };
    const result =
      browserWindow === null
        ? await this.deps.dialog.showOpenDialog(options)
        : await this.deps.dialog.showOpenDialog(browserWindow, options);

    if (result.canceled) {
      return bridgeOk({ canceled: true, file: null });
    }
    if (result.filePaths.length !== 1) {
      return bridgeErr("SELECTION_INVALID", "请选择一个文件");
    }

    const validate = this.deps.validate ?? validateAndHashDrawingFile;
    const outcome = await validate(result.filePaths[0] as string);
    if (!outcome.ok) {
      return bridgeErr(outcome.code, outcome.message);
    }

    this.deps.registerSourceFile(outcome.file.sha256, outcome.file.absolutePath);
    const staged = this.deps.registry.stage(outcome.file);
    const file: SelectedDrawingFile = {
      token: staged.token,
      fileName: staged.fileName,
      format: staged.format,
      sizeBytes: staged.sizeBytes,
      sha256: staged.sha256
    };
    return bridgeOk({ canceled: false, file });
  }
}
