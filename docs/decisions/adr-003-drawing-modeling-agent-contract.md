---
title: ADR-003 Drawing Modeling Agent Contract
status: accepted
owner: JANGHI
last_updated: 2026-08-17
---

# ADR-003: `solidworks-autobuild` Is the Unified Modeling Skill Boundary

## Context

SWPanel must orchestrate an existing modeling capability without copying its algorithms. The modeling capability encompasses drawing interpretation, dimension ledger reasoning, and CAD feature creation across various mechanical features (shafts, threaded holes, CNC fillets/chamfers, assemblies).

Historically, the capability was split across `solidworks-build-part-from-drawing` (drawing reasoning) and `solidworks-automation` (execution mechanics & subskills). On 2026-08-17, these were consolidated into a self-contained, hierarchically structured unified skill: `solidworks-autobuild`.

## Decision

1. Bind Modeling Runs to the unified `solidworks-autobuild` skill.
2. The skill is self-contained under `skills/solidworks-autobuild/`, integrating:
   - 2D Drawing interpretation & Dimension Ledger reasoning (Phase A~D);
   - Core SolidWorks COM execution scripts (`scripts/sw_*.py`);
   - Expert subskills (`subskills/solidworks-threaded-holes`, `solidworks-fillet-chamfer-cnc`, `solidworks-vibecad`, `autocad-automation`).
3. Invoke the Skill through a versioned Codex runtime adapter using explicit skill and local-image inputs.
4. Keep PDF/DWG/DXF conversion in versioned SWPanel Input Adapters; preserve the original file.
5. Require all pre-CAD authority gates:
   - drawing interpretation;
   - Dimension Ledger;
   - all blocking Clarifications resolved;
   - frozen Feature Plan, origin, datums and expected feature/body counts.
6. A blocking Clarification must complete before SolidWorks is launched.
7. Require an editable, native feature-based SolidWorks part.
8. Require a SWPanel-owned structured result schema and independent Artifact validation.

Required Artifacts for this adapter:

- `.SLDPRT`;
- inspected Preview;
- Dimension Ledger;
- Feature Plan;
- Build/Validation Log;
- Builder Source;
- MP4 only when recording was explicitly requested.

## Runtime Capability Gate

A real Run may not leave `PREPARING` unless (preflight report contract v2, nine items):

- Codex runtime is available and its version matches the pinned release;
- the pinned app-server protocol is available;
- selected model supports image input;
- Skill name (`solidworks-autobuild`) and approved hash are discovered and verified;
- output Workspace containment is enforceable;
- interrupt and runtime metadata are available;
- a drivable SolidWorks installation is available (version-agnostic);
- the converted image passed Input Adapter validation (`input_adapter_succeeded`, executor-owned).

## Rationale

The Skill defines the authoritative modeling workflow and validation obligations. SWPanel owns orchestration, persistence, product events and Artifact publication, but not drawing interpretation or CAD feature algorithms.

A runtime adapter is necessary because the Skill directory has no standalone CLI, JSON/JSONL protocol, exit-code contract, cancellation API or caller-supplied output-directory parameter.

## Consequences

- Agent output is constrained by a SWPanel JSON Schema but still independently verified.
- Raw runtime events are diagnostic; they are translated into product events.
- Codex conversation resume does not imply SolidWorks feature-level resume.
- Mid-model recovery cannot be promised until the Skill’s execution dependency exposes a verified safe checkpoint.
- Builder Source is treated as untrusted Artifact, never executed by the UI.
- MVP real modeling remains gated: on 2026-08-14 the gate is availability-only for SolidWorks (version recorded, not hard-matched), the `$solidworks-build-mechanical-models` dependency is non-blocking retained Skill prose, and real modeling is blocked until a drivable SolidWorks installation and the HIL are available (see the 2026-08-14 Amendment below).

## 2026-08-14 Amendment (current state; supersedes the gate wording above)

