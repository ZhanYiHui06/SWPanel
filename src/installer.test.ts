import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { reportAsarAudit, sha256File } from "../scripts/audit-asar.mjs";
import {
  auditCanonicalInstallers,
  auditMakerOutput,
  BOOTSTRAPPER_MACHINES,
  checkNupkgAsarSizeLimit,
  checkNupkgEntrySizeLimit,
  createInstallerRun,
  deriveNupkgPayloadEntryName,
  deriveSquirrelArtifactNames,
  formatLockedInstallersError,
  hasMZHeader,
  INSTALLERS_INVALID_PREFIX,
  installerRunsRoot,
  MACHINE_X64,
  MACHINE_X86,
  makeWinInstaller,
  MAX_NUPKG_ASAR_SIZE_BYTES,
  MIN_PE_HEADER_OFFSET,
  MZ_MAGIC,
  normalizeZipEntryName,
  parsePEHeader,
  parseReleases,
  PE_SIGNATURE,
  prepareCanonicalPackage,
  publishInstallerOutput,
  quarantineExistingInstallers,
  readZipEntries,
  readZipEntrySha256,
  REQUIRED_NUPKG_ASAR_ENTRY,
  rollbackPublishedInstallers,
  sha1File,
  stageCanonicalPackage,
  toSquirrelVersion,
  validateReleases,
  validateWindowsPE,
  validateWindowsPEBuffer,
  verifyStagedAsar
} from "../scripts/installer.mjs";
import { isWindowsFileLock } from "../scripts/packaging.mjs";

/** The type of the report the fresh canonical audit produces (audit-asar.mjs). */
type AsarAuditReport = Awaited<ReturnType<typeof reportAsarAudit>>;

/** A minimal but well-typed canonical audit report for injected prepare steps. */
const auditReportStub: AsarAuditReport = {
  auditedSourcePath: "stub",
  generatedAt: "stub",
  asarSizeBytes: 13,
  asarSha256: "stub",
  totalEntries: 0,
  forbidden: [],
  missingRuntime: [],
  emptyRuntime: [],
  closureFiles: [],
  hasRendererAssets: false,
  ok: true
};

/**
 * Build a minimal ZIP containing the given entries with real CRC-32 values.
 * Default compression is "store" (method 0); "deflate" uses zlib deflate.
 * Realistic enough for yauzl's streaming audit and for the strict CRC-32
 * validation the installer audit performs.
 */
function zipEntries(
  files: Array<{
    name: string;
    content: string | Buffer;
    method?: "store" | "deflate";
    /** Override the declared uncompressed size written to both headers. */
    declaredUncompressedSize?: number;
  }>
) {
  const parts: Buffer[] = [];
  /** @type {Array<{ name: Buffer; method: number; crc: number; compressed: Buffer; uncompressedSize: number }>} */
  const central = [];
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = typeof file.content === "string"
      ? Buffer.from(file.content, "utf8")
      : file.content;
    const method = file.method === "deflate" ? 8 : 0;
    const compressed =
      method === 8 ? deflateRawSync(data) : Buffer.from(data);
    const crc = crc32(data);
    // A lying central/local header (declared size different from the real
    // payload) simulates a hostile archive for stream-cap tests.
    const declaredSize = file.declaredUncompressedSize ?? data.length;

    // Local file header (30 bytes) followed by name and raw file data.
    const local = Buffer.alloc(30 + name.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // general purpose flags
    local.writeUInt16LE(method, 8); // compression method
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc >>> 0, 14); // crc32
    local.writeUInt32LE(compressed.length, 18); // compressed size
    local.writeUInt32LE(declaredSize, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26); // file name length
    local.writeUInt16LE(0, 28); // extra field length
    name.copy(local, 30);
    compressed.copy(local, 30 + name.length);

    // Central directory entry (46 bytes) followed by name.
    const centralEntry = Buffer.alloc(46 + name.length);
    centralEntry.writeUInt32LE(0x02014b50, 0); // signature
    centralEntry.writeUInt16LE(20, 4); // version made by
    centralEntry.writeUInt16LE(20, 6); // version needed
    centralEntry.writeUInt16LE(0, 8); // general purpose flags
    centralEntry.writeUInt16LE(method, 10); // compression method
    centralEntry.writeUInt16LE(0, 12); // mod time
    centralEntry.writeUInt16LE(0, 14); // mod date
    centralEntry.writeUInt32LE(crc >>> 0, 16); // crc32
    centralEntry.writeUInt32LE(compressed.length, 20); // compressed size
    centralEntry.writeUInt32LE(declaredSize, 24); // uncompressed size
    centralEntry.writeUInt16LE(name.length, 28); // file name length
    name.copy(centralEntry, 46);

    parts.push(local);
    central.push({
      name,
      method,
      crc,
      compressed,
      uncompressedSize: declaredSize,
      centralEntry
    });
  }

  const centralBytes: Buffer[] = [];
  let offset = 0;
  for (const entry of central) {
    const entryBuffer = entry.centralEntry;
    entryBuffer.writeUInt32LE(offset, 42); // local header offset
    centralBytes.push(entryBuffer);
    offset += 30 + entry.name.length + entry.compressed.length;
  }
  const centralDirectory = Buffer.concat(centralBytes);

  // End of central directory record (22 bytes).
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // signature
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // central dir disk
  end.writeUInt16LE(central.length, 8); // entries on this disk
  end.writeUInt16LE(central.length, 10); // total entries
  end.writeUInt32LE(centralDirectory.length, 12); // central dir size
  end.writeUInt32LE(offset, 16); // central dir offset

  return Buffer.concat([...parts, centralDirectory, end]);
}

/**
 * Build a store-only ZIP whose single entry is `lib/net45/resources/app.asar`
 * with the given content. Squirrel nupkgs are standard ZIP archives; this
 * produces a fixture valid enough for the streaming yauzl audit and the strict
 * CRC-32 validation without any external zip-writer dependency.
 */
function zipStoreEntry(entryName: string, content: string) {
  return zipEntries([{ name: entryName, content }]);
}

/** A minimal but valid PE executable stub (MZ, e_lfanew, PE\0\0, machine). */
function peStubBytes(machine: number): Buffer {
  const stub = Buffer.alloc(
    MIN_PE_HEADER_OFFSET + PE_SIGNATURE.length + 2
  );
  MZ_MAGIC.copy(stub, 0);
  stub.writeUInt32LE(MIN_PE_HEADER_OFFSET, 0x3c); // e_lfanew
  PE_SIGNATURE.copy(stub, MIN_PE_HEADER_OFFSET);
  stub.writeUInt16LE(machine, MIN_PE_HEADER_OFFSET + PE_SIGNATURE.length);
  return stub;
}

/** A minimal but valid x64 PE executable stub (MZ, e_lfanew, PE\0\0, x64). */
function peStub() {
  return peStubBytes(MACHINE_X64);
}

/**
 * A minimal but valid i386 (0x14c) PE stub — the STANDARD machine of the
 * Squirrel Setup.exe bootstrapper. Squirrel's electron-winstaller emits an
 * i386 bootstrapper even for an x64 target app, so the audit explicitly
 * requires/allows 0x14c for Setup.exe while the x64 evidence for the target
 * comes from the payload exe inside the full.nupkg.
 */
function x86BootstrapperStub() {
  return peStubBytes(MACHINE_X86);
}

/** A minimal but valid PE executable stub: MZ magic followed by junk. */
function mzStub() {
  return Buffer.concat([
    MZ_MAGIC,
    Buffer.from("SWPanel-Setup.exe-stub-for-audit-tests", "utf8")
  ]);
}

/** Cached derived Squirrel artifact basenames (read only once per run). */
let artifactNamesPromise: ReturnType<typeof deriveSquirrelArtifactNames> | null =
  null;
function artifactNames() {
  if (artifactNamesPromise === null) {
    artifactNamesPromise = deriveSquirrelArtifactNames();
  }
  return artifactNamesPromise;
}

/** Create a canonical out tree with a known app.asar content. */
async function makeCanonicalOut(root: string, asarContent = "canonical asar") {
  const asarDir = path.join(
    root,
    "out",
    "SWPanel-win32-x64",
    "resources"
  );
  await mkdir(asarDir, { recursive: true });
  await writeFile(path.join(asarDir, "app.asar"), asarContent, "utf8");
  return path.join(asarDir, "app.asar");
}

/** Create the per-run staging squirrel output directory. */
async function makeStagingSquirrelDir(runDir: string) {
  const squirrelDir = path.join(
    runDir,
    "out",
    "make",
    "squirrel.windows",
    "x64"
  );
  await mkdir(squirrelDir, { recursive: true });
  return squirrelDir;
}

/**
 * Squirrel artifacts whose full.nupkg contains both the store-only
 * `lib/net45/resources/app.asar` with the given content AND the x64 payload exe
 * entry `lib/net45/<appName>.exe` (derived from the forge
 * executableName/name), whose Setup.exe is the STANDARD i386 Squirrel
 * bootstrapper stub (0x14c), and whose RELEASES line truthfully describes the
 * full.nupkg. Artifact names are derived from the workspace package.json the
 * same way MakerSquirrel names them (the audit enforces those exact names).
 * The x64 target evidence lives in the payload exe; Setup.exe being i386 is
 * the verified standard Squirrel behavior.
 */
async function writeSquirrelArtifacts(
  squirrelDir: string,
  asarContent = "canonical asar",
  payloadExe: Buffer = peStub()
) {
  await mkdir(squirrelDir, { recursive: true });
  const names = await deriveSquirrelArtifactNames();
  const payloadEntry = await deriveNupkgPayloadEntryName();
  const nupkg = zipEntries([
    { name: REQUIRED_NUPKG_ASAR_ENTRY, content: asarContent },
    { name: payloadEntry, content: payloadExe }
  ]);
  await writeFile(path.join(squirrelDir, names.fullNupkg), nupkg);
  await writeFile(path.join(squirrelDir, names.setupExe), x86BootstrapperStub());
  await writeFile(
    path.join(squirrelDir, "RELEASES"),
    makeReleasesLine(names.fullNupkg, nupkg),
    "utf8"
  );
}

/**
 * Build a RELEASES line that truthfully describes the given nupkg on disk:
 * `<sha1-of-file> <name> <size-of-file>`. When `extraDelta` is supplied it is
 * appended as an additional well-formed delta line that does not reference the
 * full package.
 */
function makeReleasesLine(nupkgName: string, nupkg: Buffer, extraDelta?: string) {
  const sha1 = createHash("sha1").update(nupkg).digest("hex").toUpperCase();
  const line = `${sha1} ${nupkgName} ${nupkg.length}`;
  return [line, ...(extraDelta ? [extraDelta] : [])].join("\n") + "\n";
}

