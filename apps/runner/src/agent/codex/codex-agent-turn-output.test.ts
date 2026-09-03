import { describe, expect, it } from "vitest";

import {
  AGENT_TURN_OUTPUT_CONTRACT_VERSION,
  Phase4ContractError,
  validateAgentTurnOutput,
  type AgentTurnOutputClarification,
  type AgentTurnOutputCompleted,
  type Phase4ContractErrorCode
} from "@swpanel/contracts";

import {
  CODEX_AGENT_TURN_OUTPUT_WIRE_SCHEMA,
  validateCodexAgentTurnOutputWire
} from "./codex-agent-turn-output.js";

type SchemaNode = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every keyword the provider-facing schema must NOT contain anywhere. */
const FORBIDDEN_SCHEMA_KEYWORDS = ["oneOf", "anyOf", "allOf", "not", "$ref", "$schema", "$id", "definitions"];

/** Recursively walks every value of the schema document, failing on a forbidden keyword. */
function assertNoForbiddenSchemaKeywords(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((entry, index) => assertNoForbiddenSchemaKeywords(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (FORBIDDEN_SCHEMA_KEYWORDS.includes(key)) {
      throw new Error(`provider wire schema contains forbidden keyword ${key} at ${path}`);
    }
    assertNoForbiddenSchemaKeywords(value, `${path}.${key}`);
  }
}

/** Collects every OBJECT schema node (nodes declaring `properties`) recursively. */
function collectObjectSchemaNodes(node: unknown, out: SchemaNode[] = []): SchemaNode[] {
  if (!isRecord(node)) return out;
  if (node.properties !== undefined && isRecord(node.properties)) {
    out.push(node);
    for (const subschema of Object.values(node.properties)) {
      collectObjectSchemaNodes(subschema, out);
    }
  } else if (node.items !== undefined) {
    collectObjectSchemaNodes(node.items, out);
  }
  return out;
}

function sha256Hex(): string {
  return "a".repeat(64);
}

function artifactRef(seed: string): Record<string, unknown> {
  return {
    fileName: `${seed}.bin`,
    relativePath: `output/${seed}.bin`,
    sizeBytes: 1024,
    sha256: sha256Hex()
  };
}

/** A provider-wire Result Manifest v1 mirror: all fields required, processMp4 nullable sentinel. */
function wireManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 1,
    result: "completed",
    solidWorksVersion: "2025",
    units: "mm",
    projectionDecision: "第三角投影",
    featureCount: 12,
    bodyCount: 1,
    rebuildStatus: "PASSED",
    unresolvedAssumptions: [],
    productionVerified: false,
    artifacts: {
      sldprt: artifactRef("sldprt"),
      preview: artifactRef("preview"),
      dimensionLedger: artifactRef("ledger"),
      featurePlan: artifactRef("plan"),
      buildValidationLog: artifactRef("log"),
      builderSource: artifactRef("source"),
      processMp4: null
    },
    ...overrides
  };
}

/** A provider-wire completed document: required nullable sentinels included. */
function wireCompleted(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: AGENT_TURN_OUTPUT_CONTRACT_VERSION,
    result: "completed",
    completed: wireManifest(),
    questions: null,
    ...overrides
  };
}

/** A provider-wire clarification document: required nullable sentinels included. */
function wireClarification(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: AGENT_TURN_OUTPUT_CONTRACT_VERSION,
    result: "clarification_required",
    completed: null,
    questions: [
      {
        id: "q1",
        type: "dimension",
        question: "底板厚度是多少？",
        hint: "例如 12",
        unit: "mm",
        options: null
      },
      {
        id: "q2",
        type: "choice",
        question: "焊缝处理方式？",
        hint: null,
        unit: null,
        options: [
          { id: "none", label: "无需焊缝" },
          { id: "full", label: "全周满焊" }
        ]
      }
    ],
    ...overrides
  };
}

