import { describe, expect, it } from "vitest";

import {
  CLARIFICATION_QUESTION_TYPES,
  CLARIFICATION_STATUSES,
  RUN_EVENT_TYPES,
  RUN_FAILURE_CODES,
  RUN_STAGES
} from "@swpanel/domain";
import {
  AGENT_TURN_OUTPUT_CONTRACT_VERSION,
  AGENT_TURN_OUTPUT_JSON_SCHEMA,
  CLARIFICATION_CONTRACT_VERSION,
  CLARIFICATION_JSON_SCHEMA,
  PRODUCT_EVENTS_CONTRACT_VERSION,
  PRODUCT_EVENTS_JSON_SCHEMA,
  RUNTIME_METADATA_SCHEMA_ID,
  RESULT_MANIFEST_CONTRACT_VERSION,
  validateAgentTurnOutput,
  validateClarificationRequest,
  validateProductEvent
} from "../index.js";

/**
 * Dependency-free conformance harness: evaluates the draft-07 subset used by
 * the Product Events and Clarification schema documents (and the embedded
 * Runtime Metadata definition) so the tests below can prove the schemas accept
 * exactly the fixtures the strict validators accept, without adding an Ajv
 * runtime dependency. The harness is test-only and fails loudly on any keyword
 * outside the subset instead of silently ignoring it.
 */
type SchemaNode = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesType(type: unknown, value: unknown): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    default:
      throw new Error(`conformance harness: unsupported type ${JSON.stringify(type)}`);
  }
}

function resolveRef(root: SchemaNode, ref: unknown): SchemaNode {
  if (typeof ref !== "string" || !ref.startsWith("#/definitions/")) {
    throw new Error(`conformance harness: unsupported $ref ${JSON.stringify(ref)}`);
  }
  const definitions = root.definitions;
  if (!isRecord(definitions)) {
    throw new Error("conformance harness: schema has no definitions object");
  }
  const target = definitions[ref.slice("#/definitions/".length)];
  if (!isRecord(target)) {
    throw new Error(`conformance harness: cannot resolve ${ref}`);
  }
  return target;
}

/**
 * Returns `undefined` when `value` satisfies `schema`, otherwise a message
 * describing the first violation. `root` is the document the `$ref` fragments
 * resolve against.
 */
function evaluateSchema(schema: SchemaNode, value: unknown, root: SchemaNode): string | undefined {
  if (schema.$ref !== undefined) {
    return evaluateSchema(resolveRef(root, schema.$ref), value, root);
  }
  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    return `expected type ${JSON.stringify(schema.type)}`;
  }
  if (schema.const !== undefined && schema.const !== value) {
    return `expected const ${JSON.stringify(schema.const)}`;
  }
  if (schema.enum !== undefined) {
    const options = schema.enum as readonly unknown[];
    if (!options.includes(value)) {
      return `value not in enum ${JSON.stringify(schema.enum)}`;
    }
  }
  if (schema.format !== undefined) {
    if (schema.format !== "date-time") {
      throw new Error(`conformance harness: unsupported format ${JSON.stringify(schema.format)}`);
    }
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      return "not a valid date-time";
    }
  }
  if (schema.minimum !== undefined && (typeof value !== "number" || value < (schema.minimum as number))) {
    return `less than minimum ${JSON.stringify(schema.minimum)}`;
  }
  if (schema.maximum !== undefined && (typeof value !== "number" || value > (schema.maximum as number))) {
    return `greater than maximum ${JSON.stringify(schema.maximum)}`;
  }
  if (
    schema.minLength !== undefined &&
    (typeof value !== "string" || value.length < (schema.minLength as number))
  ) {
    return `shorter than minLength ${JSON.stringify(schema.minLength)}`;
  }
  if (isRecord(value)) {
    const properties = schema.properties as Readonly<Record<string, SchemaNode>> | undefined;
    if (schema.required !== undefined) {
      for (const key of schema.required as readonly string[]) {
        if (!(key in value)) {
          return `missing required field ${key}`;
        }
      }
    }
    if (properties !== undefined) {
      for (const [key, subschema] of Object.entries(properties)) {
        if (key in value) {
          const result = evaluateSchema(subschema, value[key], root);
          if (result !== undefined) {
            return `${key}: ${result}`;
          }
        }
      }
    }
    if (schema.additionalProperties !== undefined) {
      const declared = new Set(Object.keys(properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!declared.has(key)) {
          if (schema.additionalProperties === false) {
            return `contains unknown field ${key}`;
          }
          if (isRecord(schema.additionalProperties)) {
            const result = evaluateSchema(schema.additionalProperties, value[key], root);
            if (result !== undefined) {
              return `${key}: ${result}`;
            }
          }
        }
      }
    }
  } else if (
    schema.properties !== undefined ||
    schema.required !== undefined ||
    schema.additionalProperties !== undefined
  ) {
    return "expected an object";
  }
  if (Array.isArray(value)) {
    if (schema.items !== undefined) {
      const items = schema.items as SchemaNode;
      for (let index = 0; index < value.length; index++) {
        const result = evaluateSchema(items, value[index], root);
        if (result !== undefined) {
          return `item ${index}: ${result}`;
        }
      }
    }
    if (schema.minItems !== undefined && value.length < (schema.minItems as number)) {
      return `array shorter than minItems ${JSON.stringify(schema.minItems)}`;
    }
  }
  if (schema.oneOf !== undefined) {
    const branches = schema.oneOf as readonly SchemaNode[];
    let matches = 0;
    for (const branch of branches) {
      if (evaluateSchema(branch, value, root) === undefined) {
        matches += 1;
      }
    }
    if (matches !== 1) {
      return `expected exactly one oneOf branch to match, got ${matches}`;
    }
  }
  return undefined;
}

