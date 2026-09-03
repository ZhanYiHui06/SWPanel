import { describe, expect, it } from "vitest";

import {
  isSolidWorksOwnedStage,
  normalizeRegistryPath,
  readSolidWorksOwnershipRegistry,
  SOLIDWORKS_OWNED_STAGES,
  SOLIDWORKS_OWNERSHIP_FILE_RELATIVE_PATH,
  SOLIDWORKS_OWNERSHIP_MAX_DOCUMENTS,
  SOLIDWORKS_OWNERSHIP_SCHEMA_VERSION,
  validateSolidWorksOwnershipRegistry,
  type SolidWorksOwnershipRegistryBinding
} from "./solidworks-ownership-registry.js";

const BINDING: SolidWorksOwnershipRegistryBinding = {
  runId: "run-1",
  attemptId: "attempt-1",
  attemptSequence: 1
};

function validRegistry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: SOLIDWORKS_OWNERSHIP_SCHEMA_VERSION,
    runId: "run-1",
    attemptId: "attempt-1",
    attemptSequence: 1,
    updatedAt: "2026-08-16T09:00:00.000Z",
    documents: ["working/plate.sldprt"],
    ...overrides
  };
}

/** In-memory read surface: absent by default, settable per test. */
function readSurface(content: string | null): {
  surface: { readOwnedFile(): Buffer | null };
  setContent: (value: string | null) => void;
} {
  let current: string | null = content;
  return {
    surface: {
      readOwnedFile: () => (current === null ? null : Buffer.from(current, "utf8"))
    },
    setContent: (value) => {
      current = value;
    }
  };
}

describe("validateSolidWorksOwnershipRegistry (contract)", () => {
  it("accepts a well-formed attempt-scoped registry and normalizes its ONE document", () => {
    const record = validateSolidWorksOwnershipRegistry(
      validRegistry({
        documents: ["working/plate.sldprt"]
      }),
      BINDING
    );
    expect(record).not.toBeNull();
    expect(record?.documents).toEqual(["working/plate.sldprt"]);
    expect(Object.isFrozen(record?.documents)).toBe(true);
  });

  it("rejects unknown fields and a wrong schema version (fail closed)", () => {
    expect(validateSolidWorksOwnershipRegistry(validRegistry({ extra: 1 }), BINDING)).toBeNull();
    expect(
      validateSolidWorksOwnershipRegistry(validRegistry({ schemaVersion: 999 }), BINDING)
    ).toBeNull();
    expect(validateSolidWorksOwnershipRegistry(null, BINDING)).toBeNull();
    expect(validateSolidWorksOwnershipRegistry("not an object", BINDING)).toBeNull();
    expect(validateSolidWorksOwnershipRegistry([], BINDING)).toBeNull();
  });

  it("rejects a binding mismatch (the registry of another run/attempt/sequence)", () => {
    expect(
      validateSolidWorksOwnershipRegistry(
        validRegistry({ runId: "run-2" }),
        BINDING
      )
    ).toBeNull();
    expect(
      validateSolidWorksOwnershipRegistry(
        validRegistry({ attemptId: "attempt-2" }),
        BINDING
      )
    ).toBeNull();
    expect(
      validateSolidWorksOwnershipRegistry(
        validRegistry({ attemptSequence: 2 }),
        BINDING
      )
    ).toBeNull();
  });

  it("rejects non-ISO and malformed timestamps", () => {
    expect(validateSolidWorksOwnershipRegistry(validRegistry({ updatedAt: "yesterday" }), BINDING)).toBeNull();
    expect(validateSolidWorksOwnershipRegistry(validRegistry({ updatedAt: 42 }), BINDING)).toBeNull();
    expect(validateSolidWorksOwnershipRegistry(validRegistry({ updatedAt: "" }), BINDING)).toBeNull();
  });

  it("rejects an EMPTY document list and a list of only duplicates (fail closed)", () => {
    expect(validateSolidWorksOwnershipRegistry(validRegistry({ documents: [] }), BINDING)).toBeNull();
    // The single-part maximum counts the RAW list: two entries — even the same
    // document twice — already exceed the one-entry contract and are INVALID
    // (the Agent updates the ONE entry, never appends).
    expect(validateSolidWorksOwnershipRegistry(validRegistry({ documents: ["p.sldprt", "p.sldprt"] }), BINDING))
      .toBeNull();
    expect(
      validateSolidWorksOwnershipRegistry(
        validRegistry({ documents: [] as unknown as string[] }),
        BINDING
      )
    ).toBeNull();
    expect(validateSolidWorksOwnershipRegistry(validRegistry({ documents: "p.sldprt" }), BINDING)).toBeNull();
  });

  it("normalizes one entry and keeps its canonical spelling", () => {
    const record = validateSolidWorksOwnershipRegistry(
      validRegistry({
        documents: ["working/PLATE.SLDPRT"]
      }),
      BINDING
    );
    expect(record?.documents).toEqual(["working/PLATE.SLDPRT"]);
  });
});

