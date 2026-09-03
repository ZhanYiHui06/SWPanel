import { createHash } from "node:crypto";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { Stats } from "node:fs";

import {
  createWindowedDialogAdapter,
  DrawingFilePicker,
  MAX_DRAWING_FILE_SIZE_BYTES,
  validateAndHashDrawingFile,
  type FileValidationDependencies
} from "./file-selection.js";
import { SelectedFileRegistry } from "./selected-file-registry.js";

function sha256Of(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function fakeStats(overrides: Partial<Pick<Stats, "isFile" | "isSymbolicLink" | "size">>): Stats {
  const stats: Stats = {
    isFile: () => overrides.isFile ?? true,
    isSymbolicLink: () => overrides.isSymbolicLink ?? false,
    size: overrides.size ?? 0,
    isDirectory: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    dev: 0,
    ino: 0,
    mode: 0,
    nlink: 0,
    uid: 0,
    gid: 0,
    rdev: 0,
    blksize: 0,
    blocks: 0,
    atimeMs: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    birthtimeMs: 0,
    atime: new Date(),
    mtime: new Date(),
    ctime: new Date(),
    birthtime: new Date()
  };
  return stats;
}

function validationDeps(content: Buffer, lstat: Stats): FileValidationDependencies {
  return {
    lstat: () => Promise.resolve(lstat),
    readFileContent: () => Promise.resolve(content)
  };
}

describe("validateAndHashDrawingFile", () => {
  const content = Buffer.from("%PDF-1.4 test drawing bytes");
  const pdfPath = "C:\\users\\alice\\drawings\\PDJF001.pdf";

  it("accepts a local regular PDF and returns its sha256/size/format", async () => {
    const outcome = await validateAndHashDrawingFile(pdfPath, validationDeps(content, fakeStats({ size: content.length })));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.file.absolutePath).toBe(pdfPath);
      expect(outcome.file.format).toBe("PDF");
      expect(outcome.file.sizeBytes).toBe(content.length);
      expect(outcome.file.sha256).toBe(sha256Of(content));
      expect(outcome.file.fileName).toBe("PDJF001.pdf");
    }
  });

  it("accepts DWG and DXF extensions", async () => {
    const dwg = await validateAndHashDrawingFile(
      "C:\\x\\a.dwg",
      validationDeps(Buffer.from("AC1015"), fakeStats({ size: 6 }))
    );
    expect(dwg.ok && dwg.file.format).toBe("DWG");
    const dxf = await validateAndHashDrawingFile(
      "C:\\x\\a.DXF",
      validationDeps(Buffer.from("0\nSECTION"), fakeStats({ size: 9 }))
    );
    expect(dxf.ok && dxf.file.format).toBe("DXF");
  });

  it("rejects unsupported extensions", async () => {
    const outcome = await validateAndHashDrawingFile(
      "C:\\x\\a.exe",
      validationDeps(content, fakeStats({ size: content.length }))
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FILE_UNSUPPORTED_FORMAT");
  });

  it("rejects a relative path and a UNC / network path", async () => {
    const relative = await validateAndHashDrawingFile("drawings/a.pdf", validationDeps(content, fakeStats({ size: content.length })));
    expect(relative.ok).toBe(false);
    if (!relative.ok) expect(relative.code).toBe("FILE_PATH_UNSAFE");

    const unc = await validateAndHashDrawingFile(
      "\\\\server\\share\\a.pdf",
      validationDeps(content, fakeStats({ size: content.length }))
    );
    expect(unc.ok).toBe(false);
    if (!unc.ok) expect(unc.code).toBe("FILE_PATH_UNSAFE");
  });

  it("rejects a symbolic link / junction", async () => {
    const outcome = await validateAndHashDrawingFile(
      pdfPath,
      validationDeps(content, fakeStats({ isSymbolicLink: true, size: content.length }))
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FILE_SYMLINK");
  });

  it("rejects a non-regular file (directory)", async () => {
    const outcome = await validateAndHashDrawingFile(
      pdfPath,
      validationDeps(content, fakeStats({ isFile: false, size: content.length }))
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FILE_NOT_REGULAR");
  });

  it("rejects a file over the size cap by lstat size", async () => {
    const outcome = await validateAndHashDrawingFile(
      pdfPath,
      validationDeps(content, fakeStats({ size: MAX_DRAWING_FILE_SIZE_BYTES + 1 }))
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FILE_TOO_LARGE");
  });

  it("rejects when the file cannot be read or hashed", async () => {
    const unreadable = await validateAndHashDrawingFile(
      pdfPath,
      {
        lstat: () => Promise.resolve(fakeStats({ size: 10 })),
        readFileContent: () => Promise.reject(new Error("EACCES"))
      }
    );
    expect(unreadable.ok).toBe(false);
    if (!unreadable.ok) expect(unreadable.code).toBe("FILE_UNREADABLE");
  });

  it("rejects when lstat itself fails", async () => {
    const outcome = await validateAndHashDrawingFile(
      pdfPath,
      { lstat: () => Promise.reject(new Error("ENOENT")), readFileContent: () => Promise.resolve(content) }
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FILE_UNREADABLE");
  });

  it("rejects an empty or NUL-containing path", async () => {
    const empty = await validateAndHashDrawingFile("", validationDeps(content, fakeStats({ size: content.length })));
    expect(empty.ok).toBe(false);
    const nul = await validateAndHashDrawingFile("C:\\x\\a\0.pdf", validationDeps(content, fakeStats({ size: content.length })));
    expect(nul.ok).toBe(false);
  });

  it("path.isAbsolute normalization is deterministic", () => {
    expect(path.isAbsolute(pdfPath)).toBe(true);
  });
});

describe("createWindowedDialogAdapter", () => {
  interface DialogCall {
    args: unknown[];
  }

  function makeAdapter(overrides: { resolveWindow?: (id: number) => unknown } = {}) {
    const calls: DialogCall[] = [];
    const adapter = createWindowedDialogAdapter({
      dialog: {
        showOpenDialog: (...args: unknown[]) => {
          calls.push({ args });
          return Promise.resolve({ canceled: false, filePaths: ["C:\\picked.pdf"] });
        }
      },
      resolveWindow:
        overrides.resolveWindow ?? ((id) => (id === 42 ? { isWindow: true } : undefined))
    });
    return { adapter, calls };
  }

  it("passes the real options object through on an unparented call", async () => {
    const { adapter, calls } = makeAdapter();
    const options = { title: "选择图纸文件", filters: [{ name: "图纸", extensions: ["pdf"] }] };
    await adapter.showOpenDialog(options);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([options]);
  });

  it("resolves the webContents id to the parent window and keeps the options", async () => {
    const { adapter, calls } = makeAdapter();
    const options = { title: "选择图纸文件", filters: [{ name: "图纸", extensions: ["pdf"] }] };
    await adapter.showOpenDialog({ id: 42 }, options);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([{ isWindow: true }, options]);
  });

  it("falls back to an unparented dialog with the real options when the parent is gone", async () => {
    const { adapter, calls } = makeAdapter();
    const options = { title: "选择图纸文件", filters: [{ name: "图纸", extensions: ["pdf"] }] };
    await adapter.showOpenDialog({ id: 99 }, options);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([options]);
  });

  it("never forwards a plain { id } object as the dialog options argument", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.showOpenDialog({ id: 42 }, { filters: [{ name: "图纸", extensions: ["pdf"] }] });
    const serialized = JSON.stringify(calls.map((call) => call.args));
    // Electron would treat a non-BaseWindow first argument as the OPTIONS
    // object; the adapter guarantees the first argument of a two-arg call is
    // either a resolved window or the real options (never the raw handle).
    expect(serialized).not.toContain('"id":42');
  });
});

describe("DrawingFilePicker", () => {
  function makePicker(overrides: {
    dialogResult?: { canceled: boolean; filePaths: string[] };
    validate?: typeof validateAndHashDrawingFile;
    registerSourceFile?: (sha256: string, absolutePath: string) => void;
  } = {}) {
    const registry = new SelectedFileRegistry();
    const registrations: Array<{ sha256: string; absolutePath: string }> = [];
    const picker = new DrawingFilePicker({
      dialog: {
        showOpenDialog: () => Promise.resolve(overrides.dialogResult ?? { canceled: true, filePaths: [] })
      },
      registry,
      registerSourceFile: overrides.registerSourceFile ?? ((sha256, absolutePath) => registrations.push({ sha256, absolutePath })),
      validate: overrides.validate
    });
    return { picker, registry, registrations };
  }

  const content = Buffer.from("%PDF-1.4 picker test");
  const fakeValidate = (candidate: string): ReturnType<typeof validateAndHashDrawingFile> => {
    if (candidate.includes("bad")) return { ok: false as const, code: "FILE_SYMLINK" as const, message: "link" };
    return {
      ok: true as const,
      file: {
        absolutePath: candidate,
        fileName: path.basename(candidate),
        format: "PDF" as const,
        sizeBytes: content.length,
        sha256: sha256Of(content)
      }
    };
  };

  it("returns canceled with no file when the dialog is canceled", async () => {
    const { picker } = makePicker({ dialogResult: { canceled: true, filePaths: [] } });
    const result = await picker.select(null);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.canceled).toBe(true);
      expect(result.data.file).toBeNull();
    }
  });

  it("rejects a multi-file selection", async () => {
    const { picker } = makePicker({
      dialogResult: { canceled: false, filePaths: ["C:\\a.pdf", "C:\\b.pdf"] },
      validate: fakeValidate
    });
    const result = await picker.select(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SELECTION_INVALID");
  });

  it("stages a validated file and returns metadata WITHOUT the absolute path", async () => {
    const { picker, registry, registrations } = makePicker({
      dialogResult: { canceled: false, filePaths: ["C:\\users\\alice\\PDJF001.pdf"] },
      validate: fakeValidate
    });
    const result = await picker.select(null);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.canceled).toBe(false);
      const file = result.data.file;
      expect(file).not.toBeNull();
      if (file !== null) {
        expect(file.fileName).toBe("PDJF001.pdf");
        expect(file.sha256).toBe(sha256Of(content));
        expect(file.format).toBe("PDF");
        expect(file.sizeBytes).toBe(content.length);
        expect(JSON.stringify(file)).not.toContain("absolutePath");
        expect(JSON.stringify(file)).not.toContain("C:\\users\\alice");
        expect(registry.has(file.token)).toBe(true);
      }
    }
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.absolutePath).toBe("C:\\users\\alice\\PDJF001.pdf");
  });

  it("propagates validation failures as stable bridge errors", async () => {
    const { picker } = makePicker({
      dialogResult: { canceled: false, filePaths: ["C:\\users\\alice\\bad.pdf"] },
      validate: fakeValidate
    });
    const result = await picker.select(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FILE_SYMLINK");
  });
});
