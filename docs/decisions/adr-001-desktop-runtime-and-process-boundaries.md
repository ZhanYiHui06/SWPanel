---
title: ADR-001 Desktop Runtime and Process Boundaries
status: accepted
owner: JANGHI
last_updated: 2026-08-10
---

# ADR-001: Electron UI with an Independent Agent Runner

## Context

SWPanel must faithfully engineer the confirmed HTML/CSS prototype, run on Windows, manage long-running Agent work, persist local business data and integrate with an interactive SolidWorks desktop session.

The UI window must not own a Run. Closing or restarting the UI must not be interpreted as user cancellation.

Candidate desktop approaches included Electron, Tauri and a native .NET/WPF shell.

## Decision

Use:

- Electron for the Windows desktop shell;
- React + TypeScript + Vite for Renderer UI;
- a separate per-user Node.js Agent Runner process for Application, Domain, Persistence, Run orchestration and Agent integration;
- Windows Named Pipe for local UI-to-Runner communication;
- no Windows Service for SolidWorks execution.

The Electron Renderer is sandboxed and has no direct Node, filesystem, SQLite, Agent, Secret or SolidWorks access.

## Rationale

Electron provides the most deterministic Chromium rendering for the existing `.design` HTML/CSS and the lowest visual rewrite risk.

Tauri reduces shell size but still requires a separate long-lived Runner and introduces Rust plus WebView2-version variance. WPF has strong Windows integration but would require a high-cost XAML redesign or an additional WebView2 bridge.

A separate Runner is required under every viable shell because Run lifetime, SQLite and Agent/SolidWorks execution cannot depend on a renderer process.

SolidWorks belongs to the logged-in user’s interactive desktop session. Session 0 service execution is not the MVP boundary.

## Consequences

Positive:

- UI can be rebuilt or restarted without losing Run truth;
- prototype fidelity is easier to validate;
- Renderer compromise does not directly grant shell or database access;
- Agent/runtime evolution remains behind a stable Runner contract.

Costs:

- Electron package size and memory overhead;
- two-process development and versioned IPC;
- installer must package and supervise Runner;
- Electron binary download, signing and clean-machine packaging require later validation.

## Rejected Alternatives

### Tauri as the primary shell

Not selected for MVP because the package-size benefit does not remove the independent Runner requirement and would add Rust and WebView2 rendering variability before the core Agent/SolidWorks boundary is proven.

### WPF as the primary UI

Not selected because reproducing the confirmed web prototype in XAML would create unnecessary visual redesign risk.

### Electron Main as the long-running runtime

Rejected because Electron exit would terminate or orphan business work and would mix desktop-shell permissions with Agent/SQLite responsibilities.

### Windows Service Runner

Rejected for MVP because SolidWorks and visible-live workflows require the interactive user session.