describe("SOLIDWORKS_OWNERSHIP_MAX_DOCUMENTS (Phase 5 single-part contract)", () => {
  it("exports a maximum of exactly ONE document", () => {
    expect(SOLIDWORKS_OWNERSHIP_MAX_DOCUMENTS).toBe(1);
  });

  it("rejects a RAW document list of more than one entry — even duplicates or case variants of one document (fail closed)", () => {
    expect(
      validateSolidWorksOwnershipRegistry(
        validRegistry({ documents: ["working/a.sldprt", "working/b.sldprt"] }),
        BINDING
      )
    ).toBeNull();
    // Case variants of the SAME document still exceed the raw maximum: the
    // Agent updates the single entry in place, it never writes two entries.
    expect(
      validateSolidWorksOwnershipRegistry(
        validRegistry({ documents: ["working/a.sldprt", "working/a.SLDPRT"] }),
        BINDING
      )
    ).toBeNull();
  });

  it("rejects a NORMALIZED (case-insensitively deduplicated) set of more than one distinct document (fail closed)", () => {
    expect(
      validateSolidWorksOwnershipRegistry(
        validRegistry({
          documents: ["working/a.sldprt", "working/B.sldprt", "working/a.SLDPRT"]
        }),
        BINDING
      )
    ).toBeNull();
    // Two DISTINCT documents survive dedupe -> still invalid.
    expect(
      validateSolidWorksOwnershipRegistry(
        validRegistry({ documents: ["working/a.sldprt", "working/b.SLDPRT"] }),
        BINDING
      )
    ).toBeNull();
  });

  it("accepts exactly ONE document (planned path or updated saved path)", () => {
    for (const documents of [
      ["working/plate.sldprt"],
      ["output/plate-model.sldprt"],
      ["working/底板-法兰.sldprt"]
    ]) {
      expect(validateSolidWorksOwnershipRegistry(validRegistry({ documents }), BINDING)).not.toBeNull();
    }
  });
});