interface Fixture {
  name: string;
  value: unknown;
  valid: boolean;
}

/** Proves schema and strict validator agree on every fixture. */
function assertFixtureConformance(
  schema: SchemaNode,
  validate: (value: unknown) => unknown,
  fixtures: readonly Fixture[]
): void {
  for (const fixture of fixtures) {
    if (fixture.valid) {
      expect(() => validate(fixture.value), `${fixture.name}: validator`).not.toThrow();
      expect(evaluateSchema(schema, fixture.value, schema), `${fixture.name}: schema`).toBeUndefined();
    } else {
      expect(() => validate(fixture.value), `${fixture.name}: validator`).toThrow();
      expect(evaluateSchema(schema, fixture.value, schema), `${fixture.name}: schema`).toBeDefined();
    }
  }
}

const EVENT_ENVELOPE_FIELDS = [
  "contractVersion",
  "runId",
  "attemptId",
  "sequence",
  "occurredAt",
  "type"
];

function productEvent(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    contractVersion: PRODUCT_EVENTS_CONTRACT_VERSION,
    runId: "run-1",
    attemptId: "attempt-1",
    sequence: 3,
    occurredAt: "2026-08-13T10:00:00.000Z",
    ...payload
  };
}

function runtimeMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 1,
    runtime: {
      adapterId: "codex-app-server",
      adapterVersion: "1.0.0",
      protocol: "codex-app-server",
      protocolVersion: "1",
      modelSupportsImageInput: true
    },
    updatedAt: "2026-08-13T10:00:00.000Z",
    ...overrides
  };
}

function runtimeMetadataWithSessionAndResume(): Record<string, unknown> {
  return {
    ...runtimeMetadata(),
    session: { threadId: "thread-1", resumedFromThreadId: "thread-0" },
    resume: { attemptId: "attempt-1", lastAppliedSequence: 7 }
  };
}

