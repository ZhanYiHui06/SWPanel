import {
  PHASE4_SCHEMA_DRAFT,
  RESULT_MANIFEST_SCHEMA_ID
} from "./schema-ids.js";
import {
  Phase4ContractError,
  assertNoUnknownKeys,
  assertNonEmptyString,
  isPositiveSafeInteger,
  isRecord,
  isSha256Hex
} from "./shared.js";

/**
 * Versioned Result Manifest contract (architecture.md §9.5): the machine-readable
 * success statement the Agent's final turn must satisfy before SWPanel
 * independently verifies the files. The manifest declares the model summary and
 * the complete artifact set; an Agent claim of completion is never authoritative
 * by itself.
 */
export const RESULT_MANIFEST_CONTRACT_VERSION = 1 as const;

/** The only legal manifest outcome; anything else is not a success statement. */
export const RESULT_MANIFEST_RESULTS = ["completed"] as const;
export type ResultManifestResult = (typeof RESULT_MANIFEST_RESULTS)[number];

/**
 * Required artifact references of the manifest. `processMp4` is additionally
 * required only when recording was explicitly requested.
 */
export const REQUIRED_RESULT_MANIFEST_ARTIFACTS = [
  "sldprt",
  "preview",
  "dimensionLedger",
  "featurePlan",
  "buildValidationLog",
  "builderSource"
] as const;
export type ResultManifestArtifactKey = (typeof REQUIRED_RESULT_MANIFEST_ARTIFACTS)[number];

export interface ResultManifestArtifactRef {
  fileName: string;
  /** Canonical workspace-relative path; never user-supplied text. */
  relativePath: string;
  sizeBytes: number;
  sha256: string;
}

export interface ResultManifestArtifacts {
  sldprt: ResultManifestArtifactRef;
  preview: ResultManifestArtifactRef;
  dimensionLedger: ResultManifestArtifactRef;
  featurePlan: ResultManifestArtifactRef;
  buildValidationLog: ResultManifestArtifactRef;
  builderSource: ResultManifestArtifactRef;
  /** Required only when recording was explicitly requested. */
  processMp4?: ResultManifestArtifactRef;
}

export interface ResultManifest {
  contractVersion: typeof RESULT_MANIFEST_CONTRACT_VERSION;
  result: ResultManifestResult;
  /**
   * The ACTUAL SolidWorks version the builder used, recorded verbatim and
   * validated as a non-empty normalized string (architecture.md §9.5). The
   * contract is version-agnostic: any real version (including legacy `2022`
   * values and newer releases such as `2025`) is legal — no version is
   * required or implied.
   */
  solidWorksVersion: string;
  units: string;
  projectionDecision: string;
  featureCount: number;
  bodyCount: number;
  rebuildStatus: "PASSED" | "FAILED";
  unresolvedAssumptions: readonly string[];
  /**
   * Truthful production-verification claim of the producing Agent, persisted
   * by the publisher onto the published Model (P5 truthfulness hardening). The
   * wire document MAY omit the field (absent means `false` — no claim, no
   * verification); the STRICTLY validated normalized manifest always carries
   * the boolean, so the publisher never has to guess.
   */
  productionVerified: boolean;
  artifacts: ResultManifestArtifacts;
}