describe("normalizeRegistryPath (path containment)", () => {
  it("accepts forward-slash and backslash attempt-relative paths", () => {
    expect(normalizeRegistryPath("working/plate.sldprt")).toBe("working/plate.sldprt");
    expect(normalizeRegistryPath("working\\plate.sldprt")).toBe("working/plate.sldprt");
    expect(normalizeRegistryPath("plate.sldprt")).toBe("plate.sldprt");
  });

  it("accepts Windows-Unicode paths verbatim (never mojibake)", () => {
    expect(normalizeRegistryPath("working/底板-法兰.sldprt")).toBe("working/底板-法兰.sldprt");
    expect(normalizeRegistryPath("output/支架 组件-Δ.sldprt")).toBe("output/支架 组件-Δ.sldprt");
  });

  it("accepts any case of the .sldprt extension (case-insensitive filesystem)", () => {
    expect(normalizeRegistryPath("working/plate.SLDPRT")).toBe("working/plate.SLDPRT");
    expect(normalizeRegistryPath("working/plate.SldPrt")).toBe("working/plate.SldPrt");
  });

  it("rejects absolute paths, drive prefixes and traversal (fail closed)", () => {
    expect(normalizeRegistryPath("/working/plate.sldprt")).toBeNull(); // posix absolute
    expect(normalizeRegistryPath("C:/working/plate.sldprt")).toBeNull(); // windows absolute
    expect(normalizeRegistryPath("C:\\working\\plate.sldprt")).toBeNull();
    expect(normalizeRegistryPath("../plate.sldprt")).toBeNull();
    expect(normalizeRegistryPath("working/../../plate.sldprt")).toBeNull();
    expect(normalizeRegistryPath("working/./plate.sldprt")).toBeNull();
    expect(normalizeRegistryPath("working//plate.sldprt")).toBeNull(); // empty segment
    expect(normalizeRegistryPath("working/plate.sldprt/")).toBeNull(); // trailing slash
    expect(normalizeRegistryPath("C:plate.sldprt")).toBeNull(); // drive-relative
  });

  it("rejects NUL characters and empty input", () => {
    expect(normalizeRegistryPath("working/plate\0.sldprt")).toBeNull();
    expect(normalizeRegistryPath("")).toBeNull();
    expect(normalizeRegistryPath("   ")).toBeNull(); // no .sldprt extension
  });

  it("rejects anything that is not an .sldprt document (non-SLDPRT fail closed)", () => {
    expect(normalizeRegistryPath("working/plate.sldasm")).toBeNull();
    expect(normalizeRegistryPath("working/plate.sldprt.bak")).toBeNull();
    expect(normalizeRegistryPath("working/plate.txt")).toBeNull();
    expect(normalizeRegistryPath("working/plate")).toBeNull();
    expect(normalizeRegistryPath("working/plate.sldprt.exe")).toBeNull();
    expect(normalizeRegistryPath("working/.sldprt")).toBeNull(); // no file name
  });
});

describe("readSolidWorksOwnershipRegistry (store)", () => {
  it("distinguishes ABSENT (no file) from INVALID (malformed file)", () => {
    const { surface } = readSurface(null);
    expect(readSolidWorksOwnershipRegistry(surface, BINDING)).toEqual({ status: "absent" });
    const malformed = readSurface("not json {");
    expect(readSolidWorksOwnershipRegistry(malformed.surface, BINDING)).toEqual({
      status: "invalid"
    });
  });

  it("returns valid with the normalized record for a well-formed file", () => {
    const { surface } = readSurface(JSON.stringify(validRegistry()));
    const result = readSolidWorksOwnershipRegistry(surface, BINDING);
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.record.documents).toEqual(["working/plate.sldprt"]);
    }
  });

  it("reports invalid for a present file that violates ANY rule (fail closed)", () => {
    const cases: Array<Record<string, unknown>> = [
      validRegistry({ documents: [] }),
      validRegistry({ documents: ["C:/escaped.sldprt"] }),
      validRegistry({ documents: ["../escape.sldprt"] }),
      validRegistry({ documents: ["working/plate.sldasm"] }),
      validRegistry({ documents: ["working/plate.sldprt", "output/plate-model.sldprt"] }),
      validRegistry({ runId: "other-run" }),
      validRegistry({ schemaVersion: 2 })
    ];
    for (const payload of cases) {
      const { surface } = readSurface(JSON.stringify(payload));
      expect(readSolidWorksOwnershipRegistry(surface, BINDING).status).toBe("invalid");
    }
  });

  it("reads the canonical attempt-scoped runtime path", () => {
    let requestedPath = "";
    const surface = {
      readOwnedFile: (input: { relativePath: string }) => {
        requestedPath = input.relativePath;
        return Buffer.from(JSON.stringify(validRegistry()), "utf8");
      }
    };
    readSolidWorksOwnershipRegistry(surface, BINDING);
    expect(requestedPath).toBe(SOLIDWORKS_OWNERSHIP_FILE_RELATIVE_PATH);
  });
});

describe("SOLIDWORKS_OWNED_STAGES (stage semantics of the surface)", () => {
  it("marks MODELING and later as owned stages, pre-CAD stages and null as not", () => {
    for (const stage of SOLIDWORKS_OWNED_STAGES) {
      expect(isSolidWorksOwnedStage(stage)).toBe(true);
    }
    expect(isSolidWorksOwnedStage("PREPARING")).toBe(false);
    expect(isSolidWorksOwnedStage("ANALYZING")).toBe(false);
    expect(isSolidWorksOwnedStage("PLANNING")).toBe(false);
    expect(isSolidWorksOwnedStage(null)).toBe(false);
  });
});