const PRODUCT_EVENT_FIXTURES: readonly Fixture[] = [
  {
    name: "StageChanged with stage and activity",
    value: productEvent({ type: "StageChanged", stage: "MODELING", activity: "创建主要旋转特征" }),
    valid: true
  },
  {
    name: "StageChanged with stage only",
    value: productEvent({ type: "StageChanged", stage: "ANALYZING" }),
    valid: true
  },
  {
    name: "ActivityUpdated",
    value: productEvent({ type: "ActivityUpdated", activity: "解析标题栏" }),
    valid: true
  },
  {
    name: "ProgressUpdated at zero percent",
    value: productEvent({ type: "ProgressUpdated", progressPercent: 0 }),
    valid: true
  },
  {
    name: "ProgressUpdated at one hundred percent",
    value: productEvent({ type: "ProgressUpdated", progressPercent: 100 }),
    valid: true
  },
  {
    name: "ProgressUpdated fractional percent",
    value: productEvent({ type: "ProgressUpdated", progressPercent: 42.5, activity: "规划特征" }),
    valid: true
  },
  {
    name: "ClarificationRequired",
    value: productEvent({ type: "ClarificationRequired", clarificationRequestId: "clar-1" }),
    valid: true
  },
  {
    name: "AgentTurnCompleted",
    value: productEvent({ type: "AgentTurnCompleted", turnId: "turn-1" }),
    valid: true
  },
  {
    name: "RuntimeMetadataUpdated with full metadata",
    value: productEvent({ type: "RuntimeMetadataUpdated", metadata: runtimeMetadataWithSessionAndResume() }),
    valid: true
  },
  {
    name: "RuntimeMetadataUpdated with minimal metadata",
    value: productEvent({ type: "RuntimeMetadataUpdated", metadata: runtimeMetadata() }),
    valid: true
  },
  {
    name: "ResultManifestReceived",
    value: productEvent({ type: "ResultManifestReceived", manifestRef: "manifest.json" }),
    valid: true
  },
  {
    name: "ArtifactValidationFailed",
    value: productEvent({ type: "ArtifactValidationFailed", failureCode: "ARTIFACT_MANIFEST_INVALID" }),
    valid: true
  },
  {
    name: "Completed with modelId",
    value: productEvent({ type: "Completed", modelId: "model-1" }),
    valid: true
  },
  {
    name: "Completed without modelId",
    value: productEvent({ type: "Completed" }),
    valid: true
  },
  {
    name: "Failed with failureMessage",
    value: productEvent({ type: "Failed", failureCode: "SOLIDWORKS_UNAVAILABLE", failureMessage: "not installed" }),
    valid: true
  },
  {
    name: "Failed with failureCode only",
    value: productEvent({ type: "Failed", failureCode: "AGENT_TIMEOUT" }),
    valid: true
  },
  {
    name: "CancellationRequested with reason",
    value: productEvent({ type: "CancellationRequested", reason: "user request" }),
    valid: true
  },
  {
    name: "CancellationRequested without reason",
    value: productEvent({ type: "CancellationRequested" }),
    valid: true
  },
  {
    name: "CancellationConfirmed",
    value: productEvent({ type: "CancellationConfirmed" }),
    valid: true
  },
  {
    name: "event with runtimeThreadId",
    value: productEvent({ type: "StageChanged", stage: "PACKAGING", runtimeThreadId: "thread-9" }),
    valid: true
  },
  {
    name: "unknown event type",
    value: productEvent({ type: "MagicHappened" }),
    valid: false
  },
  {
    name: "StageChanged with unknown stage",
    value: productEvent({ type: "StageChanged", stage: "THINKING" }),
    valid: false
  },
  {
    name: "StageChanged without stage",
    value: productEvent({ type: "StageChanged" }),
    valid: false
  },
  {
    name: "ProgressUpdated above one hundred",
    value: productEvent({ type: "ProgressUpdated", progressPercent: 101 }),
    valid: false
  },
  {
    name: "ProgressUpdated below zero",
    value: productEvent({ type: "ProgressUpdated", progressPercent: -1 }),
    valid: false
  },
  {
    name: "ProgressUpdated with non-number progress",
    value: productEvent({ type: "ProgressUpdated", progressPercent: "42" }),
    valid: false
  },
  {
    name: "ActivityUpdated without activity",
    value: productEvent({ type: "ActivityUpdated" }),
    valid: false
  },
  {
    name: "RuntimeMetadataUpdated with wrong metadata contract version",
    value: productEvent({ type: "RuntimeMetadataUpdated", metadata: runtimeMetadata({ contractVersion: 2 }) }),
    valid: false
  },
  {
    name: "RuntimeMetadataUpdated with unknown metadata field",
    value: productEvent({ type: "RuntimeMetadataUpdated", metadata: runtimeMetadata({ latencyMs: 5 }) }),
    valid: false
  },
  {
    name: "RuntimeMetadataUpdated with non-object metadata",
    value: productEvent({ type: "RuntimeMetadataUpdated", metadata: "meta" }),
    valid: false
  },
  {
    name: "RuntimeMetadataUpdated without metadata",
    value: productEvent({ type: "RuntimeMetadataUpdated" }),
    valid: false
  },
  {
    name: "ArtifactValidationFailed with unknown failure code",
    value: productEvent({ type: "ArtifactValidationFailed", failureCode: "REBOOTED" }),
    valid: false
  },
  {
    name: "Failed with unknown failure code",
    value: productEvent({ type: "Failed", failureCode: "CLARIFICATION_REQUIRED_ANYWAY" }),
    valid: false
  },
  {
    name: "unknown envelope field",
    value: productEvent({ type: "Completed", extra: 1 }),
    valid: false
  },
  {
    name: "missing runId",
    value: productEvent({ type: "Completed", runId: undefined }),
    valid: false
  },
  {
    name: "invalid occurredAt",
    value: productEvent({ type: "Completed", occurredAt: "not-a-date" }),
    valid: false
  },
  {
    name: "negative sequence",
    value: productEvent({ type: "Completed", sequence: -1 }),
    valid: false
  },
  {
    name: "fractional sequence",
    value: productEvent({ type: "Completed", sequence: 1.5 }),
    valid: false
  },
  {
    name: "wrong contract version",
    value: productEvent({ type: "Completed", contractVersion: 2 }),
    valid: false
  },
  {
    name: "ClarificationRequired with extra payload field",
    value: productEvent({ type: "ClarificationRequired", clarificationRequestId: "clar-1", priority: "high" }),
    valid: false
  },
  {
    name: "StageChanged with extra payload field",
    value: productEvent({ type: "StageChanged", stage: "MODELING", step: 2 }),
    valid: false
  }
];

function clarificationRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: CLARIFICATION_CONTRACT_VERSION,
    id: "clar-1",
    runId: "run-1",
    revisionId: "rev-1",
    status: "OPEN",
    questions: [
      { id: "q1", type: "dimension", question: "中心孔深度是多少？", unit: "mm" },
      {
        id: "q2",
        type: "choice",
        question: "倒角类型？",
        options: [
          { id: "opt-c1", label: "45 度倒角" },
          { id: "opt-c2", label: "圆角" }
        ]
      }
    ],
    answers: [],
    createdAt: "2026-08-13T10:00:00.000Z",
    ...overrides
  };
}

function answer(
  value: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "a1",
    questionId: "q1",
    value,
    answeredAt: "2026-08-13T11:00:00.000Z",
    answeredBy: "user-1",
    ...overrides
  };
}

const CLARIFICATION_FIXTURES: readonly Fixture[] = [
  {
    name: "request with dimension and choice questions and a dimension answer",
    value: clarificationRequest({
      answers: [answer({ kind: "dimension", value: 85, unit: "mm" })]
    }),
    valid: true
  },
  {
    name: "answered request with text and choice answers",
    value: clarificationRequest({
      status: "ANSWERED",
      answeredAt: "2026-08-13T11:00:00.000Z",
      answers: [
        answer({ kind: "text", value: "42CrMo" }, { questionId: "q2" }),
        answer({ kind: "choice", optionId: "opt-c1" }, { questionId: "q2" })
      ]
    }),
    valid: true
  },
  {
    name: "dimension question with hint and unit",
    value: clarificationRequest({
      questions: [{ id: "q1", type: "dimension", question: "深度？", hint: "如 85", unit: "mm" }]
    }),
    valid: true
  },
  {
    name: "options on a non-choice question",
    value: clarificationRequest({
      questions: [
        {
          id: "q1",
          type: "text",
          question: "材料？",
          options: [{ id: "opt-1", label: "42CrMo" }]
        }
      ]
    }),
    valid: true
  },
  {
    name: "request without answers",
    value: clarificationRequest({ questions: [{ id: "q1", type: "text", question: "材料？" }] }),
    valid: true
  },
  {
    name: "dimension answer with value zero",
    value: clarificationRequest({
      answers: [answer({ kind: "dimension", value: 0, unit: "mm" })]
    }),
    valid: true
  },
  {
    name: "choice question without options",
    value: clarificationRequest({
      questions: [{ id: "q1", type: "choice", question: "倒角？" }]
    }),
    valid: false
  },
  {
    name: "choice question with empty options",
    value: clarificationRequest({
      questions: [{ id: "q1", type: "choice", question: "倒角？", options: [] }]
    }),
    valid: false
  },
  {
    name: "unknown question type",
    value: clarificationRequest({
      questions: [{ id: "q1", type: "date", question: "when?" }]
    }),
    valid: false
  },
  {
    name: "question with unknown field",
    value: clarificationRequest({
      questions: [{ id: "q1", type: "text", question: "材料？", source: "agent" }]
    }),
    valid: false
  },
  {
    name: "answer value with unknown kind",
    value: clarificationRequest({
      answers: [answer({ kind: "range", value: 85, unit: "mm" })]
    }),
    valid: false
  },
  {
    name: "dimension answer without unit",
    value: clarificationRequest({
      answers: [answer({ kind: "dimension", value: 85 })]
    }),
    valid: false
  },
  {
    name: "dimension answer with string value",
    value: clarificationRequest({
      answers: [answer({ kind: "dimension", value: "85", unit: "mm" })]
    }),
    valid: false
  },
  {
    name: "text answer with empty value",
    value: clarificationRequest({
      answers: [answer({ kind: "text", value: "" })]
    }),
    valid: false
  },
  {
    name: "choice answer without optionId",
    value: clarificationRequest({
      answers: [answer({ kind: "choice" })]
    }),
    valid: false
  },
  {
    name: "answer value with unknown field",
    value: clarificationRequest({
      answers: [answer({ kind: "text", value: "42CrMo", confidence: 0.9 })]
    }),
    valid: false
  },
  {
    name: "request with unknown field",
    value: clarificationRequest({ priority: "high" }),
    valid: false
  },
  {
    name: "request with unknown status",
    value: clarificationRequest({ status: "CLOSED" }),
    valid: false
  },
  {
    name: "request with empty questions",
    value: clarificationRequest({ questions: [] }),
    valid: false
  },
  {
    name: "request with invalid createdAt",
    value: clarificationRequest({ createdAt: "yesterday" }),
    valid: false
  },
  {
    name: "answer missing answeredBy",
    value: clarificationRequest({
      answers: [answer({ kind: "text", value: "42CrMo" }, { answeredBy: undefined })]
    }),
    valid: false
  }
];