- **SolidWorks version hard gate removed**: the preflight gate is version-agnostic — `solidworks_available` (any drivable installation) with the actual version recorded; the old `solidworks_2022_available` hard-match item is gone. `mechanical_execution_dependency_resolved` is deliberately NOT a gate item; the `$solidworks-build-mechanical-models` reference stays retained Skill prose, non-blocking and unverified (never faked as resolved). Preflight report contract is **v2 with nine items**; v1 reports from older attempts remain historical and are never rewritten.
- **External skill copies synchronized (2026-08-14)**: `C:\Users\Eric Chan\.agents\skills\solidworks-build-part-from-drawing` and `C:\Users\Eric Chan\.codex\skills\solidworks-build-part-from-drawing` are both synchronized at the canonical directory digest **`3d4bfbc97093c46292a4c0e4572c6f94685bdbda00b84949dd0b65322a556a22`** (verified with the repository's `hashSkillDirectory`; the two copies are byte-identical).
- **Codex 0.147.0 live smoke passes (final-verified)**: a live `initialize` + `skills/list` probe against the real 0.147.0 App Server runtime passes, including the **skill directory → `SKILL.md` exact-path verification** (`skillPathVerified: true` — the listing's reported `<directory>\SKILL.md` is exact-verified against the configured skill directory; a sibling/`.codex` copy/nested manifest/different file name fails closed) and discovers both exact external skill copies. The shell-free live stdio transport/lifecycle (`apps/runner/src/agent/codex/codex-child-transport.ts`) is implemented and final-verified; the real preflight probe (`real-preflight-probe.ts` + `skill-directory-hash.ts`) and the real PDF adapter + pypdfium2 4.30.0 rasterizer (300 DPI) are implemented and final-verified. **The actual live Runner now wires the owned Codex App Server adapter and the real PDF adapter** (`apps/desktop/src/main/runner-host/live-codex-wiring.ts`: exactly one persistent child transport per Runner, `ownsAgent: true`, the executor closes the adapter and the child on shutdown — bounded, never orphaned). **The async ownership-safe SolidWorks live probe** (`apps/runner/src/preflight/solidworks-live-probe.ts`) is implemented and final-verified: READ-ONLY attach to a pre-existing COM instance (never closed), owned spawn only after a clean no-instance attach (**attach errors never spawn**), COM ownership proven by exact pid, only the owned process closed. **The probe SolidWorks version is placed in the rendered prompt** (`expectedSolidWorksVersion`, `apps/runner/src/adaptation/prompt-template.ts`) and **exact-validated at the ArtifactValidator** (`apps/runner/src/artifacts/artifact-validator.ts` — a non-empty expected version must equal the manifest's `solidWorksVersion` EXACTLY or the attempt fails closed; the validator is authoritative, never the Agent text). **The final full-chain verification on the current tree passed (2026-08-14)**: `npm run check` exit 0 (desktop 31 files / 572 tests, runner 37 files / 691 tests, contracts 13 files / 148 tests, domain 14 files / 70 tests, ui 6 files / 43 tests), `npm run check:fixtures` 1/1 (13/13 scenarios, 0 violations), `npm run test:e2e` exit 0 (production Electron 20/20, browser + Electron smoke 51/51) — logs `.scratch/check-p5-final.log` / `check-fixtures-p5-final.log` / `test-e2e-p5-final.log`; the earlier "final rerun pending" timing caveat is superseded. Nothing here is HIL evidence — no live modeling turn is HIL-verified.
- **Approved PDF truthfully rasterized (2026-08-14)**: one approved PDF converted at 300 DPI to 4963×3509 — source hash `e321dc34c80b943b8af9ca9ea4ebbf9f42003627707503bf25512a479cda72a0`, output hash `30614c32a5dba38374642bf76e0e7e763674e15b78455c2cb4ff18d316ae7d96`, `productionVerified: false`, output kept in temp / outside git.
- **SolidWorks availability gate currently FAILS**: the host installs SolidWorks 2025 product version **33.0.0.5050**, but both COM activation and direct launch crash in the AMD driver `atio6axx.dll` version `31.0.12042.4` with access violation `0xc0000005` (dump evidence under the local CXPD directory, e.g. `C:\Users\Eric Chan\AppData\Local\SolidWorks\CXPD\20260814222204_33.0.0.5050\SLDWORKS.exe.*.dmp`). The live SolidWorks probe truthfully records this as `available: false` with `installedVersion` 33.0.0.5050 and closes its own spawned process (no residual SLDWORKS.exe; the crash is never reported as availability). Approved-drawing modeling (HIL) was **not started**.
- **Phase 5 Exit Gate remains NOT PASS (2026-08-14)**: no HIL; approved-drawing modeling not started; availability gate currently FAILS; no Phase 5 PASS claim — the repository-side implementation is final-verified on the current tree (see above), but nothing is product-verified (`productionVerified` stays `false`/default-only).

## 2026-08-15 Amendment (current state; supersedes the dated operational facts above and Decision item 7's year-specific deliverable wording)

- **Year-specific deliverable wording is superseded**. The required deliverable is an editable, native feature-based part built with the detected supported SolidWorks version; the exact actual version must be recorded and must never be silently relabeled as another version.
- **Three approved-chain attempts were made; none completed**. `.scratch/hil-20260815-142334-52f26231` created a real Runner Run whose nine-item `synthetic:false` preflight and real PDF adaptation passed, then failed `AGENT_PROTOCOL_INCOMPATIBLE` because Codex 0.147.0 rejected the experimental `thread/start.runtimeWorkspaceRoots` field while the client declared `experimentalApi:false`. The adapter now emits only stable thread-open fields (`cwd` + `sandbox:"workspace-write"`), keeps attempt-root containment in `turn/start.sandboxPolicy`, and the live preflight includes a harmless real `thread/start`. `.scratch/hil-20260815-144823-3836c9fc` created a second real Runner Run that reached a real failed Skill/image Turn and ended `AGENT_RUNTIME_UNAVAILABLE`; all nine preflight checks and PDF adaptation passed, but no CAD artifacts were produced. `.scratch/hil-20260815-214252-393c22d8` stopped before `Runner.open` and Run creation when the SolidWorks probe failed closed; this is a preflight/harness stop, not a Run terminal failure.
- **Failed-Turn diagnostics are preserved only through a bounded technical boundary**. Native `turn.error.message` is deterministically sanitized (URLs, absolute paths including paths with spaces, credential/env-secret assignments and JWT-like tokens are redacted; control/whitespace is normalized; output is capped at 512 characters) into the technical `runtime/agent-session.json` note. Product-visible `AGENT_RUNTIME_UNAVAILABLE` remains generic and the failed path writes no raw agent log. HIL harness 1.0.2 may copy only a strict allowlist of status/adapter/protocol plus that bounded note as `14-agent-session-diagnostic.json`; it never copies the complete session, thread/turn/attempt identities, timestamps or raw logs. `skill.resolvedPath` is also required to be absolute.
- **The live SolidWorks COM probe uses Python/pywin32 for attach/poll; PowerShell is discovery-only**. PowerShell `GetActiveObject` produced `TYPE_E_ELEMENTNOTFOUND` on this host while Python/pywin32 could attach to the same instance. Existing instances remain read-only. Owned startup is still a direct Node child with an exact handle/PID; ownership requires exact `GetProcessID()` equality; the helper uses `GetActiveObject` only and never `Dispatch`/`CreateObject`; cleanup never uses process-name enumeration, kill-all, `ExitApp` or `Quit`.
- **Host availability changed during the day and the current crash cause is not conclusively attributed**. The first two HIL probes succeeded (`available:true`, live version `33.0.0`, `owned-process-proven`). During the third attempt the owned process exited before COM registration. `.scratch/hil-20260815-214252-393c22d8/21-solidworks-startup-diagnostic.json` records that default launch, Rx Software OpenGL (`/ForceSoftwareOGL /SWDisableExitApp`) and Rx Tools/Options bypass (`/SWSafeMode /SWDisableExitApp`) all exited in about 3–4 seconds with unsigned status `3221225477` (`0xC0000005`). AMD Radeon driver `31.0.12042.4` is host context and a historical hypothesis, not a proven sole cause; both session-scoped Rx modes failing means neither hardware OpenGL nor ordinary Tools/Options state was isolated as the sole cause. SolidWorks 2025 is installed and COM-registered but is currently not drivable.
- **Owned-process early exit now fails promptly and truthfully**. The probe concurrently observes the exact owned child, aborts and awaits only its own COM helper child, and returns stable reason `owned-process-exited` with a normalized safe exit code plus truthful installed/spawned/closed fields. Narrow live evidence at `.scratch/hil-20260815-214252-393c22d8/22-solidworks-probe-after-early-exit-fix.json` returned in 7044 ms with `available:false`, installed version `33.0.0.5050`, `ownedProcessSpawned:true`, `ownedProcessClosed:true`, exit code `3221225477`, and no residual `SLDWORKS.exe` or Codex process. This narrow probe did not run Codex, PDF adaptation, Drawing import, Run creation or modeling.
- **Verification and gate truth**. Fresh verification on the current working tree passed (2026-08-15): `npm run check` exit 0 — typecheck, repository lint, all tests and full build — root 10 files / 291 tests, `@swpanel/desktop` 31 files / 572 tests, `@swpanel/runner` 38 files / 738 tests, `@swpanel/contracts` 13 files / 148 tests, `@swpanel/domain` 14 files / 70 tests, `@swpanel/ui` 6 files / 43 tests; `npm run check:fixtures` 1/1 — 13/13 canonical scenarios OK, 0 violations, RESULT PASS; `npm run test:e2e` passed sequentially — production Electron 20/20 plus browser + Electron smoke 51/51. This supersedes the earlier 2026-08-15 verification-scope statement in this Amendment (focused-only rerun — probe 41/41, Runner 38 files / 738 tests, Runner typecheck/lint/build — with the full-repository runs still pending); it does not change the HIL facts or the NOT PASS gate conclusion above, and the canonical package/installer was not refreshed. Phase 5 Exit Gate remains **NOT PASS**: there is no successful `.SLDPRT` plus six-artifact publication and `Model(PENDING_REVIEW)`, no real Clarification scenario, and no ownership-safe cancellation HIL. `productionVerified` remains `false`; Phase 6 has not started; nothing was committed or pushed.

## Phase 0 Evidence

Demonstrated:

- Codex CLI noninteractive JSONL events and schema-constrained final output;
- Codex persisted thread resume;
- force interruption of a test Agent turn;
- Codex discovery of `solidworks-build-part-from-drawing`;
- App Server protocol schemas for skill listing, local-image/skill inputs, thread resume and turn interrupt.

Not demonstrated:

- resolved `$solidworks-build-mechanical-models` dependency;
- full CAD execution;
- SolidWorks 2022 availability on the current machine;
- ownership-safe cancellation of SolidWorks;
- feature-level resume;
- PDF/DWG/DXF conversion fidelity.

## 2026-08-16 Amendment (current state; append-only)

- **Agent terminal output is a strict product-owned union**: canonical Agent Turn Output v1 is exactly `completed | clarification_required`; the completed branch reuses Result Manifest v1 and the clarification branch carries only validated structured questions. Codex 0.147.0 rejected the canonical top-level `oneOf`, so the provider receives a flattened closed-object wire schema with all properties required and nullable sentinels; Runner strictly projects that wire document back through the canonical validator. The native schema probe `.scratch/codex-output-schema-probe-20260816054054327-c8cfe1c6.json` proves provider acceptance and projection only. Its synthetic question had no approved drawing or engineering blocker and is **not** real engineering Clarification evidence.
- **Exactly one terminal document is authoritative**: Runner collects Agent message deltas within fixed bounds, performs string-aware balanced-object scanning, and accepts exactly one valid provider-wire document. Zero, malformed or multiple valid documents fail closed with content-free technical categories; Agent text, raw JSON, paths and raw response content are not persisted in those categories.
- **Turn waits are bounded and classification-safe**: client and adapter share `DEFAULT_CODEX_TURN_WAIT_TIMEOUT_MS = 900000` (15 minutes). A true timeout records only whether an Agent message item for the current turn was observed; a foreign-turn item does not count. Child exit and other non-timeout wait failures remain generic. Timed-out waits and synchronous request-write failures do not poison a reusable client, and late responses to those settled requests are ignored through a bounded remembered-id set.
- **Real evidence remains unsuccessful but useful**: `.scratch/hil-20260816-125909-c6eccb74` records the native provider rejection of the original canonical schema. After the bridge, `.scratch/hil-20260816-140950-b6482492` reached the old 600-second turn bound and ended `FAILED / AGENT_TIMEOUT` after real preflight and PDF adaptation, with no ownership registry, `.SLDPRT`, Manifest, Clarification or Model. The next rebuilt attempt `.scratch/hil-20260816-143105-4e1a0596` stopped before `Runner.open` when the exact harness-owned SolidWorks process exited with `3221225477` (`0xC0000005`); it was closed and the isolated temp root was removed. No driver, registry, installation or other system setting was modified.
- **Current verification and gate**: fresh verification on the final working tree passed: `npm run check` exit 0 — root 10/291, desktop 31/576, runner 42/855, contracts 14/162, domain 14/70, UI 6/43, totaling 117 test files / 1,997 tests, with typecheck, lint and full build green; fixtures 1/1 with 13/13 scenarios and zero violations; production Electron 20/20 and browser + Electron smoke 51/51. Phase 5 nevertheless remains **NOT PASS** because there is still no successful real `.SLDPRT` plus six-artifact publication and atomic `Model(PENDING_REVIEW)`, no real engineering Clarification HIL, and no ownership-safe cancellation HIL. `productionVerified` remains `false`; Phase 6 has not started; nothing was committed or pushed.
