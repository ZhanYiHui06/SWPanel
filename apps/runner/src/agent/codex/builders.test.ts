import { describe, expect, it } from "vitest";

import { AGENT_TURN_OUTPUT_JSON_SCHEMA } from "@swpanel/contracts";

import { InvalidArgumentError } from "../../errors.js";
import {
  CODEX_AGENT_TURN_OUTPUT_WIRE_SCHEMA
} from "./codex-agent-turn-output.js";
import {
  buildSkillsListParams,
  buildThreadResumeParams,
  buildThreadStartParams,
  buildTurnInterruptParams,
  buildTurnStartParams,
  CODEX_APPROVAL_POLICY,
  CODEX_SANDBOX_MODE
} from "./builders.js";

const ATTEMPT_ROOT = "C:\\workspaces\\runs\\run-1\\attempt-001";
const IMAGE = "C:\\workspaces\\runs\\run-1\\attempt-001\\input\\drawing.png";
const SKILL_PATH = "C:\\skills\\solidworks-build-part-from-drawing";

describe("Codex param builders (0.147.0 used subset)", () => {
  it("builds thread/start params with the STABLE workspace-write fields ONLY (never the gated runtimeWorkspaceRoots field), approvalPolicy pinned to never", () => {
    const params = buildThreadStartParams({
      cwd: ATTEMPT_ROOT,
      writableRoots: [ATTEMPT_ROOT]
    });
    expect(params).toEqual({
      cwd: ATTEMPT_ROOT,
      sandbox: CODEX_SANDBOX_MODE,
      // The background Runner must not depend on interactive approval and must
      // not auto-approve out-of-scope actions: the thread opens with an
      // explicit approvalPolicy "never" (0.147.0 AskForApproval), never the
      // app-server default that routes approval-required actions to the client.
      approvalPolicy: CODEX_APPROVAL_POLICY
    });
    // `runtimeWorkspaceRoots` is a gated field (native Codex 0.147.0 rejects
    // it with -32600 unless the client declares experimentalApi): the stable
    // thread-open params must never carry it.
    expect(params).not.toHaveProperty("runtimeWorkspaceRoots");
  });

  it("builds thread/resume params from the prior thread id + the same stable fields (no gated runtimeWorkspaceRoots, approvalPolicy pinned to never)", () => {
    const params = buildThreadResumeParams({
      threadId: "thread-prior-1",
      cwd: ATTEMPT_ROOT,
      writableRoots: [ATTEMPT_ROOT]
    });
    expect(params).toEqual({
      threadId: "thread-prior-1",
      cwd: ATTEMPT_ROOT,
      sandbox: CODEX_SANDBOX_MODE,
      // Same explicit approval policy as thread/start: a resumed thread never
      // falls back to the persisted/overridden approval default either.
      approvalPolicy: CODEX_APPROVAL_POLICY
    });
    expect(params).not.toHaveProperty("runtimeWorkspaceRoots");
  });

  it("builds turn/start params: text + localImage + skill input, PROVIDER-FACING Agent Turn Output outputSchema, attempt-root workspaceWrite", () => {
    const params = buildTurnStartParams({
      threadId: "thread-1",
      promptText: "请根据图纸建模",
      localImageAbsolutePath: IMAGE,
      skill: { name: "solidworks-build-part-from-drawing", resolvedPath: SKILL_PATH },
      writableRoots: [ATTEMPT_ROOT]
    });
    expect(params).toEqual({
      threadId: "thread-1",
      input: [
        { type: "text", text: "请根据图纸建模" },
        { type: "localImage", path: IMAGE },
        { type: "skill", name: "solidworks-build-part-from-drawing", path: SKILL_PATH }
      ],
      // The PROVIDER-FACING Agent Turn Output wire schema constrains the final
      // assistant message to EXACTLY ONE terminal state (completed Result
      // Manifest vs structured clarification) in the flattened Structured
      // Outputs shape native Codex 0.147.0 accepts.
      outputSchema: CODEX_AGENT_TURN_OUTPUT_WIRE_SCHEMA,
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [ATTEMPT_ROOT] }
    });
    // The builder MUST send the provider-facing wire schema, never the
    // canonical registered root-oneOf document native Codex 0.147.0 rejects
    // as outputSchema.
    expect(params.outputSchema).not.toBe(AGENT_TURN_OUTPUT_JSON_SCHEMA);
    expect(params.outputSchema).toMatchObject({
      title: "SWPanel Agent Turn Output (Codex provider wire schema)",
      type: "object",
      additionalProperties: false,
      required: ["contractVersion", "result", "completed", "questions"]
    });
    const schema = params.outputSchema as Record<string, unknown>;
    expect(schema).not.toHaveProperty("oneOf");
    expect(schema).not.toHaveProperty("anyOf");
    expect(schema).not.toHaveProperty("$schema");
    expect(schema).not.toHaveProperty("$id");
    expect(schema).not.toHaveProperty("definitions");
    expect(JSON.stringify(schema)).not.toContain("$ref");
    // The terminal states are encoded with required nullable sentinels.
    const properties = schema.properties as Record<string, { type: unknown }>;
    expect(properties.completed?.type).toEqual(["object", "null"]);
    expect(properties.questions?.type).toEqual(["array", "null"]);
    // turn/start carries the writable roots ONLY inside sandboxPolicy — the
    // gated thread field never appears here either.
    expect(params).not.toHaveProperty("runtimeWorkspaceRoots");
  });

  it("builds turn/interrupt params with the exact 0.147.0 field names", () => {
    expect(
      buildTurnInterruptParams({ threadId: "thread-1", turnId: "turn-9" })
    ).toEqual({ threadId: "thread-1", turnId: "turn-9" });
  });

  it("rejects caller violations defensively (absolute paths, non-empty inputs)", () => {
    expect(() =>
      buildThreadStartParams({ cwd: "relative/path", writableRoots: [ATTEMPT_ROOT] })
    ).toThrowError(InvalidArgumentError);
    expect(() => buildThreadStartParams({ cwd: ATTEMPT_ROOT, writableRoots: [] })).toThrowError(
      InvalidArgumentError
    );
    expect(() =>
      buildThreadStartParams({ cwd: ATTEMPT_ROOT, writableRoots: ["relative/root"] })
    ).toThrowError(InvalidArgumentError);
    expect(() =>
      buildThreadResumeParams({ threadId: "", cwd: ATTEMPT_ROOT, writableRoots: [ATTEMPT_ROOT] })
    ).toThrowError(InvalidArgumentError);
    expect(() =>
      buildTurnStartParams({
        threadId: "thread-1",
        promptText: "",
        localImageAbsolutePath: IMAGE,
        skill: { name: "s", resolvedPath: SKILL_PATH },
        writableRoots: [ATTEMPT_ROOT]
      })
    ).toThrowError(InvalidArgumentError);
    expect(() =>
      buildTurnStartParams({
        threadId: "thread-1",
        promptText: "prompt",
        localImageAbsolutePath: "relative/image.png",
        skill: { name: "s", resolvedPath: SKILL_PATH },
        writableRoots: [ATTEMPT_ROOT]
      })
    ).toThrowError(InvalidArgumentError);
    expect(() =>
      buildTurnStartParams({
        threadId: "thread-1",
        promptText: "prompt",
        localImageAbsolutePath: IMAGE,
        skill: { name: "", resolvedPath: SKILL_PATH },
        writableRoots: [ATTEMPT_ROOT]
      })
    ).toThrowError(InvalidArgumentError);
    expect(() =>
      buildTurnStartParams({
        threadId: "thread-1",
        promptText: "prompt",
        localImageAbsolutePath: IMAGE,
        skill: { name: "s", resolvedPath: "" },
        writableRoots: [ATTEMPT_ROOT]
      })
    ).toThrowError(InvalidArgumentError);
    // Regression: skill.resolvedPath is validated as an ABSOLUTE path, not
    // merely non-empty (a relative skill path must never reach the wire).
    expect(() =>
      buildTurnStartParams({
        threadId: "thread-1",
        promptText: "prompt",
        localImageAbsolutePath: IMAGE,
        skill: { name: "s", resolvedPath: "relative/skill" },
        writableRoots: [ATTEMPT_ROOT]
      })
    ).toThrowError(InvalidArgumentError);
    expect(() => buildTurnInterruptParams({ threadId: "", turnId: "t" })).toThrowError(
      InvalidArgumentError
    );
    expect(() => buildTurnInterruptParams({ threadId: "th", turnId: "" })).toThrowError(
      InvalidArgumentError
    );
  });

  it("builds skills/list params with cwds and forceReload", () => {
    expect(
      buildSkillsListParams({ cwds: ["C:\\workspaces\\run-1"], forceReload: true })
    ).toEqual({ cwds: ["C:\\workspaces\\run-1"], forceReload: true });
    expect(buildSkillsListParams({})).toEqual({});
    expect(buildSkillsListParams()).toEqual({});
    expect(buildSkillsListParams({ cwds: ["C:\\w"] })).toEqual({ cwds: ["C:\\w"] });
    expect(buildSkillsListParams({ forceReload: false })).toEqual({ forceReload: false });
  });

  it("rejects malformed skills/list inputs defensively", () => {
    expect(() => buildSkillsListParams({ cwds: [] })).toThrowError(InvalidArgumentError);
    expect(() => buildSkillsListParams({ cwds: [""] })).toThrowError(InvalidArgumentError);
    expect(() => buildSkillsListParams({ forceReload: "yes" as unknown as boolean })).toThrowError(
      InvalidArgumentError
    );
  });
});