/** JSON Schema document registering/documenting the Result Manifest contract. */
export const RESULT_MANIFEST_JSON_SCHEMA = {
  $schema: PHASE4_SCHEMA_DRAFT,
  $id: RESULT_MANIFEST_SCHEMA_ID,
  title: "SWPanel Result Manifest",
  description:
    "Machine-readable success statement of a modeling turn: model summary, " +
    "rebuild status and the complete required artifact set. Independently " +
    "verified against the workspace before a Run may complete.",
  type: "object",
  additionalProperties: false,
  required: [
    "contractVersion",
    "result",
    "solidWorksVersion",
    "units",
    "projectionDecision",
    "featureCount",
    "bodyCount",
    "rebuildStatus",
    "unresolvedAssumptions",
    "artifacts"
  ],
  properties: {
    contractVersion: { const: RESULT_MANIFEST_CONTRACT_VERSION },
    result: { enum: [...RESULT_MANIFEST_RESULTS] },
    // Version-agnostic: the builder records the ACTUAL SolidWorks version it
    // used; any non-empty string (legacy "2022" included) is legal.
    solidWorksVersion: { type: "string", minLength: 1 },
    units: { type: "string", minLength: 1 },
    projectionDecision: { type: "string", minLength: 1 },
    featureCount: { type: "integer", minimum: 1 },
    bodyCount: { type: "integer", minimum: 1 },
    rebuildStatus: { enum: ["PASSED", "FAILED"] },
    unresolvedAssumptions: { type: "array", items: { type: "string", minLength: 1 } },
    // Optional on the wire: absent means productionVerified false.
    productionVerified: { type: "boolean" },
    artifacts: {
      type: "object",
      additionalProperties: false,
      required: [...REQUIRED_RESULT_MANIFEST_ARTIFACTS],
      properties: {
        sldprt: { $ref: "#/definitions/artifactRef" },
        preview: { $ref: "#/definitions/artifactRef" },
        dimensionLedger: { $ref: "#/definitions/artifactRef" },
        featurePlan: { $ref: "#/definitions/artifactRef" },
        buildValidationLog: { $ref: "#/definitions/artifactRef" },
        builderSource: { $ref: "#/definitions/artifactRef" },
        processMp4: { $ref: "#/definitions/artifactRef" }
      }
    }
  },
  definitions: {
    artifactRef: {
      type: "object",
      additionalProperties: false,
      required: ["fileName", "relativePath", "sizeBytes", "sha256"],
      properties: {
        fileName: { type: "string", minLength: 1 },
        relativePath: { type: "string", minLength: 1 },
        sizeBytes: { type: "integer", minimum: 1 },
        sha256: { type: "string", pattern: "^[0-9a-f]{64}$" }
      }
    }
  }
} as const;

const RESULT_MANIFEST_ARTIFACT_KEYS: readonly string[] = [
  ...REQUIRED_RESULT_MANIFEST_ARTIFACTS,
  "processMp4"
];

function assertArtifactRef(value: unknown, key: string): ResultManifestArtifactRef {
  if (!isRecord(value)) {
    throw new Phase4ContractError("INVALID_CONTRACT", `artifacts.${key} must be an object`);
  }
  assertNoUnknownKeys(value, ["fileName", "relativePath", "sizeBytes", "sha256"], `artifacts.${key}`);
  const fileName = assertNonEmptyString(value, "fileName", `artifacts.${key}`);
  const relativePath = assertNonEmptyString(value, "relativePath", `artifacts.${key}`);
  if (!isPositiveSafeInteger(value.sizeBytes)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      `artifacts.${key}.sizeBytes must be a positive integer`
    );
  }
  if (!isSha256Hex(value.sha256)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      `artifacts.${key}.sha256 must be a 64-char hex digest`
    );
  }
  return { fileName, relativePath, sizeBytes: value.sizeBytes, sha256: value.sha256 };
}

/**
 * Strictly validates a serialized Result Manifest. Throws
 * {@link Phase4ContractError} on the first violation: contract version mismatch,
 * unknown fields, a non-completed result, a missing / empty / non-string
 * `solidWorksVersion`, a missing required artifact, an invalid artifact
 * reference or a non-boolean `productionVerified`. The normalized manifest
 * ALWAYS carries the boolean `productionVerified` (absent on the wire defaults
 * to `false`), so consumers never guess whether the Agent claimed production
 * verification. `solidWorksVersion` is normalized to the validated non-empty
 * actual-version string — legacy `2022` values and any real version are read
 * unchanged.
 */