interface EventBranchView {
  title: string;
  type: string;
  additionalProperties: boolean;
  required: string[];
  properties: Record<string, Record<string, unknown>>;
}

function productEventSchemaView(): {
  oneOf: EventBranchView[];
  definitions: Record<string, Record<string, unknown>>;
} {
  return PRODUCT_EVENTS_JSON_SCHEMA as unknown as {
    oneOf: EventBranchView[];
    definitions: Record<string, Record<string, unknown>>;
  };
}

describe("product events schema/validator conformance", () => {
  it("accepts and rejects exactly the fixtures the strict validator accepts and rejects", () => {
    assertFixtureConformance(PRODUCT_EVENTS_JSON_SCHEMA, validateProductEvent, PRODUCT_EVENT_FIXTURES);
  });

  it("encodes all twelve payload variants as closed oneOf branches in canonical order", () => {
    const schema = productEventSchemaView();
    expect(schema.oneOf).toHaveLength(RUN_EVENT_TYPES.length);
    expect(schema.oneOf.map((branch) => branch.properties.type?.const)).toEqual([...RUN_EVENT_TYPES]);
    for (const branch of schema.oneOf) {
      expect(branch.type).toBe("object");
      expect(branch.additionalProperties).toBe(false);
      expect(branch.properties.contractVersion?.const).toBe(PRODUCT_EVENTS_CONTRACT_VERSION);
      expect(branch.required).toEqual(expect.arrayContaining(EVENT_ENVELOPE_FIELDS));
    }
  });

  it("encodes the stage enum, progress bounds and failure code enums", () => {
    const schema = productEventSchemaView();
    const byTitle = Object.fromEntries(schema.oneOf.map((branch) => [branch.title, branch]));
    expect(byTitle.StageChanged?.properties.stage?.enum).toEqual([...RUN_STAGES]);
    expect(byTitle.ProgressUpdated?.properties.progressPercent?.minimum).toBe(0);
    expect(byTitle.ProgressUpdated?.properties.progressPercent?.maximum).toBe(100);
    expect(byTitle.ArtifactValidationFailed?.properties.failureCode?.enum).toEqual([...RUN_FAILURE_CODES]);
    expect(byTitle.Failed?.properties.failureCode?.enum).toEqual([...RUN_FAILURE_CODES]);
    expect(byTitle.CancellationConfirmed?.required).toEqual(EVENT_ENVELOPE_FIELDS);
  });

  it("requires RuntimeMetadataUpdated metadata to satisfy the Runtime Metadata contract", () => {
    const schema = productEventSchemaView();
    const byTitle = Object.fromEntries(schema.oneOf.map((branch) => [branch.title, branch]));
    expect(byTitle.RuntimeMetadataUpdated?.properties.metadata?.$ref).toBe(
      "#/definitions/runtimeMetadata"
    );
    expect(schema.definitions.runtimeMetadata?.$id).toBe(RUNTIME_METADATA_SCHEMA_ID);
    expect(schema.definitions.runtimeMetadata?.additionalProperties).toBe(false);
  });
});