/** Fake heavy steps that all succeed (prepare does NOT re-package). */
function successfulSteps(canonicalAsarContent = "canonical asar") {
  return {
    prepareCanonicalPackage: async (root: string) => {
      const asarPath = path.join(
        root,
        "out",
        "SWPanel-win32-x64",
        "resources",
        "app.asar"
      );
      await mkdir(path.dirname(asarPath), { recursive: true });
      await writeFile(asarPath, canonicalAsarContent, "utf8");
      // The expected fingerprint must be the REAL fingerprint of the content so
      // the staged-copy verification and the nupkg audit can compare honestly.
      const sha256 = await sha256File(asarPath);
      return {
        ok: true as const,
        asarPath,
        outPath: path.join(root, "out"),
        sizeBytes: canonicalAsarContent.length,
        canonicalAsarSha256: sha256,
        auditReport: auditReportStub
      };
    },
    stageCanonicalPackage: async (root: string, runDir: string, outPath: string) => {
      void root;
      void outPath;
      const staged = path.join(runDir, "out", "SWPanel-win32-x64");
      await mkdir(path.join(staged, "resources"), { recursive: true });
      await writeFile(
        path.join(staged, "resources", "app.asar"),
        canonicalAsarContent,
        "utf8"
      );
      return staged;
    },
    runMake: async (_root: string, stagingOut: string) => {
      const squirrelDir = path.join(
        stagingOut,
        "make",
        "squirrel.windows",
        "x64"
      );
      await writeSquirrelArtifacts(squirrelDir, canonicalAsarContent);
      return 0;
    },
    quarantineExistingInstallers: () =>
      Promise.resolve({ status: "absent" as const })
  };
}

