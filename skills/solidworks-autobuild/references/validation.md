# Validation checklist

Complete these checks before reporting success.

## Drawing evidence

- Confirm every numeric model parameter maps to one or more dimension-ledger IDs.
- Confirm every calculated parameter includes a reproducible formula using only annotated source values.
- Confirm no parameter came from pixels, tracing scale, visual proportion, or an undocumented default.
- Confirm every unreadable, missing, ambiguous, or conflicting annotation was resolved by the user or remains explicitly unresolved.

## Geometry

- Compare model front, top, side, and applicable section/detail views with the drawing.
- Verify external contours, internal cavities, hidden features, symmetry, and repeated geometry.
- Check overall envelopes and all principal diameters, lengths, thicknesses, offsets, angles, and locations.
- Check hole types, quantities, depths, terminations, threads, counterbores, countersinks, and bolt circles.
- Check fillets, chamfers, grooves, tapers, patterns, and mirrored features.

## SolidWorks structure

- Open in the detected available SolidWorks installation and force a rebuild with no feature errors.
- Verify the expected solid-body count.
- Verify native editable sketches and features exist; reject a featureless imported/direct body.
- Check sketches are fully defined where the drawing supplies sufficient information.
- Check no suppressed, dangling, or failed feature hides missing geometry.
- Inspect the tree order and names against the feature plan.
- Save the final `.SLDPRT` and verify the file exists and is nonempty.

## Model status

Record rather than silently model unspecified material, heat treatment, surface finish, general tolerance, geometric tolerance, and manufacturing requirements. Do not describe the result as production-authoritative unless those requirements were reviewed and verified.

## Delivery evidence

Provide:

- `.SLDPRT` path and file size;
- actual SolidWorks version of the detected installation (as recorded in the Result Manifest and dimension ledger/build-validation evidence) and document units;
- dimension ledger and feature plan;
- feature count and body count;
- rebuild result;
- final isometric preview plus view-comparison evidence when available;
- unresolved assumptions or exclusions;
- automation source and log when automation was used.