/** A schema-valid artifact reference with a real 64-char hex digest. */
function turnOutputArtifactRef(seed: string): Record<string, unknown> {
  const hex = [...seed].map((char) => char.charCodeAt(0) % 16).map((n) => n.toString(16));
  let sha256 = "";
  while (sha256.length < 64) {
    sha256 += hex.join("");
  }
  return {
    fileName: `${seed}.png`,
    relativePath: `output/${seed}.png`,
    sizeBytes: 1024,
    sha256: sha256.slice(0, 64)
  };
}

function turnOutputManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: RESULT_MANIFEST_CONTRACT_VERSION,
    result: "completed",
    solidWorksVersion: "2025",
    units: "mm",
    projectionDecision: "第三角投影",
    featureCount: 12,
    bodyCount: 1,
    rebuildStatus: "PASSED",
    unresolvedAssumptions: [],
    artifacts: {
      sldprt: turnOutputArtifactRef("sldprt"),
      preview: turnOutputArtifactRef("preview"),
      dimensionLedger: turnOutputArtifactRef("ledger"),
      featurePlan: turnOutputArtifactRef("plan"),
      buildValidationLog: turnOutputArtifactRef("log"),
      builderSource: turnOutputArtifactRef("source")
    },
    ...overrides
  };
}

function turnOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: AGENT_TURN_OUTPUT_CONTRACT_VERSION,
    result: "completed",
    completed: turnOutputManifest(),
    ...overrides
  };
}

const AGENT_TURN_OUTPUT_FIXTURES: readonly Fixture[] = [
  {
    name: "completed turn with the embedded Result Manifest v1",
    value: turnOutput(),
    valid: true
  },
  {
    name: "clarification turn with dimension and choice questions only",
    value: {
      contractVersion: AGENT_TURN_OUTPUT_CONTRACT_VERSION,
      result: "clarification_required",
      questions: [
        { id: "q1", type: "dimension", question: "底板厚度是多少？", hint: "例如 12", unit: "mm" },
        {
          id: "q2",
          type: "choice",
          question: "焊缝处理方式？",
          options: [
            { id: "none", label: "无需焊缝" },
            { id: "full", label: "全周满焊" }
          ]
        }
      ]
    },
    valid: true
  },
  {
    name: "both terminal states present",
    value: turnOutput({ questions: [{ id: "q1", type: "text", question: "材料？" }] }),
    valid: false
  },
  {
    name: "neither terminal state present",
    value: { contractVersion: AGENT_TURN_OUTPUT_CONTRACT_VERSION, result: "completed" },
    valid: false
  },
  {
    name: "unknown result value",
    value: turnOutput({ result: "partially-done" }),
    valid: false
  },
  {
    name: "wrong contract version",
    value: turnOutput({ contractVersion: 2 }),
    valid: false
  },
  {
    name: "completed turn with an unknown field",
    value: turnOutput({ owner: "runner" }),
    valid: false
  },
  {
    name: "clarification turn with an empty question set",
    value: {
      contractVersion: AGENT_TURN_OUTPUT_CONTRACT_VERSION,
      result: "clarification_required",
      questions: []
    },
    valid: false
  },
  {
    name: "clarification turn with a choice question without options",
    value: {
      contractVersion: AGENT_TURN_OUTPUT_CONTRACT_VERSION,
      result: "clarification_required",
      questions: [{ id: "q1", type: "choice", question: "倒角？" }]
    },
    valid: false
  },
  {
    name: "clarification turn with an unknown question type",
    value: {
      contractVersion: AGENT_TURN_OUTPUT_CONTRACT_VERSION,
      result: "clarification_required",
      questions: [{ id: "q1", type: "date", question: "when?" }]
    },
    valid: false
  },
  {
    name: "completed turn whose embedded manifest fails Result Manifest v1",
    value: turnOutput({ completed: turnOutputManifest({ solidWorksVersion: "" }) }),
    valid: false
  },
  {
    name: "completed turn whose embedded manifest misses an artifact",
    value: turnOutput({
      completed: { ...turnOutputManifest(), artifacts: { sldprt: turnOutputArtifactRef("sldprt") } }
    }),
    valid: false
  },
  {
    name: "clarification turn with an unknown field",
    value: {
      contractVersion: AGENT_TURN_OUTPUT_CONTRACT_VERSION,
      result: "clarification_required",
      questions: [{ id: "q1", type: "text", question: "材料？" }],
      priority: "high"
    },
    valid: false
  }
];