function expectContractCode(fn: () => unknown, code: Phase4ContractErrorCode): void {
  try {
    fn();
    throw new Error("expected the wire projector to throw");
  } catch (error) {
    if (error instanceof Error && error.message === "expected the wire projector to throw") {
      throw error;
    }
    expect(error).toBeInstanceOf(Phase4ContractError);
    expect((error as Phase4ContractError).code).toBe(code);
  }
}

describe("CODEX_AGENT_TURN_OUTPUT_WIRE_SCHEMA (provider-facing outputSchema)", () => {
  it("is a closed root object schema requiring EVERY top-level property", () => {
    expect(CODEX_AGENT_TURN_OUTPUT_WIRE_SCHEMA.title).toBe(
      "SWPanel Agent Turn Output (Codex provider wire schema)"
    );
    expect(CODEX_AGENT_TURN_OUTPUT_WIRE_SCHEMA.type).toBe("object");
    expect(CODEX_AGENT_TURN_OUTPUT_WIRE_SCHEMA.additionalProperties).toBe(false);
    expect([...CODEX_AGENT_TURN_OUTPUT_WIRE_SCHEMA.required]).toEqual([
      "contractVersion",
      "result",
      "completed",
      "questions"
    ]);
    const properties = CODEX_AGENT_TURN_OUTPUT_WIRE_SCHEMA.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(
      [...CODEX_AGENT_TURN_OUTPUT_WIRE_SCHEMA.required].sort()
    );
  });

  it("contains NONE of oneOf/anyOf/allOf/not and no $ref/$schema/$id/definitions anywhere (recursively)", () => {
    expect(() => assertNoForbiddenSchemaKeywords(CODEX_AGENT_TURN_OUTPUT_WIRE_SCHEMA, "$")).not.toThrow();
    // The recursive walker proves no forbidden KEY exists. The provider-facing
    // serialized document also avoids mentioning the schema keywords in prose,
    // so even an over-conservative provider scanner cannot false-positive.
    const serialized = JSON.stringify(CODEX_AGENT_TURN_OUTPUT_WIRE_SCHEMA);
    for (const keyword of FORBIDDEN_SCHEMA_KEYWORDS) {
      expect(serialized).not.toContain(keyword);
    }
  });

  it("keeps every OBJECT schema node closed with required EXACTLY equal to its property keys", () => {
    const nodes = collectObjectSchemaNodes(CODEX_AGENT_TURN_OUTPUT_WIRE_SCHEMA);
    // root + completed manifest + artifacts + 6 refs + processMp4 + questions items + option items
    expect(nodes.length).toBeGreaterThanOrEqual(10);
    for (const node of nodes) {
      const properties = node.properties as Record<string, unknown>;
      expect(node.additionalProperties).toBe(false);
      expect(properties).toBeDefined();
      expect([...(node.required as readonly string[])].sort()).toEqual(
        Object.keys(properties).sort()
      );
    }
  });

  it("encodes the nullable semantics with REQUIRED type-union sentinels", () => {
    const top = CODEX_AGENT_TURN_OUTPUT_WIRE_SCHEMA.properties as unknown as Record<
      string,
      { type: unknown; required?: readonly string[]; properties?: Record<string, unknown> }
    >;
    expect(top.completed?.type).toEqual(["object", "null"]);
    expect(top.questions?.type).toEqual(["array", "null"]);
    const manifest = top.completed?.properties as Record<string, unknown>;
    expect((manifest.productionVerified as { type: unknown }).type).toBe("boolean");
    expect(manifest.artifacts).toBeDefined();
    const artifacts = (
      top.completed?.properties as unknown as {
        artifacts: { type: unknown; required: readonly string[]; properties: Record<string, { type: unknown }> };
      }
    ).artifacts;
    expect(artifacts.required).toContain("processMp4");
    expect(artifacts.properties.processMp4?.type).toEqual(["object", "null"]);
    const question = (
      top.questions as unknown as {
        items: { required: readonly string[]; properties: Record<string, { type: unknown }> };
      }
    ).items;
    expect(question.required).toEqual(["id", "type", "question", "hint", "unit", "options"]);
    expect(question.properties.hint?.type).toEqual(["string", "null"]);
    expect(question.properties.unit?.type).toEqual(["string", "null"]);
    expect(question.properties.options?.type).toEqual(["array", "null"]);
  });

  it("mirrors the Result Manifest v1 wire shape (required productionVerified boolean, strict artifact refs)", () => {
    const top = CODEX_AGENT_TURN_OUTPUT_WIRE_SCHEMA.properties as unknown as Record<string, unknown>;
    const manifest = top.completed as {
      required: readonly string[];
      properties: Record<string, unknown>;
    };
    expect([...manifest.required].sort()).toEqual(
      [
        "contractVersion",
        "result",
        "solidWorksVersion",
        "units",
        "projectionDecision",
        "featureCount",
        "bodyCount",
        "rebuildStatus",
        "unresolvedAssumptions",
        "productionVerified",
        "artifacts"
      ].sort()
    );
    const refs = (
      (manifest.properties.artifacts as { properties: Record<string, unknown> }).properties
    ) as Record<string, { type: unknown; required: readonly string[] }>;
    expect(Object.keys(refs)).toEqual([
      "sldprt",
      "preview",
      "dimensionLedger",
      "featurePlan",
      "buildValidationLog",
      "builderSource",
      "processMp4"
    ]);
    for (const [key, ref] of Object.entries(refs)) {
      if (key === "processMp4") {
        expect(ref.type).toEqual(["object", "null"]);
      } else {
        expect(ref.type).toBe("object");
      }
      expect(ref.required).toEqual(["fileName", "relativePath", "sizeBytes", "sha256"]);
    }
  });
});