describe("makeWinInstaller (prepare-based chain, no real Forge)", () => {
  it("publishes to the canonical installers only after prepare/stage/make/audit all pass", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-makewin-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(root, { recursive: true });
      const reportPath = path.join(root, ".scratch", "installer-audit-report.json");
      const auditedCanonicalDirs: string[] = [];
      const names = await artifactNames();
      const result = await makeWinInstaller({
        root,
        reportPath,
        ...successfulSteps(),
        auditCanonicalInstallers: async (dir, asarPath, expected) => {
          auditedCanonicalDirs.push(dir);
          return auditCanonicalInstallers(dir, asarPath, expected);
        }
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.installersPath).toBe(path.join(root, "installers"));
      // The returned maker output directory is the canonical installers dir
      // itself (it must exist after publish), never a per-run staging path.
      expect(result.makerOutputDir).toBe(path.join(root, "installers"));
      await expect(access(result.makerOutputDir)).resolves.toBeUndefined();
      expect(
        await readdir(path.join(root, "installers"))
      ).toEqual(
        expect.arrayContaining([
          "RELEASES",
          names.setupExe,
          names.fullNupkg
        ])
      );
      await expect(
        access(path.join(root, "installers", names.fullNupkg))
      ).resolves.toBeUndefined();
      // The published canonical installers directory itself is re-audited.
      expect(auditedCanonicalDirs).toEqual([path.join(root, "installers")]);
      const rawReport = await readFile(reportPath, "utf8");
      const report = JSON.parse(rawReport) as {
        ok: boolean;
        makerOutputDir?: string;
        publishedPath?: string;
        nupkg?: { entry: string };
        payload?: { entry: string; machine: number };
        canonicalAudit?: { ok: boolean };
        artifacts?: { releases?: string; setupExe?: string; fullNupkg?: string };
      };
      expect(report.ok).toBe(true);
      expect(report.publishedPath).toBe(path.join(root, "installers"));
      expect(report.makerOutputDir).toBe(path.join(root, "installers"));
      // The final ok:true report references only canonical installers paths.
      expect(report.artifacts?.releases).toBe(
        path.join(root, "installers", "RELEASES")
      );
      expect(report.artifacts?.setupExe).toBe(
        path.join(root, "installers", names.setupExe)
      );
      expect(report.artifacts?.fullNupkg).toBe(
        path.join(root, "installers", names.fullNupkg)
      );
      expect(report.nupkg?.entry).toBe(REQUIRED_NUPKG_ASAR_ENTRY);
      // The payload exe is recorded as the x64 target evidence.
      expect(report.payload?.entry).toBe("lib/net45/SWPanel.exe");
      expect(report.payload?.machine).toBe(MACHINE_X64);
      // The fresh canonical audit is the installer's pre-evidence fingerprint.
      expect(report.canonicalAudit?.ok).toBe(true);
      // The canonical out is never quarantined or renamed by the chain.
      const entries = await readdir(root);
      expect(
        entries.some((entry) => entry.startsWith("out-invalid-"))
      ).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "prepare audit",
      {
        prepareCanonicalPackage: () =>
          Promise.resolve({
            ok: false as const,
            stage: "audit" as const,
            asarPath: "canonical-app.asar",
            error: "fresh ASAR audit FAILED",
            auditReport: null
          })
      }
    ],
    [
      "prepare smoke",
      {
        prepareCanonicalPackage: () =>
          Promise.resolve({
            ok: false as const,
            stage: "smoke" as const,
            asarPath: "canonical-app.asar",
            error: "fresh smoke of the canonical package FAILED",
            auditReport: auditReportStub
          })
      }
    ],
    [
      "audit",
      {
        auditMakerOutput: () =>
          Promise.resolve({
            ok: false as const,
            generatedAt: "",
            makerOutputDir: "",
            error: "Setup.exe missing"
          })
      }
    ]
  ])(
    "aborts at stage %s without running make or publishing installers",
    async (stage, overrides) => {
      const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-makewin-"));
      try {
        const root = path.join(base, "repo");
        await mkdir(root, { recursive: true });
        const reportPath = path.join(root, ".scratch", "installer-audit-report.json");
        let makeCalls = 0;
        const auditOverride =
          "auditMakerOutput" in overrides
            ? overrides.auditMakerOutput
            : undefined;
        const prepareOverride =
          "prepareCanonicalPackage" in overrides
            ? overrides.prepareCanonicalPackage
            : undefined;
        const result = await makeWinInstaller({
          root,
          reportPath,
          ...successfulSteps(),
          runMake: () => {
            makeCalls += 1;
            return 0;
          },
          ...(auditOverride !== undefined
            ? { auditMakerOutput: auditOverride }
            : {}),
          ...(prepareOverride !== undefined
            ? { prepareCanonicalPackage: prepareOverride }
            : {})
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        if (stage.startsWith("prepare")) {
          expect(result.stage).toBe("prepare");
          expect(result.prepareStage).toBe(stage.slice("prepare ".length));
          expect(result.error).toMatch(/FAILED|fail/i);
        } else {
          expect(result.stage).toBe(stage);
        }
        // A failed prepare must never reach Forge make; an audit failure is
        // reached only after make has already run.
        expect(makeCalls).toBe(stage === "audit" ? 1 : 0);
        await expect(access(path.join(root, "installers"))).rejects.toThrow();
        expect(result.reportPath).toBe(reportPath);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    }
  );

  it("aborts at stage make without publishing installers", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-makewin-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(root, { recursive: true });
      const reportPath = path.join(root, ".scratch", "installer-audit-report.json");
      const result = await makeWinInstaller({
        root,
        reportPath,
        ...successfulSteps(),
        runMake: () => 7
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.stage).toBe("make");
      expect(result.exitCode).toBe(7);
      await expect(access(path.join(root, "installers"))).rejects.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("never quarantines the canonical out, even when the default prepare fails", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-makewin-"));
    try {
      const root = path.join(base, "repo");
      // The canonical out tree exists but its asar is missing: the DEFAULT
      // prepare (fresh audit) must fail WITHOUT re-packaging and WITHOUT
      // quarantining the canonical out.
      await mkdir(path.join(root, "out", "SWPanel-win32-x64", "resources"), {
        recursive: true
      });
      const reportPath = path.join(root, ".scratch", "installer-audit-report.json");
      let makeCalls = 0;
      const result = await makeWinInstaller({
        root,
        reportPath,
        runMake: () => {
          makeCalls += 1;
          return 0;
        }
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.stage).toBe("prepare");
      expect(result.prepareStage).toBe("audit");
      expect(result.error).toMatch(/canonical package|audit/i);
      expect(makeCalls).toBe(0);
      await expect(access(path.join(root, "installers"))).rejects.toThrow();
      // The canonical out directory is untouched and no quarantine appeared.
      await expect(access(path.join(root, "out"))).resolves.toBeUndefined();
      const entries = await readdir(root);
      expect(
        entries.some((entry) => entry.startsWith("out-invalid-"))
      ).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("quarantines a previous installers immediately after the lock, before publishing", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-makewin-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(path.join(root, "installers"), { recursive: true });
      await writeFile(path.join(root, "installers", "stale.txt"), "stale");
      const reportPath = path.join(root, ".scratch", "installer-audit-report.json");
      let quarantineCalls = 0;
      const result = await makeWinInstaller({
        root,
        reportPath,
        ...successfulSteps(),
        quarantineExistingInstallers: async () => {
          quarantineCalls += 1;
          return quarantineExistingInstallers(root);
        }
      });
      expect(result.ok).toBe(true);
      expect(quarantineCalls).toBe(1);
      await expect(access(path.join(root, "installers"))).resolves.toBeUndefined();
      const entries = await readdir(root);
      const quarantined = entries.find((entry) =>
        entry.startsWith(INSTALLERS_INVALID_PREFIX)
      );
      expect(quarantined).toBeDefined();
      await expect(
        access(path.join(root, quarantined ?? "", "stale.txt"))
      ).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("never leaves a previous installers as current evidence when a later stage fails", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-makewin-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(path.join(root, "installers"), { recursive: true });
      await writeFile(path.join(root, "installers", "stale.txt"), "stale");
      const reportPath = path.join(root, ".scratch", "installer-audit-report.json");
      const result = await makeWinInstaller({
        root,
        reportPath,
        ...successfulSteps(),
        // The real quarantine runs at the start; the audit then fails.
        quarantineExistingInstallers: (r) => quarantineExistingInstallers(r),
        auditMakerOutput: () =>
          Promise.resolve({
            ok: false as const,
            generatedAt: "",
            makerOutputDir: "",
            error: "Setup.exe missing"
          })
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.stage).toBe("audit");
      // The stale installers were quarantined at the start; the canonical is absent.
      await expect(access(path.join(root, "installers"))).rejects.toThrow();
      const entries = await readdir(root);
      const quarantined = entries.find((entry) =>
        entry.startsWith(INSTALLERS_INVALID_PREFIX)
      );
      expect(quarantined).toBeDefined();
      await expect(
        access(path.join(root, quarantined ?? "", "stale.txt"))
      ).resolves.toBeUndefined();
      // The shared report must not claim success after a failed run.
      const rawReport = await readFile(reportPath, "utf8");
      const report = JSON.parse(rawReport) as { ok: boolean; error?: string };
      expect(report.ok).toBe(false);
      expect(report.error).toMatch(/Setup\.exe missing/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("aborts at stage stage when the staged asar drifts from the prepared fingerprint", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-makewin-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(root, { recursive: true });
      const reportPath = path.join(root, ".scratch", "installer-audit-report.json");
      const result = await makeWinInstaller({
        root,
        reportPath,
        prepareCanonicalPackage: async (r) => {
          const asarPath = path.join(
            r,
            "out",
            "SWPanel-win32-x64",
            "resources",
            "app.asar"
          );
          await mkdir(path.dirname(asarPath), { recursive: true });
          await writeFile(asarPath, "canonical asar", "utf8");
          const sha256 = await sha256File(asarPath);
          return {
            ok: true as const,
            asarPath,
            outPath: path.join(r, "out"),
            sizeBytes: "canonical asar".length,
            canonicalAsarSha256: sha256,
            auditReport: auditReportStub
          };
        },
        stageCanonicalPackage: async (_root, runDir) => {
          const staged = path.join(runDir, "out", "SWPanel-win32-x64");
          await mkdir(path.join(staged, "resources"), { recursive: true });
          await writeFile(
            path.join(staged, "resources", "app.asar"),
            "tampered staged asar",
            "utf8"
          );
          return staged;
        },
        runMake: () => 0,
        quarantineExistingInstallers: () =>
          Promise.resolve({ status: "absent" as const })
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.stage).toBe("stage");
      expect(result.error).toMatch(/does not match the expected canonical fingerprint/);
      await expect(access(path.join(root, "installers"))).rejects.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("writes an ok:false report and fails loudly when publishing fails", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-makewin-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(root, { recursive: true });
      const reportPath = path.join(root, ".scratch", "installer-audit-report.json");
      const result = await makeWinInstaller({
        root,
        reportPath,
        ...successfulSteps(),
        publishInstallerOutput: () => Promise.reject(new Error("rename failed"))
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.stage).toBe("publish");
      expect(result.error).toMatch(/rename failed/);
      await expect(access(path.join(root, "installers"))).rejects.toThrow();
      const rawReport = await readFile(reportPath, "utf8");
      const report = JSON.parse(rawReport) as { ok: boolean; error?: string };
      expect(report.ok).toBe(false);
      expect(report.error).toMatch(/rename failed/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("writes an ok:false report and rolls the published installers back when the post-publish report cannot be finalized", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-makewin-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(root, { recursive: true });
      const reportPath = path.join(root, ".scratch", "installer-audit-report.json");
      const result = await makeWinInstaller({
        root,
        reportPath,
        ...successfulSteps(),
        writeAuditReport: async (p, report) => {
          // Simulate a finalization failure on the canonical post-publish write
          // only; the ok:false failure report must still land.
          if (report.ok === true && report.publishedPath !== undefined) {
            throw new Error("finalize write failed");
          }
          return import("../scripts/installer.mjs").then((m) =>
            m.writeAuditReport(p, report)
          );
        }
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.stage).toBe("publish");
      expect(result.error).toMatch(/could not be finalized/);
      // The just-published installers were rolled back into the per-run output,
      // so the canonical installers is absent again on a failed run.
      await expect(access(path.join(root, "installers"))).rejects.toThrow();
      const rawReport = await readFile(reportPath, "utf8");
      const report = JSON.parse(rawReport) as { ok: boolean; error?: string };
      expect(report.ok).toBe(false);
      expect(report.error).toMatch(/could not be finalized/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("rolls the published installers back and writes ok:false when the canonical re-audit fails", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-makewin-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(root, { recursive: true });
      const reportPath = path.join(root, ".scratch", "installer-audit-report.json");
      let rollbackCalls = 0;
      const auditedCanonicalDirs: string[] = [];
      const result = await makeWinInstaller({
        root,
        reportPath,
        ...successfulSteps(),
        auditCanonicalInstallers: (dir) => {
          auditedCanonicalDirs.push(dir);
          return Promise.resolve({
            ok: false as const,
            generatedAt: "",
            makerOutputDir: dir,
            error: "canonical re-audit says no"
          });
        },
        rollbackPublishedInstallers: async (installersPath, runDir, r) => {
          rollbackCalls += 1;
          return rollbackPublishedInstallers(installersPath, runDir, r);
        }
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.stage).toBe("publish");
      expect(result.error).toMatch(/canonical re-audit FAILED/);
      // The canonical re-audit was run against the canonical installers dir.
      expect(auditedCanonicalDirs).toEqual([path.join(root, "installers")]);
      // The published installers were rolled back: canonical is absent.
      expect(rollbackCalls).toBe(1);
      await expect(access(path.join(root, "installers"))).rejects.toThrow();
      const rawReport = await readFile(reportPath, "utf8");
      const report = JSON.parse(rawReport) as { ok: boolean; error?: string };
      expect(report.ok).toBe(false);
      expect(report.error).toMatch(/canonical re-audit FAILED/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("does not swallow a failure to write the ok:false failure report", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-makewin-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(root, { recursive: true });
      const reportPath = path.join(root, ".scratch", "installer-audit-report.json");
      // The publish step first succeeds in writing the pre-publish ok report,
      // then blocks the report directory and fails. The subsequent ok:false
      // failure-report write must fail loudly (reject), never be swallowed into
      // a silent return.
      await expect(
        makeWinInstaller({
          root,
          reportPath,
          ...successfulSteps(),
          publishInstallerOutput: async () => {
            await rm(path.join(root, ".scratch"), { recursive: true, force: true });
            await writeFile(path.join(root, ".scratch"), "blocked", "utf8");
            throw new Error("rename failed");
          }
        })
      ).rejects.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("commits the final canonical report while the lock is still held, then releases it", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-makewin-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(root, { recursive: true });
      const reportPath = path.join(root, ".scratch", "installer-audit-report.json");
      const lockDir = path.join(base, "lock");
      let sawFinalWrite = false;
      let lockHeldDuringFinalWrite: boolean | null = null;
      const result = await makeWinInstaller({
        root,
        lockDir,
        reportPath,
        ...successfulSteps(),
        writeAuditReport: async (p, report) => {
          if (report.ok === true && report.publishedPath !== undefined) {
            sawFinalWrite = true;
            lockHeldDuringFinalWrite = await access(lockDir)
              .then(() => true)
              .catch(() => false);
          }
          return import("../scripts/installer.mjs").then((m) =>
            m.writeAuditReport(p, report)
          );
        }
      });
      expect(result.ok).toBe(true);
      // The final ok:true report was committed while the lock directory still
      // existed; the lock is only released after the report write completes.
      expect(sawFinalWrite).toBe(true);
      expect(lockHeldDuringFinalWrite).toBe(true);
      await expect(access(lockDir)).rejects.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("rejects when another packaging run holds the shared package lock", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-makewin-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(root, { recursive: true });
      const lockDir = path.join(base, "lock");
      const lock = await import("../scripts/package-lock.mjs");
      const first = await lock.acquirePackageLock(lockDir);
      expect(first.status).toBe("acquired");
      try {
        await expect(
          makeWinInstaller({ root, lockDir, ...successfulSteps() })
        ).rejects.toThrow(/Another packaging run is in progress/);
      } finally {
        await lock.releasePackageLock(
          first.status === "acquired" ? first.lock : null,
          lockDir
        );
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("holds and releases the shared package lock around the whole run", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-makewin-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(root, { recursive: true });
      const lockDir = path.join(base, "lock");
      const result = await makeWinInstaller({
        root,
        lockDir,
        ...successfulSteps()
      });
      expect(result.ok).toBe(true);
      // The lock directory must be gone: the run released it in its finally.
      await expect(access(lockDir)).rejects.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("prepareCanonicalPackage", () => {
  it("reports a failed audit for a missing canonical asar without touching out", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-prepare-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(path.join(root, "out", "SWPanel-win32-x64", "resources"), {
        recursive: true
      });
      const result = await prepareCanonicalPackage(root);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.stage).toBe("audit");
      expect(result.auditReport).toBeNull();
      expect(result.error).toMatch(/audit|asar/i);
      // The canonical out tree is left exactly as it was.
      await expect(
        access(path.join(root, "out", "SWPanel-win32-x64", "resources"))
      ).resolves.toBeUndefined();
      const entries = await readdir(root);
      expect(
        entries.some((entry) => entry.startsWith("out-invalid-"))
      ).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("quarantineExistingInstallers", () => {
  it("reports absent when there is no installers directory", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-qinst-"));
    try {
      expect(await quarantineExistingInstallers(base)).toEqual({
        status: "absent"
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("quarantines a directory and leaves the canonical path empty", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-qinst-"));
    try {
      await mkdir(path.join(base, "installers"), { recursive: true });
      await writeFile(path.join(base, "installers", "old.exe"), "old");
      const result = await quarantineExistingInstallers(base);
      expect(result.status).toBe("moved");
      if (result.status !== "moved") return;
      expect(path.basename(result.target)).toMatch(
        new RegExp(`^${INSTALLERS_INVALID_PREFIX}`)
      );
      await expect(access(path.join(base, "installers"))).rejects.toThrow();
      await expect(
        access(path.join(result.target, "old.exe"))
      ).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("refuses to quarantine a non-directory named installers", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-qinst-"));
    try {
      await writeFile(path.join(base, "installers"), "file");
      await expect(quarantineExistingInstallers(base)).rejects.toThrow(
        /not a directory/
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("publishInstallerOutput", () => {
  /** Create a runDir with a real squirrel output tree containing a marker. */
  async function makeRunSquirrelOut(runDir: string) {
    const squirrelDir = path.join(
      runDir,
      "out",
      "make",
      "squirrel.windows",
      "x64"
    );
    await mkdir(squirrelDir, { recursive: true });
    await writeFile(path.join(squirrelDir, "marker.txt"), "verified");
  }

  it("moves the maker output to the canonical installers path", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-pubinst-"));
    try {
      const root = path.join(base, "repo");
      const runDir = path.join(root, ".scratch", "installer-runs", "run-1");
      await makeRunSquirrelOut(runDir);
      const published = await publishInstallerOutput(runDir, root);
      expect(published).toBe(path.join(root, "installers"));
      await expect(
        access(path.join(root, "installers", "marker.txt"))
      ).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("retries transient Windows locks with bounded backoff and succeeds", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-pubinst-"));
    try {
      const root = path.join(base, "repo");
      const runDir = path.join(root, ".scratch", "installer-runs", "run-retry");
      await makeRunSquirrelOut(runDir);

      const transientErrors = [
        Object.assign(new Error("transient"), { code: "EBUSY" }),
        Object.assign(new Error("transient"), { code: "EPERM" })
      ];
      let renameCalls = 0;
      const renameFn = async (from: string, to: string) => {
        const error = transientErrors[renameCalls];
        renameCalls += 1;
        if (error === undefined) {
          return rename(from, to);
        }
        throw error;
      };
      const slept: number[] = [];
      const sleepFn = (ms: number) => {
        slept.push(ms);
        return undefined;
      };

      const published = await publishInstallerOutput(runDir, root, {
        rename: renameFn,
        sleep: sleepFn
      });
      expect(published).toBe(path.join(root, "installers"));
      expect(renameCalls).toBe(transientErrors.length + 1);
      expect(slept).toEqual([250, 500]);
      await expect(
        access(path.join(root, "installers", "marker.txt"))
      ).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails loudly when the transient lock outlives the bounded retry budget", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-pubinst-"));
    try {
      const root = path.join(base, "repo");
      const runDir = path.join(
        root,
        ".scratch",
        "installer-runs",
        "run-timeout"
      );
      await makeRunSquirrelOut(runDir);
      let renameCalls = 0;
      const renameFn = () => {
        renameCalls += 1;
        return Promise.reject(
          Object.assign(new Error("persistent lock"), { code: "EPERM" })
        );
      };
      const slept: number[] = [];
      const sleepFn = (ms: number) => {
        slept.push(ms);
        return undefined;
      };
      await expect(
        publishInstallerOutput(runDir, root, { rename: renameFn, sleep: sleepFn })
      ).rejects.toThrow(/Cannot move installer output/);
      expect(slept).toEqual([250, 500, 1000, 2000]);
      expect(renameCalls).toBe(5);
      await expect(access(path.join(root, "installers"))).rejects.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("refuses to publish from a run directory that is a junction resolving outside the runs root", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-pubinst-"));
    try {
      const root = path.join(base, "repo");
      const outside = path.join(base, "outside");
      await mkdir(
        path.join(outside, "out", "make", "squirrel.windows", "x64"),
        { recursive: true }
      );
      await mkdir(path.join(root, ".scratch", "installer-runs"), {
        recursive: true
      });
      const runDir = path.join(
        root,
        ".scratch",
        "installer-runs",
        "run-junction"
      );
      try {
        await symlink(outside, runDir, "junction");
      } catch {
        return; // platform/fs without junction support: skip
      }
      await expect(publishInstallerOutput(runDir, root)).rejects.toThrow();
      await expect(access(path.join(root, "installers"))).rejects.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("Squirrel format helpers", () => {
  it("hasMZHeader accepts a file starting with MZ and rejects others", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-mz-"));
    try {
      const mz = path.join(base, "setup.exe");
      await writeFile(mz, mzStub());
      expect(await hasMZHeader(mz)).toBe(true);
      const notMz = path.join(base, "other.exe");
      await writeFile(notMz, "setup exe", "utf8");
      expect(await hasMZHeader(notMz)).toBe(false);
      expect(await hasMZHeader(path.join(base, "missing.exe"))).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("sha1File computes the SHA-1 of file bytes", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-sha1-"));
    try {
      const file = path.join(base, "nupkg");
      await writeFile(file, "nupkg bytes", "utf8");
      expect(await sha1File(file)).toBe(
        createHash("sha1").update(Buffer.from("nupkg bytes", "utf8")).digest("hex")
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("parseReleases tolerates a UTF-8 BOM and CRLF line endings", () => {
    const lines = parseReleases("\uFEFFAAA 1-full.nupkg 123\r\nBBB 2-delta.nupkg 45\r\n");
    expect(lines).toEqual([
      {
        sha1: "AAA",
        name: "1-full.nupkg",
        size: "123",
        tokenCount: 3,
        raw: "AAA 1-full.nupkg 123"
      },
      {
        sha1: "BBB",
        name: "2-delta.nupkg",
        size: "45",
        tokenCount: 3,
        raw: "BBB 2-delta.nupkg 45"
      }
    ]);
  });

  it("validateReleases accepts a truthful full line plus a well-formed delta", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-rel-"));
    try {
      const nupkg = zipStoreEntry(REQUIRED_NUPKG_ASAR_ENTRY, "canonical asar");
      const content = makeReleasesLine(
        "swpanel-0.1.0-full.nupkg",
        nupkg,
        "ABCDEF0123456789ABCDEF0123456789ABCDEF01 swpanel-0.1.0-delta.nupkg 99"
      );
      const result = validateReleases(content, {
        name: "swpanel-0.1.0-full.nupkg",
        size: nupkg.length,
        sha1: createHash("sha1").update(nupkg).digest("hex")
      });
      expect(result).toEqual({ ok: true });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("validateReleases rejects a malformed line, a missing full line, and a wrong size", () => {
    const nupkg = zipStoreEntry(REQUIRED_NUPKG_ASAR_ENTRY, "canonical asar");
    const good = createHash("sha1").update(nupkg).digest("hex");
    expect(
      validateReleases("not a releases line\n", {
        name: "x-full.nupkg",
        size: nupkg.length,
        sha1: good
      }).ok
    ).toBe(false);
    const notReferencing = validateReleases(
      `${"A".repeat(40)} other-full.nupkg ${nupkg.length}\n`,
      { name: "x-full.nupkg", size: nupkg.length, sha1: good }
    );
    expect(notReferencing.ok).toBe(false);
    if (notReferencing.ok === false) {
      expect(notReferencing.error).toContain("does not reference");
    }
    const wrongSize = validateReleases(
      `${good} x-full.nupkg 1\n`,
      { name: "x-full.nupkg", size: nupkg.length, sha1: good }
    );
    expect(wrongSize.ok).toBe(false);
    if (wrongSize.ok === false) {
      expect(wrongSize.error).toContain("bytes");
    }
    const invalidSha = validateReleases(
      `${"X".repeat(40)} x-full.nupkg ${nupkg.length}\n`,
      { name: "x-full.nupkg", size: nupkg.length, sha1: good }
    );
    expect(invalidSha.ok).toBe(false);
  });

  it("validateReleases rejects a full line whose SHA-1 does not match the nupkg on disk", () => {
    const nupkg = zipStoreEntry(REQUIRED_NUPKG_ASAR_ENTRY, "canonical asar");
    const result = validateReleases(
      `${"A".repeat(40)} x-full.nupkg ${nupkg.length}\n`,
      { name: "x-full.nupkg", size: nupkg.length, sha1: "B".repeat(40) }
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toContain("does not match");
    }
  });

  it("validateReleases rejects lines with more than three tokens", () => {
    const nupkg = zipStoreEntry(REQUIRED_NUPKG_ASAR_ENTRY, "canonical asar");
    const good = createHash("sha1").update(nupkg).digest("hex");
    const result = validateReleases(
      `${good} x-full.nupkg ${nupkg.length} extra-token\n`,
      { name: "x-full.nupkg", size: nupkg.length, sha1: good }
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.error).toContain("exactly");
  });

  it("validateReleases rejects a duplicated full.nupkg record", () => {
    const nupkg = zipStoreEntry(REQUIRED_NUPKG_ASAR_ENTRY, "canonical asar");
    const good = createHash("sha1").update(nupkg).digest("hex");
    const result = validateReleases(
      `${good} x-full.nupkg ${nupkg.length}\n${good} x-full.nupkg ${nupkg.length}\n`,
      { name: "x-full.nupkg", size: nupkg.length, sha1: good }
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.error).toContain("more than once");
  });

  it("validateReleases rejects a case-variant duplicate record of the same artifact", () => {
    const nupkg = zipStoreEntry(REQUIRED_NUPKG_ASAR_ENTRY, "canonical asar");
    const good = createHash("sha1").update(nupkg).digest("hex");
    const result = validateReleases(
      `${good} x-full.nupkg ${nupkg.length}\n${good} X-FULL.NUPKG ${nupkg.length}\n`,
      { name: "x-full.nupkg", size: nupkg.length, sha1: good }
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.error).toContain("more than once");
  });

  it("validateReleases rejects a referenced artifact that is not on disk", () => {
    const nupkg = zipStoreEntry(REQUIRED_NUPKG_ASAR_ENTRY, "canonical asar");
    const good = createHash("sha1").update(nupkg).digest("hex");
    const result = validateReleases(
      `${good} x-full.nupkg ${nupkg.length}\n` +
        `${good} ghost-delta.nupkg 5\n`,
      { name: "x-full.nupkg", size: nupkg.length, sha1: good },
      { existingNames: ["x-full.nupkg"] }
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toContain("not present on disk");
    }
    // When every referenced name exists on disk the file passes.
    const ok = validateReleases(
      `${good} x-full.nupkg ${nupkg.length}\n`,
      { name: "x-full.nupkg", size: nupkg.length, sha1: good },
      { existingNames: ["x-full.nupkg"] }
    );
    expect(ok).toEqual({ ok: true });
  });

  it("readZipEntrySha256 returns the CRC-32 of the decompressed entry", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-zipcrc-"));
    try {
      const zip = path.join(base, "full.nupkg");
      await writeFile(
        zip,
        zipEntries([
          { name: "lib/net45/resources/app.asar", content: "canonical asar" },
          { name: "lib/net45/SWPanel.exe", content: "exe", method: "deflate" }
        ])
      );
      const entry = await readZipEntrySha256(zip, REQUIRED_NUPKG_ASAR_ENTRY);
      expect(entry).toEqual({
        found: true,
        sha256: createHash("sha256")
          .update(Buffer.from("canonical asar", "utf8"))
          .digest("hex"),
        sizeBytes: "canonical asar".length,
        crc32: crc32(Buffer.from("canonical asar", "utf8")),
        sizeExceeded: false
      });
      const missing = await readZipEntrySha256(zip, "nope.txt");
      expect(missing).toEqual({ found: false });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("readZipEntrySha256 hard-caps the stream when the cap is exceeded", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-zipcap-"));
    try {
      const zip = path.join(base, "full.nupkg");
      await writeFile(
        zip,
        zipStoreEntry(REQUIRED_NUPKG_ASAR_ENTRY, "canonical asar")
      );
      const entry = await readZipEntrySha256(
        zip,
        REQUIRED_NUPKG_ASAR_ENTRY,
        10
      );
      expect(entry.found).toBe(true);
      if (entry.found !== true) return;
      expect(entry.sizeExceeded).toBe(true);
      expect(entry.sizeBytes).toBeGreaterThan(10);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("readZipEntries reports every entry with its declared CRC-32 and sizes", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-zipenum-"));
    try {
      const zip = path.join(base, "full.nupkg");
      await writeFile(
        zip,
        zipEntries([
          { name: "lib/net45/resources/app.asar", content: "canonical asar" },
          { name: "lib/net45/", content: "" }
        ])
      );
      const entries = await readZipEntries(zip);
      const asar = entries.find((e) => e.fileName === REQUIRED_NUPKG_ASAR_ENTRY);
      expect(asar).toBeDefined();
      expect(asar?.uncompressedSize).toBe("canonical asar".length);
      expect(asar?.crc32).toBe(crc32(Buffer.from("canonical asar", "utf8")));
      // A directory entry ends with a slash and is reported as a distinct entry.
      expect(entries.map((e) => e.fileName)).toEqual([
        REQUIRED_NUPKG_ASAR_ENTRY,
        "lib/net45/"
      ]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("checkNupkgAsarSizeLimit enforces the upper bound", () => {
    expect(checkNupkgAsarSizeLimit(1234)).toEqual({ ok: true });
    expect(checkNupkgAsarSizeLimit(MAX_NUPKG_ASAR_SIZE_BYTES)).toEqual({ ok: true });
    const over = checkNupkgAsarSizeLimit(MAX_NUPKG_ASAR_SIZE_BYTES + 1);
    expect(over.ok).toBe(false);
    if (over.ok === false) expect(over.error).toContain("upper limit");
    expect(checkNupkgAsarSizeLimit(-1).ok).toBe(false);
    expect(checkNupkgAsarSizeLimit(10, 5).ok).toBe(false);
  });

  it("checkNupkgEntrySizeLimit shares the cap for the payload exe with a clear label", () => {
    expect(checkNupkgEntrySizeLimit(100, 100, "payload exe")).toEqual({ ok: true });
    const over = checkNupkgEntrySizeLimit(101, 100, "payload exe");
    expect(over.ok).toBe(false);
    if (over.ok === false) {
      expect(over.error).toContain("payload exe");
      expect(over.error).toContain("upper limit");
    }
    const negative = checkNupkgEntrySizeLimit(-1, 100, "payload exe");
    expect(negative.ok).toBe(false);
    if (negative.ok === false) expect(negative.error).toContain("payload exe");
  });

  it("hasMZHeader treats an empty file as a non-executable", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-mz-"));
    try {
      const empty = path.join(base, "empty.exe");
      await writeFile(empty, Buffer.alloc(0));
      expect(await hasMZHeader(empty)).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("validateWindowsPE accepts a real x64 PE stub and rejects MZ-only blobs", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-pe-"));
    try {
      const good = path.join(base, "good.exe");
      await writeFile(good, peStub());
      expect(await validateWindowsPE(good, [MACHINE_X64])).toEqual({
        ok: true,
        machine: MACHINE_X64
      });

      // A file that merely starts with MZ is not a PE image.
      const mzOnly = path.join(base, "mz-only.exe");
      await writeFile(mzOnly, mzStub());
      expect((await validateWindowsPE(mzOnly, [MACHINE_X64])).ok).toBe(false);

      // Not MZ at all.
      const notMz = path.join(base, "not-mz.exe");
      await writeFile(notMz, "hello world", "utf8");
      expect((await validateWindowsPE(notMz, [MACHINE_X64])).ok).toBe(false);

      // Missing / invalid e_lfanew.
      const tiny = path.join(base, "tiny.exe");
      await writeFile(tiny, MZ_MAGIC);
      expect((await validateWindowsPE(tiny, [MACHINE_X64])).ok).toBe(false);
      const badOffset = path.join(base, "bad-offset.exe");
      const bad = Buffer.from(peStub());
      bad.writeUInt32LE(0x10, 0x3c);
      await writeFile(badOffset, bad);
      expect((await validateWindowsPE(badOffset, [MACHINE_X64])).ok).toBe(false);

      // The i386 (0x14c) Squirrel bootstrapper is accepted for Setup.exe
      // (BOOTSTRAPPER_MACHINES) but is NOT an x64 payload.
      const x86 = path.join(base, "x86-bootstrapper.exe");
      await writeFile(x86, x86BootstrapperStub());
      expect(await validateWindowsPE(x86, BOOTSTRAPPER_MACHINES)).toEqual({
        ok: true,
        machine: MACHINE_X86
      });
      const x86AsPayload = await validateWindowsPE(x86, [MACHINE_X64]);
      expect(x86AsPayload.ok).toBe(false);
      if (x86AsPayload.ok === false) {
        expect(x86AsPayload.error).toMatch(/not one of the expected machines/);
      }

      // Wrong machine (ARM64 instead of x64) for the payload role.
      const wrongMachine = path.join(base, "wrong-machine.exe");
      const wm = Buffer.from(peStub());
      wm.writeUInt16LE(0xaa64, MIN_PE_HEADER_OFFSET + PE_SIGNATURE.length);
      await writeFile(wrongMachine, wm);
      const wmResult = await validateWindowsPE(wrongMachine, [MACHINE_X64]);
      expect(wmResult.ok).toBe(false);
      if (wmResult.ok === false) {
        expect(wmResult.error).toMatch(/not one of the expected machines/);
      }

      // A machine NOT in BOOTSTRAPPER_MACHINES is rejected for Setup.exe too.
      const arm64Setup = path.join(base, "arm64-setup.exe");
      await writeFile(arm64Setup, wm);
      expect((await validateWindowsPE(arm64Setup, BOOTSTRAPPER_MACHINES)).ok).toBe(
        false
      );

      // Missing PE\0\0 signature at the offset.
      const noSig = path.join(base, "no-sig.exe");
      const ns = Buffer.from(peStub());
      ns.writeUInt32LE(0x01020304, MIN_PE_HEADER_OFFSET);
      await writeFile(noSig, ns);
      expect((await validateWindowsPE(noSig, [MACHINE_X64])).ok).toBe(false);

      expect(
        (await validateWindowsPE(path.join(base, "missing.exe"), [MACHINE_X64])).ok
      ).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("parsePEHeader and validateWindowsPEBuffer share the machine-list aware rules", () => {
    // The buffer core and the streaming payload validator agree on an x64 PE.
    expect(parsePEHeader(peStub(), [MACHINE_X64])).toEqual({
      ok: true,
      machine: MACHINE_X64
    });
    expect(validateWindowsPEBuffer(peStub(), [MACHINE_X64])).toEqual({
      ok: true,
      machine: MACHINE_X64
    });
    // An i386 bootstrapper stub is accepted only for the bootstrapper role.
    expect(validateWindowsPEBuffer(x86BootstrapperStub(), BOOTSTRAPPER_MACHINES))
      .toEqual({ ok: true, machine: MACHINE_X86 });
    expect(validateWindowsPEBuffer(x86BootstrapperStub(), [MACHINE_X64]).ok).toBe(
      false
    );
    // Junk and empty buffers are rejected.
    expect(parsePEHeader(Buffer.from("not a pe", "utf8"), [MACHINE_X64]).ok).toBe(
      false
    );
    expect(parsePEHeader(Buffer.alloc(0), [MACHINE_X64]).ok).toBe(false);
    // An i386 stub is rejected for the x64 payload role with a machine error.
    const rejected = validateWindowsPEBuffer(x86BootstrapperStub(), [MACHINE_X64]);
    expect(rejected.ok).toBe(false);
    if (rejected.ok === false) {
      expect(rejected.error).toMatch(/0x14c/);
    }
  });

  it("normalizeZipEntryName collapses separators, dot segments and case", () => {
    expect(normalizeZipEntryName("lib/net45/resources/app.asar")).toBe(
      "lib/net45/resources/app.asar"
    );
    expect(
      normalizeZipEntryName("lib\\net45\\resources\\app.asar")
    ).toBe("lib/net45/resources/app.asar");
    expect(
      normalizeZipEntryName("lib//net45/./resources/../resources/app.asar")
    ).toBe("lib/net45/resources/app.asar");
    expect(
      normalizeZipEntryName("LIB/NET45/RESOURCES/APP.ASAR")
    ).toBe("lib/net45/resources/app.asar");
    // Dot segments that escape the root are rejected outright.
    expect(normalizeZipEntryName("../evil.exe")).toBeNull();
    expect(normalizeZipEntryName("lib/../../evil.exe")).toBeNull();
    // A path that resolves to the root is rejected too.
    expect(normalizeZipEntryName("lib/..")).toBeNull();
  });

  it("toSquirrelVersion mirrors electron-winstaller's NuGet version form", () => {
    expect(toSquirrelVersion("0.1.0")).toBe("0.1.0");
    expect(toSquirrelVersion("1.2.3-beta.1")).toBe("1.2.3-beta1");
    expect(toSquirrelVersion("2.0.0+build.5")).toBe("2.0.0");
    expect(toSquirrelVersion("1.0.0-rc.1+build")).toBe("1.0.0-rc1");
  });

  it("deriveSquirrelArtifactNames matches the forge naming convention", async () => {
    const names = await deriveSquirrelArtifactNames();
    expect(names.setupExe).toMatch(/^SWPanel-0\.1\.0 Setup\.exe$/);
    expect(names.fullNupkg).toMatch(/^swpanel-0\.1\.0-full\.nupkg$/);
    // The names the real MakerSquirrel produces for this workspace.
    expect(names.setupExe).toBe("SWPanel-0.1.0 Setup.exe");
    expect(names.fullNupkg).toBe("swpanel-0.1.0-full.nupkg");
  });

  it("deriveNupkgPayloadEntryName derives the payload exe from the forge executableName/name", async () => {
    // The workspace forge.config.mjs sets packagerConfig.name/executableName to
    // "SWPanel", so the payload entry is exactly lib/net45/SWPanel.exe.
    expect(await deriveNupkgPayloadEntryName()).toBe(
      "lib/net45/SWPanel.exe"
    );
    // The payload entry must normalize to a stable Windows-path key so the
    // audit can enforce exact uniqueness (case-variant duplicates collide).
    expect(
      normalizeZipEntryName(await deriveNupkgPayloadEntryName())
    ).toBe("lib/net45/swpanel.exe");
  });
});

describe("auditMakerOutput", () => {
  it("accepts complete artifacts whose nupkg asar matches the canonical asar", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const runDir = path.join(root, ".scratch", "installer-runs", "run-1");
      const squirrelDir = await makeStagingSquirrelDir(runDir);
      await writeSquirrelArtifacts(squirrelDir, "canonical asar");
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath
      );
      expect(report.ok).toBe(true);
      if (report.ok !== true) return;
      expect(report.artifacts.releases).toBe(
        path.join(squirrelDir, "RELEASES")
      );
      expect(report.artifacts.setupExe).toMatch(/Setup\.exe$/);
      expect(report.artifacts.fullNupkg).toMatch(/-full\.nupkg$/);
      expect(report.nupkg.entry).toBe(REQUIRED_NUPKG_ASAR_ENTRY);
      expect(report.nupkg.found).toBe(true);
      expect(report.nupkg.sizeBytes).toBe("canonical asar".length);
      expect(report.nupkg.crc32).toBe(
        crc32(Buffer.from("canonical asar", "utf8"))
      );
      const { sha256File } = await import("../scripts/audit-asar.mjs");
      expect(report.nupkg.sha256).toBe(await sha256File(canonicalAsarPath));
      // The report records the x64 payload exe evidence: the exact entry name,
      // the x64 (0x8664) COFF machine, and the SHA-256/size/CRC-32 of the
      // decompressed payload (the entry is unique by construction of the audit).
      expect(report.payload.entry).toBe("lib/net45/SWPanel.exe");
      expect(report.payload.found).toBe(true);
      expect(report.payload.machine).toBe(MACHINE_X64);
      expect(report.payload.sizeBytes).toBe(peStub().length);
      expect(report.payload.crc32).toBe(crc32(peStub()));
      expect(report.payload.sha256).toBe(
        createHash("sha256").update(peStub()).digest("hex")
      );
      await expect(access(report.artifacts.fullNupkg)).resolves.toBeUndefined();
      await expect(access(report.artifacts.setupExe)).resolves.toBeUndefined();
      await expect(access(report.artifacts.releases)).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails when the nupkg asar does not match the canonical asar", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const runDir = path.join(root, ".scratch", "installer-runs", "run-2");
      const squirrelDir = await makeStagingSquirrelDir(runDir);
      await writeSquirrelArtifacts(squirrelDir, "tampered asar");
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath
      );
      expect(report.ok).toBe(false);
      if (report.ok !== false) return;
      expect(report.error).toMatch(/does not match the canonical asar/);
      expect(report.shaMatches).toBe(false);
      expect(report.nupkg?.found).toBe(true);
      expect(report.canonicalAsarSha256).not.toBe(report.nupkg?.sha256);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails when the nupkg does not contain the required asar entry", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const runDir = path.join(root, ".scratch", "installer-runs", "run-3");
      const squirrelDir = await makeStagingSquirrelDir(runDir);
      // The nupkg is a real ZIP (with a truthful RELEASES and a valid PE
      // Setup.exe) but contains the wrong entry; the audit must fail at the
      // missing-asar step, not earlier.
      const nupkg = zipStoreEntry("lib/net45/resources/other.txt", "nope");
      const names = await artifactNames();
      const nupkgName = names.fullNupkg;
      await writeFile(
        path.join(squirrelDir, "RELEASES"),
        makeReleasesLine(nupkgName, nupkg),
        "utf8"
      );
      await writeFile(
        path.join(squirrelDir, names.setupExe),
        peStub()
      );
      await writeFile(path.join(squirrelDir, nupkgName), nupkg);
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath
      );
      expect(report.ok).toBe(false);
      if (report.ok !== false) return;
      expect(report.error).toContain(REQUIRED_NUPKG_ASAR_ENTRY);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails when the maker output directory is missing", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const runDir = path.join(root, ".scratch", "installer-runs", "run-missing");
      await mkdir(runDir, { recursive: true });
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath
      );
      expect(report.ok).toBe(false);
      if (report.ok !== false) return;
      expect(report.error).toMatch(/is missing/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("uses the supplied expected fingerprint without re-reading the canonical asar", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const expected = {
        canonicalAsarSha256: await sha256File(canonicalAsarPath),
        canonicalAsarSizeBytes: "canonical asar".length
      };
      // With an expected fingerprint the canonical asar is not consulted: remove
      // it and the audit must still succeed against the matching nupkg entry.
      await rm(canonicalAsarPath, { force: true });
      const runDir = path.join(
        root,
        ".scratch",
        "installer-runs",
        "run-expected"
      );
      const squirrelDir = await makeStagingSquirrelDir(runDir);
      await writeSquirrelArtifacts(squirrelDir, "canonical asar");
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath,
        expected
      );
      expect(report.ok).toBe(true);
      if (report.ok !== true) return;
      expect(report.canonicalAsarSha256).toBe(expected.canonicalAsarSha256);
      expect(report.canonicalAsarSizeBytes).toBe(expected.canonicalAsarSizeBytes);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("treats the supplied expected fingerprint as authoritative over the on-disk canonical asar", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const runDir = path.join(
        root,
        ".scratch",
        "installer-runs",
        "run-authoritative"
      );
      const squirrelDir = await makeStagingSquirrelDir(runDir);
      // The nupkg asar DOES match the on-disk canonical asar...
      await writeSquirrelArtifacts(squirrelDir, "canonical asar");
      // ...but the expected fingerprint says otherwise, so the audit must fail.
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath,
        {
          canonicalAsarSha256: "bogus-expected-sha",
          canonicalAsarSizeBytes: "canonical asar".length
        }
      );
      expect(report.ok).toBe(false);
      if (report.ok !== false) return;
      expect(report.shaMatches).toBe(false);
      expect(report.canonicalAsarSha256).toBe("bogus-expected-sha");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails when the Setup.exe is not a real MZ executable", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const runDir = path.join(root, ".scratch", "installer-runs", "run-mz");
      const squirrelDir = await makeStagingSquirrelDir(runDir);
      await writeSquirrelArtifacts(squirrelDir, "canonical asar");
      await writeFile(
        path.join(squirrelDir, "SWPanel-0.1.0 Setup.exe"),
        "this is not a PE executable",
        "utf8"
      );
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath
      );
      expect(report.ok).toBe(false);
      if (report.ok !== false) return;
      expect(report.error).toMatch(/MZ|PE executable/i);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails when RELEASES does not truthfully describe the full.nupkg", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const runDir = path.join(root, ".scratch", "installer-runs", "run-rel");
      const squirrelDir = await makeStagingSquirrelDir(runDir);
      await writeSquirrelArtifacts(squirrelDir, "canonical asar");
      // The nupkg is unchanged but the RELEASES size claim is wrong.
      const names = await artifactNames();
      const fullNupkgPath = path.join(
        squirrelDir,
        names.fullNupkg
      );
      const nupkg = await readFile(fullNupkgPath);
      await writeFile(
        path.join(squirrelDir, "RELEASES"),
        `${"A".repeat(40)} ${names.fullNupkg} ${nupkg.length - 1}\n`,
        "utf8"
      );
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath
      );
      expect(report.ok).toBe(false);
      if (report.ok !== false) return;
      expect(report.error).toMatch(/RELEASES/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails when the full.nupkg contains duplicate app.asar entries", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const runDir = path.join(root, ".scratch", "installer-runs", "run-dup");
      const squirrelDir = await makeStagingSquirrelDir(runDir);
      // Same entry twice in the ZIP: the audit must reject ambiguity outright.
      const nupkg = zipEntries([
        { name: REQUIRED_NUPKG_ASAR_ENTRY, content: "canonical asar" },
        { name: REQUIRED_NUPKG_ASAR_ENTRY, content: "canonical asar" }
      ]);
      const names = await artifactNames();
      const nupkgName = names.fullNupkg;
      await writeFile(path.join(squirrelDir, nupkgName), nupkg);
      await writeFile(
        path.join(squirrelDir, names.setupExe),
        peStub()
      );
      await writeFile(
        path.join(squirrelDir, "RELEASES"),
        makeReleasesLine(nupkgName, nupkg),
        "utf8"
      );
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath
      );
      expect(report.ok).toBe(false);
      if (report.ok !== false) return;
      expect(report.error).toContain(REQUIRED_NUPKG_ASAR_ENTRY);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails when the nupkg app.asar bytes do not carry the declared CRC-32", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const runDir = path.join(root, ".scratch", "installer-runs", "run-crc");
      const squirrelDir = await makeStagingSquirrelDir(runDir);
      // Corrupt the single byte of the app.asar inside an otherwise valid ZIP:
      // the declared CRC-32 no longer matches the decompressed bytes.
      const zip = Buffer.from(
        zipStoreEntry(REQUIRED_NUPKG_ASAR_ENTRY, "canonical asar")
      );
      const offset = zip.indexOf(Buffer.from("canonical asar", "utf8"));
      expect(offset).toBeGreaterThan(0);
      zip[offset] = 0x78; // flip one byte of the stored data
      const names = await artifactNames();
      const nupkgName = names.fullNupkg;
      await writeFile(path.join(squirrelDir, nupkgName), zip);
      await writeFile(
        path.join(squirrelDir, names.setupExe),
        peStub()
      );
      await writeFile(
        path.join(squirrelDir, "RELEASES"),
        makeReleasesLine(nupkgName, zip),
        "utf8"
      );
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath
      );
      expect(report.ok).toBe(false);
      if (report.ok !== false) return;
      expect(report.error).toMatch(/CRC-32/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails when the nupkg app.asar exceeds the size cap", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const runDir = path.join(root, ".scratch", "installer-runs", "run-size");
      const squirrelDir = await makeStagingSquirrelDir(runDir);
      await writeSquirrelArtifacts(squirrelDir, "canonical asar");
      const expected = {
        canonicalAsarSha256: await sha256File(canonicalAsarPath),
        canonicalAsarSizeBytes: "canonical asar".length,
        // The asar is 14 bytes; a 10-byte cap is implausible in production but
        // proves the cap check runs before the fingerprint comparison. The cap
        // is SHARED: it also bounds the payload exe entry.
        maxNupkgEntrySizeBytes: 10
      };
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath,
        expected
      );
      expect(report.ok).toBe(false);
      if (report.ok !== false) return;
      expect(report.error).toMatch(/upper limit/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails when the full.nupkg does not contain the x64 payload exe entry", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const runDir = path.join(root, ".scratch", "installer-runs", "run-nopayload");
      const squirrelDir = await makeStagingSquirrelDir(runDir);
      // The nupkg is a real ZIP with the app.asar but WITHOUT the payload exe;
      // the audit must fail at the missing-payload step, not earlier.
      const nupkg = zipStoreEntry(REQUIRED_NUPKG_ASAR_ENTRY, "canonical asar");
      const names = await artifactNames();
      const nupkgName = names.fullNupkg;
      await writeFile(path.join(squirrelDir, nupkgName), nupkg);
      await writeFile(path.join(squirrelDir, names.setupExe), x86BootstrapperStub());
      await writeFile(
        path.join(squirrelDir, "RELEASES"),
        makeReleasesLine(nupkgName, nupkg),
        "utf8"
      );
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath
      );
      expect(report.ok).toBe(false);
      if (report.ok !== false) return;
      expect(report.error).toContain("lib/net45/SWPanel.exe");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails when the payload exe is an x86 (i386) PE instead of x64", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const runDir = path.join(root, ".scratch", "installer-runs", "run-x86payload");
      const squirrelDir = await makeStagingSquirrelDir(runDir);
      // The nupkg contains the asar and a payload entry, but the payload is a
      // 0x14c i386 image: it is not the x64 target evidence the audit demands.
      await writeSquirrelArtifacts(squirrelDir, "canonical asar", x86BootstrapperStub());
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath
      );
      expect(report.ok).toBe(false);
      if (report.ok !== false) return;
      expect(report.error).toMatch(/payload exe/);
      expect(report.error).toMatch(/0x8664|expected machines/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("accepts a valid x64 (0x8664) Setup.exe bootstrapper alongside the standard 0x14c", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const runDir = path.join(
        root,
        ".scratch",
        "installer-runs",
        "run-x64setup"
      );
      const squirrelDir = await makeStagingSquirrelDir(runDir);
      // A future electron-winstaller may emit an x64 bootstrapper; the audit
      // must accept it for Setup.exe (BOOTSTRAPPER_MACHINES = [0x14c, 0x8664])
      // while the payload exe stays the real x64 target evidence.
      const names = await artifactNames();
      const payloadEntry = await deriveNupkgPayloadEntryName();
      const nupkg = zipEntries([
        { name: REQUIRED_NUPKG_ASAR_ENTRY, content: "canonical asar" },
        { name: payloadEntry, content: peStub() }
      ]);
      await writeFile(path.join(squirrelDir, names.fullNupkg), nupkg);
      await writeFile(path.join(squirrelDir, names.setupExe), peStub());
      await writeFile(
        path.join(squirrelDir, "RELEASES"),
        makeReleasesLine(names.fullNupkg, nupkg),
        "utf8"
      );
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath
      );
      expect(report.ok).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails when the payload exe exceeds the shared size cap", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const runDir = path.join(
        root,
        ".scratch",
        "installer-runs",
        "run-payloadcap"
      );
      const squirrelDir = await makeStagingSquirrelDir(runDir);
      await writeSquirrelArtifacts(squirrelDir, "canonical asar");
      // The asar is 14 bytes and fits a 30-byte cap, but the payload exe stub
      // (70 bytes) does not: the shared cap must reject the payload entry even
      // though the asar passes every check.
      const expected = {
        canonicalAsarSha256: await sha256File(canonicalAsarPath),
        canonicalAsarSizeBytes: "canonical asar".length,
        maxNupkgEntrySizeBytes: 30
      };
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath,
        expected
      );
      expect(report.ok).toBe(false);
      if (report.ok !== false) return;
      expect(report.error).toMatch(/payload exe/);
      expect(report.error).toMatch(/upper limit/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails when the payload exe is corrupt (not a real PE)", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const runDir = path.join(root, ".scratch", "installer-runs", "run-corruptpayload");
      const squirrelDir = await makeStagingSquirrelDir(runDir);
      // The payload entry exists but is an MZ-only blob (no PE header) and must
      // be rejected as not a real PE image even though it is unique and its
      // CRC-32/size claims are truthful.
      await writeSquirrelArtifacts(squirrelDir, "canonical asar", mzStub());
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath
      );
      expect(report.ok).toBe(false);
      if (report.ok !== false) return;
      expect(report.error).toMatch(/payload exe/);
      expect(report.error).toMatch(/MZ|PE/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails when the payload exe bytes do not carry the declared CRC-32", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const runDir = path.join(root, ".scratch", "installer-runs", "run-pcrc");
      const squirrelDir = await makeStagingSquirrelDir(runDir);
      // Flip one byte inside the stored payload exe: the declared CRC-32 no
      // longer matches the decompressed bytes and the nupkg is corrupt.
      const names = await artifactNames();
      const payloadEntry = await deriveNupkgPayloadEntryName();
      const zip = Buffer.from(
        zipEntries([
          { name: REQUIRED_NUPKG_ASAR_ENTRY, content: "canonical asar" },
          { name: payloadEntry, content: peStub() }
        ])
      );
      const offset = zip.indexOf(peStub());
      expect(offset).toBeGreaterThan(0);
      zip[offset] = 0x42; // flip one byte of the stored payload
      const nupkgName = names.fullNupkg;
      await writeFile(path.join(squirrelDir, nupkgName), zip);
      await writeFile(path.join(squirrelDir, names.setupExe), x86BootstrapperStub());
      await writeFile(
        path.join(squirrelDir, "RELEASES"),
        makeReleasesLine(nupkgName, zip),
        "utf8"
      );
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath
      );
      expect(report.ok).toBe(false);
      if (report.ok !== false) return;
      expect(report.error).toMatch(/payload exe/);
      expect(report.error).toMatch(/CRC-32/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails when the payload exe has a case-variant duplicate in the nupkg", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const runDir = path.join(root, ".scratch", "installer-runs", "run-dupkey");
      const squirrelDir = await makeStagingSquirrelDir(runDir);
      const names = await artifactNames();
      const payloadEntry = await deriveNupkgPayloadEntryName();
      // The same Windows path spelled twice (case variant) would extract into
      // one file; the archive is ambiguous and must be rejected outright.
      const nupkg = zipEntries([
        { name: REQUIRED_NUPKG_ASAR_ENTRY, content: "canonical asar" },
        { name: payloadEntry, content: peStub() },
        { name: "lib/net45/SWPANEL.EXE", content: peStub() }
      ]);
      const nupkgName = names.fullNupkg;
      await writeFile(path.join(squirrelDir, nupkgName), nupkg);
      await writeFile(path.join(squirrelDir, names.setupExe), x86BootstrapperStub());
      await writeFile(
        path.join(squirrelDir, "RELEASES"),
        makeReleasesLine(nupkgName, nupkg),
        "utf8"
      );
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath
      );
      expect(report.ok).toBe(false);
      if (report.ok !== false) return;
      expect(report.error).toMatch(/ambiguous|collides/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails when more than one Setup.exe is present", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const runDir = path.join(root, ".scratch", "installer-runs", "run-2exe");
      const squirrelDir = await makeStagingSquirrelDir(runDir);
      await writeSquirrelArtifacts(squirrelDir, "canonical asar");
      const names = await artifactNames();
      await writeFile(
        path.join(squirrelDir, `${names.setupExe.replace(/\.exe$/i, " 2.exe")}`),
        mzStub()
      );
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath
      );
      expect(report.ok).toBe(false);
      if (report.ok !== false) return;
      expect(report.error).toMatch(/unexpected executables/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails when more than one full.nupkg is present", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const runDir = path.join(root, ".scratch", "installer-runs", "run-2nupkg");
      const squirrelDir = await makeStagingSquirrelDir(runDir);
      await writeSquirrelArtifacts(squirrelDir, "canonical asar");
      const names = await artifactNames();
      const nupkg = zipStoreEntry(REQUIRED_NUPKG_ASAR_ENTRY, "canonical asar");
      await writeFile(
        path.join(squirrelDir, `${names.fullNupkg.replace(/-full\.nupkg$/i, "-second-full.nupkg")}`),
        nupkg
      );
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath
      );
      expect(report.ok).toBe(false);
      if (report.ok !== false) return;
      expect(report.error).toMatch(/unexpected full packages/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails when the expected Setup.exe basename is missing even with a real PE sibling", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const runDir = path.join(root, ".scratch", "installer-runs", "run-namesetup");
      const squirrelDir = await makeStagingSquirrelDir(runDir);
      const names = await artifactNames();
      const nupkg = zipStoreEntry(REQUIRED_NUPKG_ASAR_ENTRY, "canonical asar");
      await writeFile(path.join(squirrelDir, names.fullNupkg), nupkg);
      // A REAL x64 PE under a DIFFERENT name (a misnamed blob) must be rejected.
      await writeFile(path.join(squirrelDir, "Wrong-Name Setup.exe"), peStub());
      await writeFile(
        path.join(squirrelDir, "RELEASES"),
        makeReleasesLine(names.fullNupkg, nupkg),
        "utf8"
      );
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath
      );
      expect(report.ok).toBe(false);
      if (report.ok !== false) return;
      expect(report.error).toContain(names.setupExe);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails when the expected full.nupkg basename is missing even with a truthful RELEASES", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const runDir = path.join(root, ".scratch", "installer-runs", "run-namenupkg");
      const squirrelDir = await makeStagingSquirrelDir(runDir);
      const names = await artifactNames();
      const nupkg = zipStoreEntry(REQUIRED_NUPKG_ASAR_ENTRY, "canonical asar");
      // A misnamed nupkg whose RELEASES truthfully describes IT still fails
      // because the on-disk name is not the expected derived basename.
      const wrongName = "SWPanel-9.9.9-full.nupkg";
      await writeFile(path.join(squirrelDir, wrongName), nupkg);
      await writeFile(path.join(squirrelDir, names.setupExe), peStub());
      await writeFile(
        path.join(squirrelDir, "RELEASES"),
        makeReleasesLine(wrongName, nupkg),
        "utf8"
      );
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath
      );
      expect(report.ok).toBe(false);
      if (report.ok !== false) return;
      expect(report.error).toContain(names.fullNupkg);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails when ZIP entries collide under Windows path normalization", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const runDir = path.join(root, ".scratch", "installer-runs", "run-collide");
      const squirrelDir = await makeStagingSquirrelDir(runDir);
      // A case-variant entry normalizes (casefold) to the same Windows path as
      // the required entry, so the archive would extract two files into one and
      // is ambiguous. yauzl accepts both spellings; only the audit's
      // Windows-path normalization must catch the collision.
      const nupkg = zipEntries([
        { name: REQUIRED_NUPKG_ASAR_ENTRY, content: "canonical asar" },
        {
          name: "lib/net45/RESOURCES/APP.ASAR",
          content: "other asar"
        }
      ]);
      const names = await artifactNames();
      await writeFile(path.join(squirrelDir, names.fullNupkg), nupkg);
      await writeFile(path.join(squirrelDir, names.setupExe), peStub());
      await writeFile(
        path.join(squirrelDir, "RELEASES"),
        makeReleasesLine(names.fullNupkg, nupkg),
        "utf8"
      );
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath
      );
      expect(report.ok).toBe(false);
      if (report.ok !== false) return;
      expect(report.error).toMatch(/ambiguous|collides/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails when the declared nupkg asar size does not match the expected canonical size", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const runDir = path.join(root, ".scratch", "installer-runs", "run-declsize");
      const squirrelDir = await makeStagingSquirrelDir(runDir);
      await writeSquirrelArtifacts(squirrelDir, "canonical asar");
      // The expected canonical size says 999 bytes; the declared entry is 14.
      const expected = {
        canonicalAsarSha256: await sha256File(canonicalAsarPath),
        canonicalAsarSizeBytes: 999
      };
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath,
        expected
      );
      expect(report.ok).toBe(false);
      if (report.ok !== false) return;
      expect(report.error).toMatch(/declares the asar entry/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails when the nupkg declares a size that does not match its stored payload", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const runDir = path.join(root, ".scratch", "installer-runs", "run-lying");
      const squirrelDir = await makeStagingSquirrelDir(runDir);
      // The central/local directory LIES about the uncompressed size (10 bytes)
      // while the real stored payload is 14 bytes. The archive is structurally
      // hostile and must never reach fingerprint comparison.
      const nupkg = zipEntries([
        {
          name: REQUIRED_NUPKG_ASAR_ENTRY,
          content: "canonical asar",
          declaredUncompressedSize: 10
        }
      ]);
      const names = await artifactNames();
      await writeFile(path.join(squirrelDir, names.fullNupkg), nupkg);
      await writeFile(path.join(squirrelDir, names.setupExe), peStub());
      await writeFile(
        path.join(squirrelDir, "RELEASES"),
        makeReleasesLine(names.fullNupkg, nupkg),
        "utf8"
      );
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath
      );
      expect(report.ok).toBe(false);
      if (report.ok !== false) return;
      // The exact message is the underlying archive error; what matters is that
      // a self-inconsistent archive is rejected outright.
      expect(report.error).toMatch(/size mismatch|invalid|Cannot audit/i);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails when RELEASES references an artifact that is not on disk", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audinst-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const runDir = path.join(root, ".scratch", "installer-runs", "run-ghost");
      const squirrelDir = await makeStagingSquirrelDir(runDir);
      const names = await artifactNames();
      const nupkg = zipStoreEntry(REQUIRED_NUPKG_ASAR_ENTRY, "canonical asar");
      await writeFile(path.join(squirrelDir, names.fullNupkg), nupkg);
      await writeFile(path.join(squirrelDir, names.setupExe), peStub());
      // A truthful full line plus a delta line naming a blob that is not on disk.
      await writeFile(
        path.join(squirrelDir, "RELEASES"),
        makeReleasesLine(
          names.fullNupkg,
          nupkg,
          "ABCDEF0123456789ABCDEF0123456789ABCDEF01 ghost-delta.nupkg 5"
        ),
        "utf8"
      );
      const report = await auditMakerOutput(
        path.join(runDir, "out"),
        canonicalAsarPath
      );
      expect(report.ok).toBe(false);
      if (report.ok !== false) return;
      expect(report.error).toMatch(/not present on disk/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("auditCanonicalInstallers", () => {
  it("audits the canonical installers directory in place and reports canonical paths", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audcan-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      // The canonical installers dir holds the squirrel output directly.
      const installersDir = path.join(root, "installers");
      await writeSquirrelArtifacts(installersDir, "canonical asar");
      const names = await artifactNames();
      const report = await auditCanonicalInstallers(
        installersDir,
        canonicalAsarPath
      );
      expect(report.ok).toBe(true);
      if (report.ok !== true) return;
      expect(report.makerOutputDir).toBe(installersDir);
      expect(report.artifacts.releases).toBe(path.join(installersDir, "RELEASES"));
      expect(report.artifacts.setupExe).toBe(
        path.join(installersDir, names.setupExe)
      );
      expect(report.artifacts.fullNupkg).toBe(
        path.join(installersDir, names.fullNupkg)
      );
      await expect(access(report.artifacts.fullNupkg)).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails when the canonical installers directory is missing", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-audcan-"));
    try {
      const root = path.join(base, "repo");
      const canonicalAsarPath = await makeCanonicalOut(root, "canonical asar");
      const report = await auditCanonicalInstallers(
        path.join(root, "installers"),
        canonicalAsarPath
      );
      expect(report.ok).toBe(false);
      if (report.ok !== false) return;
      expect(report.error).toMatch(/is missing/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("rollbackPublishedInstallers", () => {
  it("moves the published canonical installers back into the per-run squirrel output", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-rollback-"));
    try {
      const root = path.join(base, "repo");
      const installersPath = path.join(root, "installers");
      await writeSquirrelArtifacts(installersPath, "canonical asar");
      const names = await artifactNames();
      const runDir = path.join(root, ".scratch", "installer-runs", "run-1");
      await rollbackPublishedInstallers(installersPath, runDir, root);
      // The canonical installers is absent again...
      await expect(access(installersPath)).rejects.toThrow();
      // ...and the output is back at the per-run squirrel location.
      await expect(
        access(
          path.join(
            runDir,
            "out",
            "make",
            "squirrel.windows",
            "x64",
            names.fullNupkg
          )
        )
      ).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("refuses to roll back an installers path outside the workspace", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-rollback-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(root, { recursive: true });
      const runDir = path.join(root, ".scratch", "installer-runs", "run-1");
      await mkdir(path.join(base, "outside"), { recursive: true });
      await expect(
        rollbackPublishedInstallers(path.join(base, "outside"), runDir, root)
      ).rejects.toThrow(/outside the workspace/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("createInstallerRun / stageCanonicalPackage / locks", () => {
  it("creates a uuid-scoped run directory under .scratch/installer-runs", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-runinst-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(root, { recursive: true });
      const run = await createInstallerRun(root);
      expect(run.stagingOut).toBe(path.join(run.runDir, "out"));
      await expect(
        access(path.join(run.runDir, "run.json"))
      ).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("stages the canonical packaged app copy into the run staging out", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-stageinst-"));
    try {
      const root = path.join(base, "repo");
      // A normal tree with deeper nesting exercises the recursive walk and
      // must pass: only real files and directories are allowed.
      await mkdir(
        path.join(root, "out", "SWPanel-win32-x64", "resources", "nested", "deep"),
        { recursive: true }
      );
      await writeFile(
        path.join(root, "out", "SWPanel-win32-x64", "resources", "app.asar"),
        "canonical asar",
        "utf8"
      );
      await writeFile(
        path.join(
          root,
          "out",
          "SWPanel-win32-x64",
          "resources",
          "nested",
          "deep",
          "extra.bin"
        ),
        "extra bytes",
        "utf8"
      );
      const runDir = path.join(root, ".scratch", "installer-runs", "run-1");
      await mkdir(runDir, { recursive: true });
      const staged = await stageCanonicalPackage(root, runDir, path.join(root, "out"));
      expect(staged).toBe(path.join(runDir, "out", "SWPanel-win32-x64"));
      const stagedAsar = path.join(
        staged,
        "resources",
        "app.asar"
      );
      await expect(access(stagedAsar)).resolves.toBeUndefined();
      expect((await stat(stagedAsar)).size).toBe("canonical asar".length);
      await expect(
        access(path.join(staged, "resources", "nested", "deep", "extra.bin"))
      ).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("refuses to stage when the canonical package tree contains a junction/symlink pointing outside", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-stageinst-"));
    try {
      const root = path.join(base, "repo");
      const outside = path.join(base, "outside");
      await mkdir(path.join(root, "out", "SWPanel-win32-x64", "resources"), {
        recursive: true
      });
      await mkdir(outside, { recursive: true });
      await writeFile(
        path.join(root, "out", "SWPanel-win32-x64", "resources", "app.asar"),
        "canonical asar",
        "utf8"
      );
      const runDir = path.join(root, ".scratch", "installer-runs", "run-ext");
      await mkdir(runDir, { recursive: true });
      // A nested junction/symlink DEEP inside the canonical tree (not at its
      // root) whose target resolves outside the workspace.
      const linkPath = path.join(root, "out", "SWPanel-win32-x64", "external");
      try {
        await symlink(
          outside,
          linkPath,
          process.platform === "win32" ? "junction" : "dir"
        );
      } catch {
        return; // platform/fs without link support: skip
      }
      await expect(
        stageCanonicalPackage(root, runDir, path.join(root, "out"))
      ).rejects.toThrow(/symbolic link, junction, or reparse point/);
      // The staged copy must not exist: staging aborted before copying.
      await expect(
        access(path.join(runDir, "out", "SWPanel-win32-x64"))
      ).rejects.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("refuses to stage when the canonical package tree contains an internal junction/symlink", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-stageinst-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(path.join(root, "out", "SWPanel-win32-x64", "resources"), {
        recursive: true
      });
      await writeFile(
        path.join(root, "out", "SWPanel-win32-x64", "resources", "app.asar"),
        "canonical asar",
        "utf8"
      );
      const runDir = path.join(root, ".scratch", "installer-runs", "run-int");
      await mkdir(runDir, { recursive: true });
      // The link points INSIDE the tree (at its own resources sibling) and
      // must still be rejected: no link of any kind belongs in the package.
      const linkPath = path.join(
        root,
        "out",
        "SWPanel-win32-x64",
        "resources",
        "alias"
      );
      try {
        await symlink(
          path.join(root, "out", "SWPanel-win32-x64", "resources"),
          linkPath,
          process.platform === "win32" ? "junction" : "dir"
        );
      } catch {
        return; // platform/fs without link support: skip
      }
      await expect(
        stageCanonicalPackage(root, runDir, path.join(root, "out"))
      ).rejects.toThrow(/symbolic link, junction, or reparse point/);
      // The staged copy must not exist: staging aborted before copying.
      await expect(
        access(path.join(runDir, "out", "SWPanel-win32-x64"))
      ).rejects.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("refuses to stage when the staged copy contains a link (post-copy verification)", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-stageinst-"));
    try {
      const root = path.join(base, "repo");
      const outside = path.join(base, "outside");
      await mkdir(path.join(root, "out", "SWPanel-win32-x64", "resources"), {
        recursive: true
      });
      await mkdir(outside, { recursive: true });
      await writeFile(
        path.join(root, "out", "SWPanel-win32-x64", "resources", "app.asar"),
        "canonical asar",
        "utf8"
      );
      const runDir = path.join(root, ".scratch", "installer-runs", "run-post");
      await mkdir(runDir, { recursive: true });
      // A clean tree stages successfully first.
      const staged = await stageCanonicalPackage(root, runDir, path.join(root, "out"));
      // Inject a junction deep inside the staged copy (simulates a link that
      // appeared between the pre-copy walk and the copy).
      const linkPath = path.join(staged, "resources", "sneak");
      try {
        await symlink(
          outside,
          linkPath,
          process.platform === "win32" ? "junction" : "dir"
        );
      } catch {
        return; // platform/fs without link support: skip
      }
      // Re-stage into the same run dir: fs.cp merges into the existing staged
      // directory and leaves the injected link untouched, so the post-copy
      // walk must reject it before it can reach Forge.
      await expect(
        stageCanonicalPackage(root, runDir, path.join(root, "out"))
      ).rejects.toThrow(/symbolic link, junction, or reparse point/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("refuses to stage when the staged destination is pre-created as a junction pointing outside", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-stageinst-"));
    try {
      const root = path.join(base, "repo");
      const outside = path.join(base, "outside");
      await mkdir(path.join(root, "out", "SWPanel-win32-x64", "resources"), {
        recursive: true
      });
      await mkdir(outside, { recursive: true });
      await writeFile(
        path.join(root, "out", "SWPanel-win32-x64", "resources", "app.asar"),
        "canonical asar",
        "utf8"
      );
      const runDir = path.join(root, ".scratch", "installer-runs", "run-dest");
      const stagingOut = path.join(runDir, "out");
      await mkdir(stagingOut, { recursive: true });
      // Pre-create the staged destination itself as a junction to outside.
      // fs.cp would otherwise follow it and write through to the link target.
      const staged = path.join(stagingOut, "SWPanel-win32-x64");
      try {
        await symlink(
          outside,
          staged,
          process.platform === "win32" ? "junction" : "dir"
        );
      } catch {
        return; // platform/fs without link support: skip
      }
      await expect(
        stageCanonicalPackage(root, runDir, path.join(root, "out"))
      ).rejects.toThrow(/symbolic link, junction, or reparse point/);
      // Nothing was written through the junction into the outside target.
      await expect(readdir(outside)).resolves.toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("refuses to stage when the canonical packaged app is missing", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-stageinst-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(root, { recursive: true });
      const runDir = path.join(root, ".scratch", "installer-runs", "run-missing");
      await mkdir(runDir, { recursive: true });
      await expect(
        stageCanonicalPackage(root, runDir, path.join(root, "out"))
      ).rejects.toThrow(/does not exist/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("recognizes Windows installer file lock errors and formats an actionable message", () => {
    expect(isWindowsFileLock({ code: "EBUSY" })).toBe(true);
    const message = formatLockedInstallersError("F:\\installers", { code: "EPERM" });
    expect(message).toContain("F:\\installers");
    expect(message).toContain("make:win again");
    expect(message).toContain("aborted");
    expect(installerRunsRoot).toMatch(/[\\/]\.scratch[\\/]installer-runs/);
  });

  it("verifyStagedAsar rejects a staged asar that drifts from the expected fingerprint", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-verify-"));
    try {
      const root = path.join(base, "repo");
      const stagedAsar = path.join(
        root,
        ".scratch",
        "installer-runs",
        "run-1",
        "resources",
        "app.asar"
      );
      await mkdir(path.dirname(stagedAsar), { recursive: true });
      await writeFile(stagedAsar, "tampered", "utf8");
      const mismatch = await verifyStagedAsar(stagedAsar, {
        canonicalAsarSha256: "expected-sha",
        sizeBytes: 7
      });
      expect(mismatch.ok).toBe(false);
      if (mismatch.ok !== false) return;
      expect(mismatch.error).toMatch(/does not match the expected canonical fingerprint/);
      const sha = await sha256File(stagedAsar);
      expect(
        await verifyStagedAsar(stagedAsar, {
          canonicalAsarSha256: sha,
          sizeBytes: 8
        })
      ).toEqual({ ok: true });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
