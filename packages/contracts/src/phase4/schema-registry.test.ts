import { describe, expect, it } from "vitest";

import {
  IPC_ENVELOPE_JSON_SCHEMA,
  IPC_PROTOCOL_VERSION,
  PHASE4_REGISTRY_VERSION,
  PHASE4_SCHEMA_DRAFT,
  PHASE4_SCHEMAS,
  PHASE4_SCHEMA_IDS,
  Phase4ContractError,
  getPhase4Schema,
  isPhase4SchemaId,
  validatePhase4SchemaRegistration,
  type Phase4SchemaDocument
} from "../index.js";

function expectCode(fn: () => unknown, code: Phase4ContractError["code"]): void {
  expect(fn).toThrowError(expect.objectContaining({ code }));
}

describe("phase 4 schema registry", () => {
  it("pins the registry version and draft", () => {
    expect(PHASE4_REGISTRY_VERSION).toBe(1);
    expect(PHASE4_SCHEMA_DRAFT).toBe("http://json-schema.org/draft-07/schema#");
  });

  it("registers every schema id exactly once", () => {
    expect(PHASE4_SCHEMAS).toHaveLength(PHASE4_SCHEMA_IDS.length);
    expect(PHASE4_SCHEMAS.map((entry) => entry.id)).toEqual([...PHASE4_SCHEMA_IDS]);
    const ids = PHASE4_SCHEMAS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("registers the nine Phase 4 contracts", () => {
    expect(PHASE4_SCHEMA_IDS).toEqual([
      "swpanel://contracts/ipc-envelope/1",
      "swpanel://contracts/invocation-package/1",
      "swpanel://contracts/runtime-metadata/1",
      "swpanel://contracts/product-events/1",
      "swpanel://contracts/clarification/1",
      "swpanel://contracts/error/1",
      "swpanel://contracts/input-adaptation/2",
      "swpanel://contracts/result-manifest/1",
      "swpanel://contracts/agent-turn-output/1"
    ]);
  });

  it("keeps every registered schema document serializable and draft-07 compliant", () => {
    for (const entry of PHASE4_SCHEMAS) {
      const roundTrip: unknown = JSON.parse(JSON.stringify(entry.schema));
      expect(roundTrip).toEqual(entry.schema);
      expect(entry.schema.$schema).toBe(PHASE4_SCHEMA_DRAFT);
      expect(entry.schema.$id).toBe(entry.id);
      expect(entry.schema.$id).toMatch(/\/\d+$/);
    }
  });

  it("accepts every registered entry through the registration validator", () => {
    for (const entry of PHASE4_SCHEMAS) {
      expect(validatePhase4SchemaRegistration(entry)).toEqual(entry);
      expect(isPhase4SchemaId(entry.id)).toBe(true);
    }
  });

  it("resolves registered schemas by id and rejects unknown ids", () => {
    expect(getPhase4Schema("swpanel://contracts/result-manifest/1").title).toBe(
      "SWPanel Result Manifest"
    );
    expect(getPhase4Schema("swpanel://contracts/agent-turn-output/1").title).toBe(
      "SWPanel Agent Turn Output"
    );
    expect(getPhase4Schema("swpanel://contracts/invocation-package/1").version).toBe(1);
    expectCode(
      () => getPhase4Schema("swpanel://contracts/unknown/1" as never),
      "INVALID_CONTRACT"
    );
    expect(isPhase4SchemaId("swpanel://contracts/unknown/1")).toBe(false);
    expect(isPhase4SchemaId(42)).toBe(false);
  });

  it("rejects registration entries with unknown fields or an unknown schema id", () => {
    const entry = PHASE4_SCHEMAS[0] as Phase4SchemaDocument;
    expectCode(
      () => validatePhase4SchemaRegistration({ ...entry, owner: "runner" }),
      "UNKNOWN_FIELD"
    );
    expectCode(
      () =>
        validatePhase4SchemaRegistration({
          ...entry,
          id: "swpanel://contracts/not-registered/1"
        }),
      "INVALID_CONTRACT"
    );
  });

  it("rejects a registration whose version does not match the schema $id", () => {
    const entry = PHASE4_SCHEMAS[0] as Phase4SchemaDocument;
    expectCode(
      () => validatePhase4SchemaRegistration({ ...entry, version: 2 }),
      "VERSION_MISMATCH"
    );
  });

  it("rejects a registration whose schema $id or draft does not match", () => {
    const entry = PHASE4_SCHEMAS[0] as Phase4SchemaDocument;
    expectCode(
      () =>
        validatePhase4SchemaRegistration({
          ...entry,
          schema: { ...entry.schema, $id: "swpanel://contracts/other/1" }
        }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () =>
        validatePhase4SchemaRegistration({
          ...entry,
          schema: { ...entry.schema, $schema: "http://json-schema.org/draft-04/schema#" }
        }),
      "INVALID_CONTRACT"
    );
  });

  it("documents the IPC envelope with the pinned protocol version and allowlisted operations", () => {
    const schema = IPC_ENVELOPE_JSON_SCHEMA as unknown as {
      oneOf: { properties: { protocolVersion: { const: number }; operation?: { enum: string[] } } }[];
    };
    for (const kind of schema.oneOf) {
      expect(kind.properties.protocolVersion.const).toBe(IPC_PROTOCOL_VERSION);
    }
    const requestKind = schema.oneOf.find((kind) => kind.properties.operation !== undefined);
    expect(requestKind).toBeDefined();
    const operations = requestKind!.properties.operation!.enum;
    expect(operations).toContain("drawing.create");
    expect(operations).toContain("run.create");
    expect(operations).toContain("run.subscribe");
    expect(operations).toContain("drawing.getHistory");
  });

  it("rejects non-object registrations", () => {
    expectCode(() => validatePhase4SchemaRegistration("entry"), "INVALID_CONTRACT");
    expectCode(() => validatePhase4SchemaRegistration(null), "INVALID_CONTRACT");
  });
});