describe("validateCodexAgentTurnOutputWire (strict wire projection)", () => {
  it("projects a completed wire document onto the canonical completed AgentTurnOutput shape", () => {
    // The RAW wire document is NOT canonical (required sentinels) — the
    // canonical validator rejects it, the projector must not.
    expectContractCode(() => validateAgentTurnOutput(wireCompleted()), "INVALID_CONTRACT");
    const projected = validateCodexAgentTurnOutputWire(wireCompleted());
    expect(projected.result).toBe("completed");
    const output = projected as AgentTurnOutputCompleted;
    expect(output.contractVersion).toBe(AGENT_TURN_OUTPUT_CONTRACT_VERSION);
    expect(output.completed.productionVerified).toBe(false);
    // processMp4: null sentinel normalized by omission.
    expect(output.completed.artifacts.processMp4).toBeUndefined();
    expect(output.completed.artifacts.sldprt.fileName).toBe("sldprt.bin");
    // The projected document passes the canonical validator unchanged.
    expect(validateAgentTurnOutput(projected)).toEqual(projected);
  });

  it("keeps a REAL processMp4 artifact reference and a true productionVerified claim", () => {
    const manifest = wireManifest({
      productionVerified: true,
      artifacts: {
        ...(wireManifest().artifacts as Record<string, unknown>),
        processMp4: artifactRef("recording")
      }
    });
    const projected = validateCodexAgentTurnOutputWire(
      wireCompleted({ completed: manifest })
    ) as AgentTurnOutputCompleted;
    expect(projected.completed.productionVerified).toBe(true);
    expect(projected.completed.artifacts.processMp4?.fileName).toBe("recording.bin");
  });

  it("projects a clarification wire document onto the canonical shape with null optionals normalized", () => {
    // The RAW wire document is NOT canonical (required sentinels).
    expectContractCode(() => validateAgentTurnOutput(wireClarification()), "INVALID_CONTRACT");
    const projected = validateCodexAgentTurnOutputWire(wireClarification());
    expect(projected.result).toBe("clarification_required");
    const output = projected as AgentTurnOutputClarification;
    expect(output.questions).toEqual([
      // options: null normalized by omission; hint/unit kept.
      { id: "q1", type: "dimension", question: "底板厚度是多少？", hint: "例如 12", unit: "mm" },
      // hint/unit null normalized by omission; options kept.
      {
        id: "q2",
        type: "choice",
        question: "焊缝处理方式？",
        options: [
          { id: "none", label: "无需焊缝" },
          { id: "full", label: "全周满焊" }
        ]
      }
    ]);
    expect(validateAgentTurnOutput(projected)).toEqual(projected);
  });

  it("normalizes every null optional of a question by omission", () => {
    const projected = validateCodexAgentTurnOutputWire(
      wireClarification({
        questions: [{ id: "q9", type: "text", question: "材料？", hint: null, unit: null, options: null }]
      })
    ) as AgentTurnOutputClarification;
    expect(projected.questions).toEqual([{ id: "q9", type: "text", question: "材料？" }]);
  });

  it("normalizes null sentinels of a document with ALL optionals present", () => {
    const projected = validateCodexAgentTurnOutputWire(
      wireClarification({
        questions: [
          {
            id: "q1",
            type: "dimension",
            question: "深度？",
            hint: "如 85",
            unit: "mm",
            options: [{ id: "o1", label: "30" }, { id: "o2", label: "60" }]
          }
        ]
      })
    ) as AgentTurnOutputClarification;
    expect(projected.questions).toEqual([
      {
        id: "q1",
        type: "dimension",
        question: "深度？",
        hint: "如 85",
        unit: "mm",
        options: [
          { id: "o1", label: "30" },
          { id: "o2", label: "60" }
        ]
      }
    ]);
  });

  it("rejects a CONTRADICTORY payload carrying both terminal states", () => {
    expectContractCode(
      () =>
        validateCodexAgentTurnOutputWire(
          wireCompleted({ questions: [{ id: "q1", type: "text", question: "材料？" }] })
        ),
      "INVALID_CONTRACT"
    );
    expectContractCode(
      () => validateCodexAgentTurnOutputWire(wireClarification({ completed: wireManifest() })),
      "INVALID_CONTRACT"
    );
  });

  it("rejects a NEITHER payload (both terminal sentinels null)", () => {
    expectContractCode(
      () =>
        validateCodexAgentTurnOutputWire({
          contractVersion: 1,
          result: "completed",
          completed: null,
          questions: null
        }),
      "INVALID_CONTRACT"
    );
    expectContractCode(
      () =>
        validateCodexAgentTurnOutputWire({
          contractVersion: 1,
          result: "clarification_required",
          completed: null,
          questions: null
        }),
      "INVALID_CONTRACT"
    );
  });

  it("rejects MISSING provider-required fields at every object level", () => {
    // Top level.
    const withoutQuestions = wireCompleted();
    delete withoutQuestions.questions;
    expectContractCode(() => validateCodexAgentTurnOutputWire(withoutQuestions), "INVALID_CONTRACT");
    const withoutCompleted = wireClarification();
    delete withoutCompleted.completed;
    expectContractCode(() => validateCodexAgentTurnOutputWire(withoutCompleted), "INVALID_CONTRACT");
    const withoutContractVersion = wireCompleted();
    delete withoutContractVersion.contractVersion;
    expectContractCode(() => validateCodexAgentTurnOutputWire(withoutContractVersion), "INVALID_CONTRACT");
    const withoutResult = wireCompleted();
    delete withoutResult.result;
    expectContractCode(() => validateCodexAgentTurnOutputWire(withoutResult), "INVALID_CONTRACT");
    // Manifest level: required productionVerified and artifacts.processMp4.
    const manifest = wireManifest();
    delete manifest.productionVerified;
    expectContractCode(
      () => validateCodexAgentTurnOutputWire(wireCompleted({ completed: manifest })),
      "INVALID_CONTRACT"
    );
    const artifacts = { ...(wireManifest().artifacts as Record<string, unknown>) };
    delete artifacts.processMp4;
    expectContractCode(
      () => validateCodexAgentTurnOutputWire(wireCompleted({ completed: wireManifest({ artifacts }) })),
      "INVALID_CONTRACT"
    );
    // Artifact ref level.
    const brokenRef = { ...artifactRef("sldprt") };
    delete brokenRef.sha256;
    expectContractCode(
      () =>
        validateCodexAgentTurnOutputWire(
          wireCompleted({
            completed: wireManifest({ artifacts: { ...artifacts, sldprt: brokenRef } })
          })
        ),
      "INVALID_CONTRACT"
    );
    // Question level: hint/unit/options are provider-required.
    const question = { id: "q1", type: "text", question: "材料？" } as Record<string, unknown>;
    delete question.hint;
    expectContractCode(
      () => validateCodexAgentTurnOutputWire(wireClarification({ questions: [question] })),
      "INVALID_CONTRACT"
    );
  });

  it("rejects UNKNOWN fields at every object level", () => {
    expectContractCode(
      () => validateCodexAgentTurnOutputWire(wireCompleted({ extra: true })),
      "UNKNOWN_FIELD"
    );
    expectContractCode(
      () =>
        validateCodexAgentTurnOutputWire(
          wireCompleted({ completed: wireManifest({ owner: "runner" }) })
        ),
      "UNKNOWN_FIELD"
    );
    expectContractCode(
      () =>
        validateCodexAgentTurnOutputWire(
          wireCompleted({
            completed: wireManifest({
              artifacts: { ...(wireManifest().artifacts as Record<string, unknown>), magic: 1 }
            })
          })
        ),
      "UNKNOWN_FIELD"
    );
    const brokenRef = { ...artifactRef("sldprt"), absolutePath: "C:\\x" };
    expectContractCode(
      () =>
        validateCodexAgentTurnOutputWire(
          wireCompleted({
            completed: wireManifest({ artifacts: { ...(wireManifest().artifacts as Record<string, unknown>), sldprt: brokenRef } })
          })
        ),
      "UNKNOWN_FIELD"
    );
    expectContractCode(
      () =>
        validateCodexAgentTurnOutputWire(
          wireClarification({
            questions: [{ id: "q1", type: "text", question: "材料？", hint: null, unit: null, options: null, source: "agent" }]
          })
        ),
      "UNKNOWN_FIELD"
    );
    expectContractCode(
      () =>
        validateCodexAgentTurnOutputWire(
          wireClarification({
            questions: [
              {
                id: "q1",
                type: "choice",
                question: "倒角？",
                hint: null,
                unit: null,
                options: [{ id: "o1", label: "45 度", weight: 2 }]
              }
            ]
          })
        ),
      "UNKNOWN_FIELD"
    );
  });

  it("rejects wrong nullable/non-null types", () => {
    expectContractCode(
      () => validateCodexAgentTurnOutputWire(wireCompleted({ completed: null })),
      "INVALID_CONTRACT"
    );
    expectContractCode(
      () => validateCodexAgentTurnOutputWire(wireCompleted({ completed: "manifest" })),
      "INVALID_CONTRACT"
    );
    expectContractCode(
      () => validateCodexAgentTurnOutputWire(wireCompleted({ questions: [] })),
      "INVALID_CONTRACT"
    );
    expectContractCode(
      () => validateCodexAgentTurnOutputWire(wireClarification({ completed: {} })),
      "INVALID_CONTRACT"
    );
    expectContractCode(
      () => validateCodexAgentTurnOutputWire(wireClarification({ questions: {} })),
      "INVALID_CONTRACT"
    );
    expectContractCode(
      () =>
        validateCodexAgentTurnOutputWire(
          wireClarification({
            questions: [{ id: "q1", type: "text", question: "材料？", hint: 5, unit: null, options: null }]
          })
        ),
      "INVALID_CONTRACT"
    );
    expectContractCode(
      () =>
        validateCodexAgentTurnOutputWire(
          wireClarification({
            questions: [{ id: "q1", type: "text", question: "材料？", hint: null, unit: {}, options: null }]
          })
        ),
      "INVALID_CONTRACT"
    );
    expectContractCode(
      () =>
        validateCodexAgentTurnOutputWire(
          wireClarification({
            questions: [{ id: "q1", type: "text", question: "材料？", hint: null, unit: null, options: "none" }]
          })
        ),
      "INVALID_CONTRACT"
    );
  });

  it("rejects a malformed manifest (semantic violations fail via the canonical validator)", () => {
    // Empty solidWorksVersion fails the canonical Result Manifest v1 pass.
    expectContractCode(
      () =>
        validateCodexAgentTurnOutputWire(
          wireCompleted({ completed: wireManifest({ solidWorksVersion: "" }) })
        ),
      "INVALID_CONTRACT"
    );
    // productionVerified must be a boolean on the wire (never coerced).
    expectContractCode(
      () =>
        validateCodexAgentTurnOutputWire(
          wireCompleted({ completed: wireManifest({ productionVerified: "yes" }) })
        ),
      "INVALID_CONTRACT"
    );
    // Non-null processMp4 must be an artifact reference object.
    expectContractCode(
      () =>
        validateCodexAgentTurnOutputWire(
          wireCompleted({
            completed: wireManifest({
              artifacts: { ...(wireManifest().artifacts as Record<string, unknown>), processMp4: "recording.mp4" }
            })
          })
        ),
      "INVALID_CONTRACT"
    );
    // Missing artifact reference fails the strict wire checks.
    expectContractCode(
      () =>
        validateCodexAgentTurnOutputWire(
          wireCompleted({
            completed: wireManifest({
              artifacts: { ...(wireManifest().artifacts as Record<string, unknown>), preview: {} }
            })
          })
        ),
      "INVALID_CONTRACT"
    );
    // A non-hex sha256 fails the canonical validator.
    expectContractCode(
      () =>
        validateCodexAgentTurnOutputWire(
          wireCompleted({
            completed: wireManifest({
              artifacts: { ...(wireManifest().artifacts as Record<string, unknown>), preview: { ...artifactRef("preview"), sha256: "not-hex" } }
            })
          })
        ),
      "INVALID_CONTRACT"
    );
  });

  it("rejects an EMPTY question set", () => {
    expectContractCode(
      () => validateCodexAgentTurnOutputWire(wireClarification({ questions: [] })),
      "INVALID_CONTRACT"
    );
  });

  it("rejects an ILLEGAL choice question without options (semantics stay canonical)", () => {
    expectContractCode(
      () =>
        validateCodexAgentTurnOutputWire(
          wireClarification({
            questions: [{ id: "q1", type: "choice", question: "倒角？", hint: null, unit: null, options: null }]
          })
        ),
      "INVALID_CONTRACT"
    );
  });

  it("rejects INVALID options (empty array, malformed option)", () => {
    expectContractCode(
      () =>
        validateCodexAgentTurnOutputWire(
          wireClarification({
            questions: [
              { id: "q1", type: "choice", question: "倒角？", hint: null, unit: null, options: [] }
            ]
          })
        ),
      "INVALID_CONTRACT"
    );
    expectContractCode(
      () =>
        validateCodexAgentTurnOutputWire(
          wireClarification({
            questions: [
              {
                id: "q1",
                type: "choice",
                question: "倒角？",
                hint: null,
                unit: null,
                options: [{ id: "o1" }]
              }
            ]
          })
        ),
      "INVALID_CONTRACT"
    );
  });

  it("rejects an illegal result value and a wrong contract version", () => {
    expectContractCode(
      () => validateCodexAgentTurnOutputWire(wireCompleted({ result: "partially-done" })),
      "INVALID_CONTRACT"
    );
    expectContractCode(
      () => validateCodexAgentTurnOutputWire(wireCompleted({ contractVersion: 2 })),
      "VERSION_MISMATCH"
    );
  });

  it("rejects non-object documents", () => {
    expectContractCode(() => validateCodexAgentTurnOutputWire(null), "INVALID_CONTRACT");
    expectContractCode(() => validateCodexAgentTurnOutputWire("json"), "INVALID_CONTRACT");
    expectContractCode(() => validateCodexAgentTurnOutputWire([]), "INVALID_CONTRACT");
  });
});
