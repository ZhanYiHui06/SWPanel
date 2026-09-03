# Feature planning

Plan native SolidWorks features that communicate how the part is designed and manufactured.

## Select the base strategy

- Use a revolve for a primarily axisymmetric turned envelope whose longitudinal section is dimensioned.
- Use an extrusion for a constant prismatic profile whose thickness or length is dimensioned.
- Use a sweep for a dimensioned profile following a dimensioned path.
- Use a loft or boundary feature only when multiple authoritative sections or profiles define the transition.
- Use sheet-metal features only when thickness, bends, reliefs, and manufacturing intent are expressed sufficiently.

Do not encode the whole part in one oversized sketch when separate functional features are evident. Conversely, do not create artificial features merely to increase tree length.

## Choose references

- Place the origin at a functional datum, symmetry center, principal axis, or intersection that is supported by the drawing.
- Align primary planes with principal drawing views when practical.
- Create axes and datum planes for repeated, angled, offset, or symmetric features.
- Reference stable datum geometry rather than edges created by late features.

## Order features

Use this default topology-stable sequence:

1. base material feature;
2. major bosses, flanges, ribs, webs, and steps;
3. principal bores and pockets;
4. holes, slots, grooves, and local cuts;
5. mirrors and patterns;
6. fillets and chamfers;
7. cosmetic threads and appearance-only details.

Move a feature earlier only when design intent or reference stability requires it.

## Map annotations to features

For every planned feature, list the driving dimension IDs. Examples:

- shaft diameters and axial lengths drive a revolved profile;
- hole diameter, depth, termination, and position drive Hole Wizard or a cut;
- quantity, pitch-circle diameter, and angular spacing drive a circular pattern;
- repeated pitch, count, and direction drive a linear pattern;
- `R` and chamfer callouts drive separate finishing features.

Use Hole Wizard when its type accurately represents the callout. Use a modeled thread only when the user or downstream need requires physical helical geometry; otherwise preserve the specified cosmetic-thread metadata.

## Constrain sketches

Add geometric relations supported unambiguously by the drawing: horizontal, vertical, parallel, perpendicular, tangent, concentric, coincident, equal, symmetric, and midpoint. Add numerical constraints only from the ledger.

Prefer fully defined sketches. If full definition requires a missing numerical value or an uncertain relation, stop and ask instead of fixing geometry arbitrarily.

## Name the tree

Use short functional names such as `Base_Revolve`, `Mounting_Flange`, `Central_Bore`, `Bolt_Hole_Seed`, `Bolt_Circle_Pattern`, and `Edge_Chamfers`. Preserve a clear link between feature names and the feature plan.

