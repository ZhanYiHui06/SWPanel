# Drawing interpretation

Use this reference before converting drawing marks into three-dimensional geometry.

## Inspect in layers

1. Read the title block, units, scale, projection symbol, general tolerances, material, and notes.
2. Inventory principal, sectional, auxiliary, detail, broken, and partial views.
3. Classify visible outlines, hidden lines, centerlines, section hatching, break lines, and dimension graphics.
4. Match the same edges, axes, bores, shoulders, and repeated features across views.
5. Transcribe annotations into the dimension ledger and visually verify every character.

## Resolve projection

Use the projection symbol when present. Otherwise test the view placement under both first-angle and third-angle conventions. Accept a convention only when the placement and geometry agree consistently. Ask the user if both remain plausible or if view labels conflict with placement.

Never rely only on country, drawing language, or a habitual standard.

## Interpret sections and details

- Follow cutting-plane arrows to establish sight direction.
- Treat hatching as cut material, not surface decoration.
- Distinguish full, half, offset, aligned, revolved, removed, and broken-out sections.
- Carry features through an offset section according to the cutting path rather than assuming a single plane.
- Use detail views for local shape and dimensions; do not scale geometry from the detail circle or its enlargement ratio.
- Recognize conventional omissions and section conventions for ribs, webs, spokes, shafts, fasteners, and thin features, but confirm them against other views and notes.

## Interpret dimensions

Capture the complete semantic callout, not only the number:

- diameter and radius symbols;
- spherical diameter/radius;
- depth and quantity;
- counterbore, countersink, spotface, and hole-series notes;
- metric or inch threads, class, pitch, depth, and handedness;
- limits, fits, unilateral/bilateral tolerances, and geometric tolerances;
- basic, reference, ordinate, baseline, chain, and tabulated dimensions;
- equally spaced, bolt-circle, pattern count, and angular distribution.

Treat OCR as untrusted until visually confirmed. Watch for decimal points, degree symbols, diameter symbols, `R`, `M`, `x`, `±`, superscripts, and characters such as `0/6`, `1/7`, or `5/S`.

## Apply the authority rule

Use explicit annotations as the sole numerical authority. A value may be calculated only when every operand is an authoritative annotated value and the geometric relationship is unambiguous. Record the formula and source IDs.

Never:

- measure pixels to obtain a model dimension;
- infer a hidden depth from apparent proportion;
- assume an unmarked fillet, wall thickness, taper, or symmetry dimension;
- convert a drawing scale into dimensions absent from annotations;
- average contradictory dimensions.

When data is missing, identify the affected feature, required value, drawing region, and downstream dependency in the clarification list.