interface AgentTurnOutputSchemaView {
  oneOf: Array<{
    title: string;
    additionalProperties: boolean;
    required: string[];
    properties: Record<string, Record<string, unknown>>;
  }>;
  definitions: Record<string, Record<string, unknown>>;
}

function agentTurnOutputSchemaView(): AgentTurnOutputSchemaView {
  return AGENT_TURN_OUTPUT_JSON_SCHEMA as unknown as AgentTurnOutputSchemaView;
}

describe("agent turn output schema/validator conformance", () => {
  it("accepts and rejects exactly the fixtures the strict validator accepts and rejects", () => {
    assertFixtureConformance(
      AGENT_TURN_OUTPUT_JSON_SCHEMA,
      validateAgentTurnOutput,
      AGENT_TURN_OUTPUT_FIXTURES
    );
  });

  it("encodes the two terminal states as closed oneOf branches with const results", () => {
    const schema = agentTurnOutputSchemaView();
    expect(schema.oneOf).toHaveLength(2);
    expect(schema.oneOf.map((branch) => branch.properties.result?.const)).toEqual([
      "completed",
      "clarification_required"
    ]);
    for (const branch of schema.oneOf) {
      expect(branch.additionalProperties).toBe(false);
      expect(branch.required).toEqual(expect.arrayContaining(["contractVersion", "result"]));
      expect(branch.properties.contractVersion?.const).toBe(AGENT_TURN_OUTPUT_CONTRACT_VERSION);
    }
  });

  it("reuses the embedded Result Manifest v1 document and mirrors its artifact ref", () => {
    const schema = agentTurnOutputSchemaView();
    const completed = schema.oneOf.find((branch) => branch.title === "completed turn");
    const clarification = schema.oneOf.find(
      (branch) => branch.title === "clarification required"
    );
    expect(completed?.properties.completed?.$ref).toBe("#/definitions/resultManifest");
    expect(schema.definitions.resultManifest?.$id).toBe("swpanel://contracts/result-manifest/1");
    expect(schema.definitions.resultManifest?.contractVersion).toBeUndefined();
    // The fragment refs of the embedded manifest resolve against this document
    // (draft-07 root-scoped resolution): the artifact ref is mirrored.
    expect(schema.definitions.artifactRef?.required).toEqual(["fileName", "relativePath", "sizeBytes", "sha256"]);
    // The clarification branch carries ONLY the questions array.
    expect(clarification?.required).toEqual(["contractVersion", "result", "questions"]);
    expect(clarification?.properties.questions?.minItems).toBe(1);
    expect(clarification?.properties.completed).toBeUndefined();
  });

  it("reuses the strict clarification question shape (choice requires options)", () => {
    const schema = agentTurnOutputSchemaView();
    const question = schema.definitions.clarificationQuestion as unknown as {
      oneOf: Array<{
        title: string;
        required: string[];
        properties: Record<string, Record<string, unknown>>;
      }>;
    };
    expect(question.oneOf).toHaveLength(2);
    const nonChoice = question.oneOf.find((branch) => branch.title === "dimension/text question");
    const choice = question.oneOf.find((branch) => branch.title === "choice question");
    expect(nonChoice?.properties.type?.enum).toEqual(["dimension", "text"]);
    expect(choice?.properties.type?.const).toBe("choice");
    expect(choice?.required).toEqual(expect.arrayContaining(["options"]));
    expect(schema.definitions.questionOption?.required).toEqual(["id", "label"]);
  });
});