export function validateResultManifest(value: unknown): ResultManifest {
  if (!isRecord(value)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "Result Manifest must be a JSON object");
  }
  assertNoUnknownKeys(
    value,
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
    ],
    "Result Manifest"
  );
  if (value.contractVersion !== RESULT_MANIFEST_CONTRACT_VERSION) {
    throw new Phase4ContractError(
      "VERSION_MISMATCH",
      `Expected contractVersion ${RESULT_MANIFEST_CONTRACT_VERSION}, got ${JSON.stringify(value.contractVersion)}`
    );
  }
  if (value.result !== "completed") {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "Result Manifest result must be 'completed'"
    );
  }
  // Version-agnostic actual-version string: validated as a non-empty string,
  // never pinned to a specific release. Legacy "2022" values read unchanged.
  const solidWorksVersion = assertNonEmptyString(value, "solidWorksVersion", "Result Manifest");
  const units = assertNonEmptyString(value, "units", "Result Manifest");
  const projectionDecision = assertNonEmptyString(value, "projectionDecision", "Result Manifest");
  if (!isPositiveSafeInteger(value.featureCount)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "featureCount must be a positive integer"
    );
  }
  if (!isPositiveSafeInteger(value.bodyCount)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "bodyCount must be a positive integer");
  }
  if (value.rebuildStatus !== "PASSED" && value.rebuildStatus !== "FAILED") {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "rebuildStatus must be one of PASSED, FAILED"
    );
  }
  const unresolvedAssumptions = value.unresolvedAssumptions;
  if (!Array.isArray(unresolvedAssumptions)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "unresolvedAssumptions must be an array"
    );
  }
  for (const assumption of unresolvedAssumptions) {
    if (typeof assumption !== "string" || assumption.length === 0) {
      throw new Phase4ContractError(
        "INVALID_CONTRACT",
        "unresolvedAssumptions items must be non-empty strings"
      );
    }
  }

  // productionVerified is optional on the wire and defaults to false: an agent
  // that makes no production-verification claim is truthfully NOT production
  // verified. A present value must be a boolean — a stringified or numeric
  // truthiness claim is a contract violation, never silently coerced.
  const productionVerified = value.productionVerified === undefined ? false : value.productionVerified;
  if (typeof productionVerified !== "boolean") {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "productionVerified must be a boolean when present"
    );
  }

  const artifacts = value.artifacts;
  if (!isRecord(artifacts)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "artifacts must be an object");
  }
  assertNoUnknownKeys(artifacts, RESULT_MANIFEST_ARTIFACT_KEYS, "artifacts");
  for (const key of REQUIRED_RESULT_MANIFEST_ARTIFACTS) {
    if (artifacts[key] === undefined) {
      throw new Phase4ContractError(
        "INVALID_CONTRACT",
        `artifacts must carry the required reference ${key}`
      );
    }
  }
  const sldprt = assertArtifactRef(artifacts.sldprt, "sldprt");
  const preview = assertArtifactRef(artifacts.preview, "preview");
  const dimensionLedger = assertArtifactRef(artifacts.dimensionLedger, "dimensionLedger");
  const featurePlan = assertArtifactRef(artifacts.featurePlan, "featurePlan");
  const buildValidationLog = assertArtifactRef(artifacts.buildValidationLog, "buildValidationLog");
  const builderSource = assertArtifactRef(artifacts.builderSource, "builderSource");
  const processMp4 =
    artifacts.processMp4 === undefined ? undefined : assertArtifactRef(artifacts.processMp4, "processMp4");

  return {
    contractVersion: RESULT_MANIFEST_CONTRACT_VERSION,
    result: "completed",
    solidWorksVersion,
    units,
    projectionDecision,
    featureCount: value.featureCount,
    bodyCount: value.bodyCount,
    rebuildStatus: value.rebuildStatus,
    unresolvedAssumptions: unresolvedAssumptions as readonly string[],
    productionVerified,
    artifacts: {
      sldprt,
      preview,
      dimensionLedger,
      featurePlan,
      buildValidationLog,
      builderSource,
      ...(processMp4 === undefined ? {} : { processMp4 })
    }
  };
}
