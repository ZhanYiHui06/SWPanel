---
title: ADR-002 Local Persistence, Files and Secrets
status: accepted
owner: JANGHI
last_updated: 2026-08-10
---

# ADR-002: SQLite Metadata, NTFS Artifacts and Windows Credential Manager

## Context

SWPanel stores long-lived business relationships, Run events and cost snapshots, while original drawings, `.SLDPRT` models, previews and technical Artifacts may be large or locked by SolidWorks.

The public source repository must not receive Runtime Data, real customer files, enterprise cost data or API keys.

## Decision

- Store structured business data in SQLite using WAL mode.
- Give the per-user Agent Runner exclusive write ownership of the database.
- Store original Drawings and generated Artifacts on NTFS, outside the application installation and source repository.
- Store only metadata, stable relative paths, sizes and SHA-256 hashes in SQLite.
- Preserve original Drawing bytes and use immutable per-Run output directories.
- Store API Secrets in Windows Credential Manager; SQLite stores only credential references and masked metadata.

Default root:

```text
%LOCALAPPDATA%\JANGHI\SWPanel\
```

## Rationale

SQLite provides transactional local persistence without a server process and is suitable for a single-machine MVP. Large binaries do not belong in database blobs because they increase backup, locking and migration cost.

Per-Run immutable directories preserve traceability and avoid conflicts with SolidWorks file locks. Windows Credential Manager binds Secret protection to the current Windows user and avoids plaintext configuration files.

## Consequences

- DB migrations, backup and integrity checks are required.
- Moving a data root must be a controlled application use case, not a raw setting edit.
- Missing files and orphan Artifact reconciliation require explicit maintenance flows.
- Cancellation cleanup must use a Run-owned allowlist and canonical path containment.
- A network share must not host the active SQLite DB; exports/backups may target approved external storage.

## Verification Notes

Phase 0 validated:

- Node SQLite WAL and strict schema support;
- atomic conditional queue claim;
- guarded path containment and deletion;
- Unicode Windows paths;
- SHA-256 Artifact recording;
- Windows Credential Manager and a native keyring binding round trip.