interface ClarificationSchemaView {
  additionalProperties: boolean;
  required: string[];
  properties: {
    status: { enum: string[] };
    questions: {
      type: string;
      minItems: number;
      items: {
        oneOf: Array<{
          title: string;
          additionalProperties: boolean;
          required: string[];
          properties: Record<string, Record<string, unknown>>;
        }>;
      };
    };
    answers: {
      items: {
        additionalProperties: boolean;
        required: string[];
        properties: {
          value: {
            oneOf: Array<{
              title: string;
              additionalProperties: boolean;
              required: string[];
              properties: Record<string, Record<string, unknown>>;
            }>;
          };
        };
      };
    };
  };
  definitions: Record<string, Record<string, unknown>>;
}

function clarificationSchemaView(): ClarificationSchemaView {
  return CLARIFICATION_JSON_SCHEMA as unknown as ClarificationSchemaView;
}

describe("clarification schema/validator conformance", () => {
  it("accepts and rejects exactly the fixtures the strict validator accepts and rejects", () => {
    assertFixtureConformance(CLARIFICATION_JSON_SCHEMA, validateClarificationRequest, CLARIFICATION_FIXTURES);
  });

  it("keeps the request, questions and answers closed to unknown fields", () => {
    const schema = clarificationSchemaView();
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(
      expect.arrayContaining(["contractVersion", "questions", "answers", "createdAt"])
    );
    expect(schema.properties.status.enum).toEqual([...CLARIFICATION_STATUSES]);
    expect(schema.properties.questions.type).toBe("array");
    expect(schema.properties.questions.minItems).toBe(1);
    expect(schema.properties.answers.items.additionalProperties).toBe(false);
    expect(schema.properties.answers.items.required).toEqual(
      expect.arrayContaining(["id", "questionId", "value", "answeredAt", "answeredBy"])
    );
  });

  it("encodes choice-requires-options as a two-branch question oneOf", () => {
    const schema = clarificationSchemaView();
    const branches = schema.properties.questions.items.oneOf;
    expect(branches).toHaveLength(2);
    const nonChoice = branches.find((branch) => branch.title === "dimension/text question");
    const choice = branches.find((branch) => branch.title === "choice question");
    expect(nonChoice?.properties.type?.enum).toEqual(["dimension", "text"]);
    expect(choice?.properties.type?.const).toBe("choice");
    expect(choice?.required).toEqual(expect.arrayContaining(["options"]));
    expect(choice?.properties.options?.minItems).toBe(1);
    for (const branch of branches) {
      expect(branch.additionalProperties).toBe(false);
      expect(branch.required).toEqual(expect.arrayContaining(["id", "type", "question"]));
    }
  });

  it("encodes the three answer value kinds as closed oneOf branches", () => {
    const schema = clarificationSchemaView();
    const branches = schema.properties.answers.items.properties.value.oneOf;
    expect(branches).toHaveLength(3);
    expect(branches.map((branch) => branch.properties.kind?.const)).toEqual([
      ...CLARIFICATION_QUESTION_TYPES
    ]);
    const dimension = branches.find((branch) => branch.title === "dimension answer");
    const text = branches.find((branch) => branch.title === "text answer");
    const choice = branches.find((branch) => branch.title === "choice answer");
    expect(dimension?.required).toEqual(["kind", "value", "unit"]);
    expect(text?.required).toEqual(["kind", "value"]);
    expect(choice?.required).toEqual(["kind", "optionId"]);
    for (const branch of branches) {
      expect(branch.additionalProperties).toBe(false);
    }
  });

  it("reuses a closed question option definition", () => {
    const schema = clarificationSchemaView();
    const option = schema.definitions.questionOption;
    expect(option?.additionalProperties).toBe(false);
    expect(option?.required).toEqual(["id", "label"]);
    const optionItemsRef = (branch: (typeof schema.properties.questions.items.oneOf)[number]): string | undefined =>
      (branch.properties.options?.items as { $ref?: string } | undefined)?.$ref;
    expect(optionItemsRef(schema.properties.questions.items.oneOf[0]!)).toBe(
      "#/definitions/questionOption"
    );
    expect(optionItemsRef(schema.properties.questions.items.oneOf[1]!)).toBe(
      "#/definitions/questionOption"
    );
  });
});
