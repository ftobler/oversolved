# Part Document - Schema

## What the document is

A part document is an ordered list of feature records. Each record is one layer
of a build: the state after feature N is the accumulation of features `[0..N]`.
The rollback position is an index into that list, and an incremental rebuild
reuses the unchanged prefix (`findFirstDirty`, `kernel/builder.ts`).

The records are flat: no nesting, no control flow, no user functions. Repetition
is the `pattern` feature kind, which repeats either a body or an earlier
feature. Dependencies between features are
references (query strings, see Query Syntax) plus the list order; numeric params
may be expression strings evaluated against earlier `variable` features
(`kernel/evalExpr.ts`). Some kinds are shorthand that is lowered before the
solver runs (`center_rect`, the `ngon` constraint`).

A stored number carries the document's precision. Every scalar feature number a
part document's mutation writes (a distance, a radius, an array pitch, a plane
offset, a transform translation component), every sketch seed and every
dimension constraint value crosses the same 1e-6 rounding boundary on the way
in, so an authored `0.351324026` is stored as `0.351324`, and a magnitude below
half of that is stored as zero, the nearest spelling the format can hold. Where
a field's loader rule refuses what the write lands on (a shell thickness or a
helix angle after the round, an array count on the authored value, which the
round would otherwise heal a non-integer into a legal one), the write refuses it
instead of saving a document that cannot reopen. Three spellings stay outside
the boundary: an expression string is stored as written and evaluated by the
solver, a cosmetic thread's `nominal` and `pitch` are thread-table lookups the
loader checks against that table, and an assembly document's mate params and
part poses are written by
`utils/assemblyMutations.ts`, not by the part-document writers.

The same document is the target for every author: the GUI, the drive surface
(the dev bridge and the headless operations in `frontend/src/drive`; the CLI
and MCP entry points in `frontend/scripts`), and the import/export paths. The
JSON Schema in `persistence/partDocSchema.ts` is the contract.

A stored number is a number **in the document's length unit**. `length_unit` is
`mm` or `inch`; absent means `mm`, which is the canonical spelling and keeps
every document written before the field byte-identical. The unit never rewrites
a value: changing it *reinterprets* the numbers (the same `0.5` becomes half an
inch instead of half a millimetre, and the part is 25.4x bigger physically), and
one `set_length_unit` mutation does that as one undo entry. Two controls dispatch
it. The view options menu's unit row switches immediately and is undoable, and it
also works while a feature or sketch edit is open: the session owns the undo
boundary, so the write is not deferred and undo can take it back. The export
dialog's unit row applies with the download, so a cancel or a failed export
leaves the document alone (and the dialog refuses to open during an edit). The
menu row is part-editor only, because an assembly document has no unit of its
own. The scale lives at the file boundary: STEP and STL
are written in millimetres, so an inch document's shape is scaled by 25.4 on
export (`kernel/solveLocally.ts` `serialiseShape`) and the file carries the
millimetres every consumer expects. Measure readouts and the feature editor's
length labels follow the unit; the numbers they show are the stored ones. An
imported STEP is read at its own mm size, so importing into an inch document
stores `import_step.scale: 1 / 25.4` on the feature (the import button does it;
a script authors the same field), because the leaf solver never sees the
document unit. Assembly documents keep the millimetre frame, so an inch part
placed in an assembly is placed by its authored numbers in that frame, and an
assembly export does not scale it. The cosmetic thread table stays metric
(`nominal` and `pitch` are mm lookups) whatever the document unit says; the
viewport converts the pitch to the document unit when it shades the bore.

The assembly document (parts, instances, mates) is a separate format. Its
contract is the JSON Schema in `persistence/assemblyDocSchema.ts`, served over
MCP as `oversolved://schema/assembly-document`: a `part_instance` names a
workspace `doc_id`, and a `mate` carries two `{ part, anchor,
anchor_descriptor }` refs plus the parameters its kind reads. `limit_min` and
`limit_max` are one-sided joint ranges: degrees about the canonical roll zero on
`rotating` (signed, inside (-180, 180]), millimetres of axial separation on
`sliding`. Inside the range the bound adds no constraint; a missing key is an
open end.

That `doc_id` need not come from a document the user authored first. The
assembly header's Import STEP writes the STEP file entry and the part document
that imports it as one workspace save, then places the instance through the
ordinary add_part path; undo covers the instance and leaves the part in the
workspace. The file entry is found by its content hash, so importing the same
bytes again reuses it, and the part document is reused when the requested name
matches; a taken name gets the usual `_1` collision suffix. The headless
`add_step_part` step is the same synthesis without a workspace, binding the part
under the derived id `step_<file id>`.

## Document Structure

```yaml
version: 7
kind: part

features:
  - id: sk1
    kind: sketch
```

Top-level fields: `version` (int, the migration-ladder stamp; the ladder target
is `CURRENT_DOC_VERSION = 7` in `persistence/docSchema.ts`, and a missing or
older stamp runs the steps that bring it up), `kind` (string, `"part"`),
`rollback` (int, an index into `features`; absent means the end of the stack,
and a rolled-back document reopens where the user left it), `length_unit`
(`"mm"` or `"inch"`; absent means `mm`), `features` (list),
`part_style` (map from body id to display style, reconciled by the solve),
`oversolved` (int, a stamp the loader checks is an integer and nothing else
reads).

A feature keeps its base fields (`id`, `kind`, `label`, `visible`, `suppressed`)
flat and every other param under the field named after its kind
(`extrude: {...}`; `definition:` for a plane), except `sketch`, whose `plane`,
`entities`, `constraints`, `initial` and `auto_hidden` sit flat on the feature,
and `import_step`, whose `file_id` and `scale` do. `origin` carries no params.
A reference from one feature to another feature is absolute, `@<featureId>`; `$`
is host-local to a sketch's own entities. `persistence/docSchema.ts` folds the
legacy flat params and the `$id` feature refs onto these canonical forms on
load; `persistence/partDocSchema.ts` is the hand-written JSON Schema contract
(kept in step with `types/cad.ts` by the compile-time kind tether and the corpus
test), served as the MCP resource `oversolved://schema/part-document`.

## Feature Kinds

### origin

The document origin. Every fresh document starts with four built-in features:
`Origin` (kind `origin`) and the three cardinal planes `Top`, `Front`, `Right`
(kind `plane`, with no `definition`; their frames are the `builtin_plane_*`
entries of `kernel/solverConstants.ts`).

```yaml
- id: Origin
  kind: origin
```

The built-ins cannot be deleted, reordered or suppressed
(`applyDeleteFeature`, `applyReorderFeatures`, `applySetFeatureSuppression` in
`utils/yamlMutations/featureAdmin.ts`). The rollback bar cannot be dragged above
them (`FeatureTree.tsx` clamps the drop targets to the built-in count), but the
stored `rollback` field is not clamped to them: a hand-authored `rollback: 0`
passes the loader and the bar is drawn at that index.

### sketch

```yaml
- id: sk1
  kind: sketch
  plane: "@builtin_plane_front"   # query; defaults to front plane
  label: "Sketch 1"
  visible: true                   # absent means visible
  initial:                         # warm-start guesses [flat param arrays]
    line_base:   [0.0, 0.0, 17.32, 0.0]
  entities:
    - id: line_base
      kind: line
  constraints:
    - id: c1
      kind: horizontal
      target: "$line_base"
```

`suppressed: true` skips the feature in the solve. `auto_hidden` is sketch-only:
set once the user has shown a consumed sketch, so the one-shot consume auto-hide
will not hide it again. `drag_anchor` is a transient solve-only hint (the entity
just dragged) that is never stored in the document.

| kind | params | meaning |
|------|--------|---------|
| `point` | `[x, y]` | position |
| `line` | `[x1, y1, x2, y2]` | start, end |
| `circle` | `[cx, cy, r]` | center, radius |
| `arc` | `[cx, cy, r, a0, a1]` | center, radius, start angle (deg), end angle (deg) |
| `ellipse` | `[cx, cy, a, b, theta]` | center, semi-major (a>=b>=0), semi-minor, major-axis rotation (deg) |
| `spline` | `[x1, y1, x2, y2, x3, y3, x4, y4]` | cubic Bezier: P1/P4 on-curve endpoints, P2/P3 control points |
| `fit_spline` | `[x0, y0, ..., xN-1, yN-1]` + optional `[c1x, c1y]` / `[c2x, c2y]` | interpolating spline through N fit points (2..64); `handles` is `start`, `end` or `both` and says which end handles follow |
| `center_rect` | compound (expanded to 4 lines) | xy, size |

A `fit_spline` is the interpolating spline (CadQuery `spline(points, tangents)`): the document stores the fit points and, when the user authored end tangents, the two absolute handle points. The `handles` field is `start`, `end` or `both` and says which handle pair follows the points; absent means no handles. The curve is derived (clamped C2 cubic, chord parameters); the handles are the first piece's second control point and the last piece's third. Vertex keys are `start`, `fit1`..`fitN-2` (interior points), `end`, and `c1`/`c2` for the handles; `fit<k>` is positional, so inserting or deleting a point renumbers every later ref in the same mutation. The Bezier `spline` above is unchanged.

Projection is held by a `projection` constraint: a base-kind entity (`line`/`circle`/`arc`/`point`/...) paired with `{kind: projection, target: $<entityId>, source: <query>}` is projected from a 3D source and pinned to its projected shape and position. A body circle, arc, ellipse or sampled spline edge, or another sketch's circle or arc (a foreign spline or ellipse is refused), is lowered to the 2D entity that can follow it: a tilted conic to an ellipse, a sampled curve to a cubic `spline`, or to a `fit_spline` when one cubic cannot follow it, and one seen edge-on to its silhouette line; a projection declared `point` on such a curved source is that curve's centre in any orientation. The kind is re-resolved on every solve, so a source that rotates into or out of edge-on changes kind without a document migration, and the write-back installs the resolved kind on the entity row without an undo entry. Deleting the constraint leaves the entity free at its last projected params. Legacy v5 documents that carried `source` on the entity are migrated to this form. Any entity can set `construction: true`.

A body FACE source is the live form: `{kind: projection, source: "?...:flatface"}` has no `target`, and the solve derives its boundary edges as member entities on every solve, so a later fillet, cut or width edit adds, removes or moves members without a re-pick. A supplied `kind` is ignored for a face source: the whole wire is derived, not one curve or its centre. Seam edges are skipped. A targetless projection may load without a `members` map; the next solve derives it, and an unresolved face is reported in `projection_errors` rather than refused. Members are not stored as entity rows or `initial` blocks; the constraint keeps only `members` (construction token `u|<uuid>` to derived member id) and optional `excluded` (tokens the user removed). The solve write-back reconciles `members` as the boundary changes; a member id is derived from the constraint id and the token, so it survives replay, undo and redo and consumes no mint index. It stays stable unless two tokens collide in the first eight hex characters (the whole colliding group lengthens deterministically), and a duplicated token falls back to a position-indexed id. An edge that leaves the face is kept in `members` as an orphan (so a restored edge recovers its id) but yields no geometry, and a user constraint naming it is reported in `dropped_constraints`. Deleting one member adds its token to `excluded`; deleting the constraint (with the solved member rows in the delete payload) freezes them into ordinary entities under the same ids, and a later upstream edit no longer moves them. A derived member has no entity row, so it cannot join a `group` until the projection is frozen.

Mirroring a selection (`mirror_entities`) writes plain authored entities: the copies are ordinary rows with their own ids, and there is no stored mirror relation, so moving the originals later does not move them. A constraint is carried over only when every one of its operands is a mirrored source or the axis line; a constraint that reaches anything else stays with the originals alone. A source whose mirror is itself (a seam edge on the axis, a line across it) gets no copy; it serves both halves, and its constraints to the other sources carry onto the copies. In the sketch editor the selection holds the sources and the axis: a lone selected line is the axis, and when the sources include lines the axis is the one selected construction line.

Rounding sketch corners (`fillet_corners`) is also authored geometry, not a live relation: each named line endpoint is trimmed to its tangent point and joined to its partner by one arc, with coincident and tangent constraints tying the arc to the two sides. The radius must be strictly less than both side lengths (and two corners on one line must leave a segment), the material side is probed from the sketch's own profile unless the corner passes `side: convex | concave`, and a corner that already meets an arc, a projected side, a mixed construction corner, or a `fixed`/dimension anchoring a trimmed endpoint is refused by name. One step is one undo entry, and a step with any bad corner writes nothing.

Patterning sketch entities (`pattern_entities`) writes plain authored copies too: there is no stored pattern relation, so editing a source later does not move the copies. `linear` repeats along a direction, `grid` over two directions, `rotate` about a centre, and `copy` makes one rotated-then-translated copy, optionally into another sketch on the same plane. `count` includes the source, a step makes at most 200 instances and the sketch at most 4096 entities, and a copy that lands on the source or an earlier copy is refused. A constraint follows each copy only when all its operands are sources; one that ties a source to anything else stays on the source alone. horizontal/vertical, `point_distance_x/y`, a midpoint axis and a one-coordinate `fixed` swap at a quarter turn and are dropped at other angles. The copies are new rows appended instance by instance in `sourceIds` order, and one step is one undo entry.

Lettering (`add_text`) is authored geometry as well: there is no text entity kind. The string is expanded once, from a checked-in Roboto 400 outline table (`frontend/src/assets/fonts/roboto-400-glyphs.json`, generated by `frontend/scripts/generateSketchGlyphs.mjs`), into closed contours of `line` and cubic `spline` rows with fresh ids and no constraints, all in one undo entry. `origin` is the baseline start, `size` the em size in document units, `angle` turns the baseline counter-clockwise and `align` puts the left end, the middle or the right end of the run's advance on `origin`. Shared endpoints are the identical stored pair, so each glyph contour closes by coordinates, and an extrude fills the glyphs even-odd, so counters stay open. Only printable ASCII is drawn; any other character is refused by code point, never dropped, as is a run over 2000 entities. Kerning, multi-line layout and text on a curved face are not supported; editing the string means deleting the outlines and adding new text.

#### DXF import

`import_dxf` turns the entities of an ASCII DXF file into authored entities of
an existing sketch, as one undo entry. The file is parsed in TypeScript
(`utils/dxfImport.ts`) and the writer appends ordinary entity rows with fresh
ids, so every imported entity is editable by the existing tools. The supported
set is LINE, ARC, CIRCLE, LWPOLYLINE and a 2D POLYLINE (a bulge becomes an
arc), a single clamped cubic Bezier SPLINE (four control points, weights all
1), a full ELLIPSE and POINT. TEXT, MTEXT, DIMENSION, LEADER and the other
annotation entities are skipped and counted, and so is paper space; any other
curve entity (INSERT, HATCH, a multi-span or rational SPLINE, a 3D POLYLINE)
refuses the whole file by name (unless the `layers` filter leaves that
entity's layer out), so a profile is never half imported.

The sketch entity has no layer field, so layer names are not stored (the parser
reports their counts). An optional `layers` list on the mutation imports only
the layers it names, matched case-insensitively after trimming; the filter runs
before the entity rules, so a HATCH, a block INSERT or an annotation on an
unpicked layer neither refuses the file nor counts as skipped, and an unknown
name refuses with the file's own layer list and entity counts. Without the list
every layer imports. Repeated entities are kept as authored; the import does
not de-duplicate them, and a polyline width is ignored (the centreline
imports). `$INSUNITS` is converted to the document's unit (0 unitless means the
numbers are already document units; 1 inch, 2 foot, 4 mm, 5 cm and 6 m
convert), and an unsupported code refuses by name. DXF is a planar format: the
import reads X and Y only, matching CadQuery's DXF import onto a workplane, and
the drawing's local coordinates are the sketch's own.

Unless the mutation passes `group: false`, every imported row is also held by
one `group` constraint (anchor: the first imported entity) in the same mutation,
so the profile arrives with exactly its two translations of freedom; pin one
vertex (for example a `coincident` to `@builtin_origin`) to fully constrain it,
and delete the single constraint to edit the rows freely. A filtered import
groups only the rows it picked, so two imports of two layers make two groups.
`group: false` imports plain rows for a client that constrains them itself.

### plane

```yaml
- id: pl1
  kind: plane
  definition:
    mode: offset                 # offset | three_point | plane_point | line_angle | on_face | on_face_edge_angle | edge_point | origin_rotation
    plane: "@builtin_plane_front"
    offset: 10.0
    rotation: 0.0
```

`origin_rotation` places the plane at its own origin and swings the parent axes:

```yaml
- id: pl2
  kind: plane
  definition:
    mode: origin_rotation        # origin plus a rotation about an axis
    origin: "@sk1/p1"            # a point ref (or [x, y, z] world coordinates)
    rotation_axis: z             # x | y | z (or [x, y, z] direction)
    rotation_angle: 45.0         # degrees; rotation_axis and rotation_angle are required together
```

### extrude

```yaml
- id: ex1
  kind: extrude
  extrude:
    sketch: "@sk1"              # or list of refs
    distance: 10.0              # required; the legacy `depth` spelling is read as an alias
    taper: 0                    # degrees, + narrows / - widens; absent or 0 is a straight prism
    direction: normal           # normal | reverse | symmetric
    operation: new              # new | add | cut
    termination: blind          # blind | up_to | up_to_next | through_all
    up_to: "@body_ex1/face/0"   # up_to only: a plane, any face, a vertex query, or a sketch point ref
    up_to_offset: 0             # up_to/up_to_next: material-signed stop offset (expression allowed)
    up_to_start: sketch         # sketch | surface; surface is the emboss/deboss slab
    merge_target: "@body_ex1"   # optional: the body the result fuses into
```

One sketch is one profile, and a profile fills even/odd: a loop nested inside
another becomes a hole (a disc plus a circle is a washer), while loops that cross
each other are filled as their union. A circle meant as a hole that pokes past
the rim of another loop therefore adds a bump where it crosses instead of cutting
a notch, and nothing warns about it; keep a cut loop inside its boundary, or cut
with a separate sketch. The same rule reads a `revolve` or `sweep` profile.

`operation: new` starts a body from the profile. `operation: add` extends an
existing body: with no `merge_target` every body is a candidate and it fuses
the first one the profile reaches, warning about any other body it also
reaches. A profile that reaches no body at all fails the feature (`add does not
merge with any existing body`), so the first extrusion of a part uses `new`.
`cut` removes material from the body it reaches. With no `merge_target` it
reaches every body, and one it consumes entirely is removed from the part. That
deletion is silent when other bodies remain; the warning names the consumed
body only when `merge_target` aimed at it, or when the cut leaves no body at
all.

A part saved before this rule whose first extrusion is `add` (or omits
`operation`, which reads as `add`) rebuilds red until that feature is switched
to `new` or its profile is moved onto an existing body. There is no automatic
migration: deciding which extrusion was meant to start the part needs the
document's intent, not a field value.

`up_to` trims the extrude at the picked element instead of at `distance`. A
query target that does not resolve, or meets several elements, falls back to the
blind distance with a solver warning; an up_to with no `up_to` target does so
too. A `@<bodyId>/face/<n>` ref that no longer names a face (the body is gone,
the index is out of range, or the remap fails) fails the feature instead, since
that spelling is a persisted pick rather than a query. A face target may be
planar or curved: a curved face is split at the first crossing, so a tool that
enters and leaves a cylinder stops at the near wall. The face must cover the
whole profile; a face smaller than the footprint, or shorter than the swept
profile, first retries on its untrimmed surface extended over the tool (with
`up_to: the face did not cover the profile; trimmed at its extended surface` in
the feature note), and is refused if that cannot cut the profile through.
`direction: symmetric` is refused.

`up_to_next` stops each profile region at the first body it meets, so one
footprint can end on a dished ceiling made of several faces without picking
one. `merge_target` narrows the candidates to one body, and with no target every
body is a candidate. The authored direction decides the sweep (there is no
auto-flip), and `up_to` is ignored. A profile that starts inside material, or a
region that meets no body, is refused by name instead of built to a 10 m reach.

`up_to_offset` (a number or expression, default 0) moves the stop surface of
`up_to` or `up_to_next` by a material-signed distance: positive is outward of
the target body's material, negative is into it. It is a true surface offset
along the target's normal, not a translation along the extrude, so an emboss
raised 0.5 on a cylinder stays 0.5 thick everywhere. A target with no material
(a datum plane or a sketch point) has no outward side: positive is past it along
the extrude direction, negative short of it. The sign does not depend on which
side the sketch is on.

`up_to_start: surface` builds only the slab between the stop surface and its
offset, clipped to the profile footprint swept along the extrude: the
emboss/deboss mode, and the sketch may sit in front of the surface, behind it,
or anywhere along the direction. It needs a face target (an `up_to` face or
`up_to_next`) and a non-zero `up_to_offset`, and is refused with `direction:
symmetric` or a taper. The two useful pairings are `operation: add` with a
positive offset (raised) and `operation: cut` with a negative offset (sunk);
the other pairings are legal and change nothing, with the usual no-change
warning. Recipes: emboss by h is a sketch on a plane in front of the curved
surface, `add`, `termination: up_to` the face, `up_to_start: surface`,
`up_to_offset: h`; deboss by h is the same with `cut` and a negative offset.
Without `up_to_start: surface`, a sketch behind the surface (inside the body)
with `add`, `up_to` and a positive offset gives the same emboss, and a sketch in
front with `cut` and a negative offset the same deboss.

`through_all` is a cut that is sized from the live bodies instead of from
`distance`, which it ignores: a part that later grows is still cut through. With
no `merge_target` every body is a candidate, and `merge_target` narrows both the
measurement and the cut to one body. It needs a body to cut through, and
`operation` must be `cut`; add, new and intersect are refused. `normal` and
`reverse` sweep the measured length from the profile plane, and `symmetric`
straddles the plane. A document that stores `through_all` needs a build that
knows it (the format moves forward only).

`taper` is the draft angle in degrees along the sweep: positive narrows the
profile as it travels, negative widens it, and every lateral wall drafts with it,
holes included and material-consistent (a washer with a positive taper leans the
outer wall in and the hole wall out, so the wall thins toward the top). It is a
number or an expression string, like `distance`. A taper needs
`termination: blind` and `direction: normal` or `reverse`; symmetric, up_to,
up_to_next and through_all are refused by name. A taper that closes the profile
exactly at `distance` builds to an apex: a pyramid from a polygon, a cone from a
circle. One that closes to a ridge (a non-square rectangle closing to a segment
rather than a point) is refused, as is one that collapses the profile before
`distance`, which names the height it would collapse at, as in
`extrude: taper 45 collapses the profile after 5.000 of 10; shorten the distance
or reduce the taper`. Absent or 0 is the straight prism the feature has always
built. In the editor, switching `direction` to symmetric or `termination` away
from blind clears an authored `taper` in the same edit, so the now-hidden field
cannot strand the feature; a hand-authored document that keeps both is refused
by the kernel.

### revolve

```yaml
- id: rev1
  kind: revolve
  revolve:
    sketch: "@sk1"
    angle: 360.0
    axis: "@sk1/axisLine"       # required pick: line edge, sketch line, or circular edge
    operation: new
    merge_target: "@body_ex1"   # optional
```

The axis may touch the profile boundary but must not cut through its interior.
Interior means one area's: a line drawn along the axis splits a closed curve into
two areas that each touch it, so a full circle or ellipse plus its diameter line
revolves into a sphere or spheroid.

### sweep

```yaml
- id: sw1
  kind: sweep
  sweep:
    sketch: "@sk1"              # profile ref (or list)
    path: "@sk2/spine"          # path ref (or list)
    transition: mitre           # mitre | round, how a sharp path corner is turned
    multisection: false         # sections along the path; see below
    operation: add              # new | add | cut
    merge_target: "@body_ex1"   # optional
```

`multisection: true` treats every outer profile loop as one section and sweeps
one body through all of them. The path must pierce each section's plane inside
that section's loop, and that piercing point is the section's station: a section
is placed where it is drawn, the sections are ordered by their station rather
than by the order of the `sketch` list, and no parameter is stored. Between
neighbouring stations the shape is interpolated: two sections are linear (a
circle pair gives the cone frustum `pi*h/3*(r1^2+r1*r2+r2^2)`, a square pair the
pyramid frustum), and more sections are skinned smoothly through all of them.
A section with a hole, two sections at one station, a helix path with sections,
and two neighbouring sections whose edge counts OCC cannot pair (a circle
against a rectangle is fine, because the circle can be split to any count; a
rounded rectangle against a sharp rectangle is refused) are refused by name.
This is not a loft: the surface between sections is defined by the path (a loft
has no defined surface between sections), a section the path does not pierce is
refused, and without the path nothing is built.

Without `multisection`, a profile with a hole (an annulus, a washer outline)
builds a tube: each hole is swept as an inner shell along the same path and cut
through the whole sweep, and the bore wall is named by the sketch entity of the
inner loop. A hole the path's bend cannot carry fails the feature by name
instead of building the profile as a solid. The multisection hole refusal and
its two-sweep workaround do not apply to this form; they are for a section with
a hole.

### fillet / chamfer

```yaml
- id: fil1
  kind: fillet
  fillet:
    edges: ["?query:edge"]
    radius: 1.0
```

```yaml
- id: ch1
  kind: chamfer
  chamfer:
    edges: ["?query:edge"]
    distance: 1.0
    kind: distance              # distance | angle_distance
    angle: 45.0                 # angle_distance only, deg
```

A pick blends its whole tangent chain. OCC's fillet and chamfer continue
across a joint where two edges meet tangentially (G1), the default of every CAD
tool, so one edge of a rounded top loop rounds the loop: on a 3 x 3 x 0.5 plate
with R0.125 vertical fillets, one top edge at R0.1 removed 0.0249905 of
material, the whole 8-edge loop's cut, against 0.0059015 for that edge alone.
Both features accept the pick and report what they took: an `ok` (or `partial`)
result carrying a `solver_note` with the chain size and how many of those
edges nobody picked. The note is informational, not a warning: it does not
change a run's `ok`, does not make an export `ok: false`, and does not keep the
feature out of the reply's `featureDeltas`. A pick the kernel itself refused is
named in the refusal
and left out of that count. A chain the picks already cover reports nothing,
and a sharp corner is not a joint.

### shell

```yaml
- id: sh1
  kind: shell
  shell:
    faces: ["?query:flatface"]   # removed faces (openings); may be empty
    thickness: 1.0               # expression-capable, > 0
    direction: inward            # inward | outward (inward keeps the outer skin)
    join: sharp                  # sharp | arc; absent means sharp
    source_body: "@body_ex1"     # required when faces is empty
```

An empty `faces` list makes a closed hollow (one solid with an inner void), so
`source_body` is required: no face names the body. Faces naming several bodies
is an error.

`thickness` is a magnitude and `direction` carries the side: `inward` keeps the
outer skin where it is and hollows from inside, `outward` grows the part.
`join` chooses the corner treatment. `sharp` (the default, stored as an absent
key) is OCC's intersection join: the offset walls of two kept faces meet at a
sharp edge, so a shell keeps the part's authored corners. `arc` rounds the
opened gap with a quarter cylinder of radius equal to the thickness (and a
sphere patch at a corner): outward that rounds the outer corners, inward it
rounds a concave inner corner such as an L brace. A sharp build the kernel
refuses (a removed face whose boundary is filleted, or a tangent contact
between faces) still retries arc and reports the substitution as a
`solver_warning`: the body is valid and an export is unaffected, but the
corners are not the authored ones, so the feature tree marks the row and the
drive lists it under `features`. An explicit `arc` never falls back, so a
refusal is a feature error naming the cause (a round that cannot cross a
concave edge, or one past a wall's radius). CadQuery's `shell()` takes a
signed thickness and defaults to `kind="arc"`, which maps to `join: arc`; `kind="intersection"` maps
to the default. The sign maps as positive -> `outward` and negative -> `inward`,
with the magnitude as `thickness`.

### move_face

```yaml
- id: mf1
  kind: move_face
  move_face:
    faces: ["?query;...:cylinderface"]  # analytic faces, applied in list order
    distance: 5                     # signed along each face's outward normal,
                                    # expression-capable; 0 is the identity
```

Each face moves along its own outward normal and the faces that bound it are
extended (or trimmed) along their own surfaces, so a cone base pushed down grows
the cone itself. On a curved face "along its own normal" is a uniform offset of
the surface: a cylinder's radius changes by the distance, a cone becomes the
parallel cone (same axis and half-angle, the apex shifted along the axis), a
sphere's radius and a torus's minor radius change. Positive adds material (a
boss wall grows, a bore wall moves toward its axis), negative removes it. A move
that removes the whole body is an error. A freeform (B-spline or Bezier) face is
refused by name; a face with a tangent neighbour (a fillet) is refused.

### delete_face

```yaml
- id: df1
  kind: delete_face
  delete_face:
    faces:                       # faces to remove; healed by extending neighbours
      - "?query:cylinderface"
      - "?query:flatface"
```

No parameters: the picked `faces` are the whole spec. A connected group of picks
(faces sharing an edge, e.g. a hole's walls and its floor) is removed or refused
as a unit, so a partial pick heals what it can (a blind hole's floor alone
becomes a through hole). A refusal on every group fails the feature and leaves
the body untouched; the other groups still apply (status `partial`).

### boolean

```yaml
- id: bool1
  kind: boolean
  boolean:
    operation: union             # union | subtract | intersect
    target: "@extrude1"
    tools: ["@extrude2"]
    keep_tools: false
    clearance: 0.1               # subtract only; signed length in the document unit, grows (+) or shrinks (-) every tool on all sides
```

A `tools` entry naming a body-subject `pattern` feature (`"@pt1"`)
stands for that pattern's source body, every instance body, and every body an
`operation: add` pattern split off as a disjoint copy, resolved at solve time,
so a later count change is followed. The target is left out of the expansion. A
list of body ids that names only some of one pattern's bodies solves with a
warning naming both counts. A feature-subject pattern reshapes one existing
body and is not expanded.

### hole

```yaml
- id: h1
  kind: hole
  hole:
    sketch: "@pts"
    diameter: 10.0
    depth: 20.0
    depth_mode: blind            # blind | through_all
    direction: normal
    target: "@body_ex1"          # optional: the body to drill into
    style: counterbore           # optional: simple (default) | counterbore | countersink
    cb_diameter: 16.0            # the widened mouth diameter (counterbore/countersink)
    cb_depth: 3.0                # the counterbore step depth
    cs_angle: 90.0               # the countersink's included angle, degrees (default 90)
    tip: drill_point             # optional, blind only: flat (default) | drill_point
    tip_angle: 118.0             # the drill point's included angle, degrees (default 118)
    thread:                      # optional, cosmetic only (no geometry change)
      designation: M6x1          # a thread-table entry
      nominal: 6.0               # the thread's major diameter, mm (the table is metric whatever the document unit)
      pitch: 1.0                 # mm per turn
    thread_depth: 15.0           # optional: how deep the thread is tapped (absent: the whole bore)
```

The `sketch` pick drills every non-construction point in the sketch, each at
the feature `diameter`. A circle is a profile, not a drill site: a whole-sketch
pick ignores it, and a pick that names one alone is refused with the
extrude-cut remedy. To cut a drawn circle, use an extrude with `operation: cut`
(`termination: through_all` for a through bore). A circles-only or
construction-points-only sketch that holds a circle, with no drillable point,
is refused with the extrude-cut alternative. Construction
geometry is reference only and is skipped by a whole-sketch pick: an n-gon's
circumcircle, or a point an author flags construction. Line endpoints
are not drill sites, while `add_center_rect`'s helper centre point is an
ordinary point entity and does drill. A pick that names one point
(`entity:<sk>:<eid>`, `vertex:<sk>:<eid>:<sub>`, or a single-entity area query)
drills only that one; a line, arc or spline names no drill site and is refused
by name, and so is a construction point named on its own.

`style` widens the mouth in the same one cut. A `counterbore` reads
`cb_diameter` (wider than the bore) and `cb_depth` (the flat-bottomed step, less
than `depth` in a blind hole); a `countersink` reads `cb_diameter` and
`cs_angle`, and derives the cone depth from those radii. The widened mouth is
one field, `cb_diameter`, under both styles: there is no `cs_diameter`. Both
default the widened mouth to the drill site's plane, so the bore's through
portion is the small diameter.

`tip` shapes a blind hole's bottom. `flat` (the default) ends the bore in a
flat floor; `drill_point` ends it in the cone a twist drill leaves, with
included angle `tip_angle` (default 118, the general-purpose drill point).
`depth` stays the full-diameter depth to the shoulder, and the point reaches
`r / tan(tip_angle / 2)` past it, so the same depth keeps the same usable bore
(and the same cosmetic thread length) under either tip. A `through_all` hole
has no bottom and ignores both fields.

A cosmetic thread adds no geometry: the bore keeps its drilled size (the
authored `diameter`) and the solve
reports the thread's metadata plus one tapped run per drilled bore, which the
viewport shades as helical ridges on the bore wall below the widened mouth. The
pair is checked against the thread table at load time when the table carries
the designation.

`thread_depth` is how deep the thread is tapped when that is less than the
drilled bore (drill 20, tap 15). It is measured from the same origin as
`depth` (the sketch plane for a blind hole, the entry face for a through hole),
so the two read as one callout. Absent means the whole bore. A value past the
full-diameter bore (into a drill point, or beyond a through hole's far face)
is clamped there with a warning, and one that ends inside a counterbore or
countersink taps nothing, also with a warning: neither fails the hole, whose
cut is unaffected. A hole without `thread` ignores the field, so switching the
thread off and on again keeps the depth.

### transform

```yaml
- id: tr1
  kind: transform
  transform:
    bodies: ["@body_ex1"]
    operation: new               # new | replace
    translation: [20, 0, 0]      # or translation_from + translation_to picks
    translation_from: "@pts/p1"
    translation_to: "@pts/p2"
    rotation_angle: 90.0
    rotation_axis: "@sk1/axisLine"   # pick; or rotation_axis_origin + rotation_axis_direction
    rotation_axis_origin: [0, 0, 0]
    rotation_axis_direction: [0, 0, 1]
    scale: 1.0                   # or scale_center + scale_center_from
    scale_center: [0, 0, 0]
    scale_center_from: "@pts/p1"
```

Note: the pick is a list; a document that still says `body:` (the pre-plural
form) is migrated to `bodies:` on load by `migrateLegacyBodyPicks`. Write the
plural key. The raw view (`RawDocumentDialog.tsx`) is a read-only fallback for a
file that failed to load, not an editor.

`rotation_euler: [x, y, z]` is an alternative to the axis spelling: extrinsic
XYZ degrees (world X first, then world Y, then world Z), numbers only, pivoting
about `rotation_axis_origin` or the world origin. It cannot be combined with
`rotation_axis`, `rotation_angle` or `rotation_axis_direction`.

### pattern

One feature patterns either a whole body or one earlier feature's own
operation. `subject` selects what repeats; `mode` selects the instance grid.
The same kind, row and mutation cover all three modes, so a linear, rectangular
or circular pattern is one authored feature.

#### Body subject

```yaml
- id: pt1
  kind: pattern
  pattern:
    subject: body                # body (default) | feature
    source_body: "@extrude1"     # required
    mode: linear                 # linear | rectangular | circular
    operation: add               # add | new
    count: 3                     # linear/circular: total instances, source included (at least 2)
    pitch: 20.0                  # linear: spacing along direction, document unit
    direction: [1, 0, 0]         # linear: or direction_query, a straight edge or planar face
    invert: false                # reverse the direction
- id: pt2
  kind: pattern
  pattern:
    subject: body
    source_body: "@extrude1"
    mode: rectangular            # two axes instead of the one-axis fields
    operation: add
    count_x: 3
    pitch_x: 20.0
    direction_x: [1, 0, 0]       # or direction_x_query
    invert_x: false
    count_y: 2
    pitch_y: 10.0
    direction_y: [0, 1, 0]       # or direction_y_query
    invert_y: false
- id: pt3
  kind: pattern
  pattern:
    subject: body
    source_body: "@extrude1"
    mode: circular
    operation: add
    count: 4
    step_angle: 90.0             # optional; defaults to 360 / count
    axis: "@sk1/axisLine"        # query; or axis_origin + axis_direction
    invert_axis: false           # reverse the sweep sense
```

A resolved `axis` overrides the stored pair; `axis_direction` alone rotates
about the world origin and `axis_origin` alone uses +Z, the same rule as
transform's `rotation_axis_origin` / `rotation_axis_direction`.

`operation: add` unions each instance into the source body only where they
intersect. Disjoint copies stay separate bodies, taking the source id plus
`_1`, `_2`... siblings (the `run` reply summary names the live ids). Use
`operation: new` to keep the source as instance 0 and give every copy its own
body.

A body pattern always counts the source, and there is no include-source option.
A document written before that rule may still carry `pattern.include_source`:
the loader accepts it and the kernel ignores it, so an old file opens with the
source as instance 0 and `count: 3` making two copies. An old file whose pattern
reads `count: 1`, or a 1x1 rectangular pair, also opens; the pattern is a red
feature with the source-in-count refusal until its count is raised. The retired
key is dropped the next time that pattern is edited; no document version
migration rewrites it.

#### Feature subject

A feature-subject pattern repeats an earlier FEATURE's own operation inside the
body that feature already shaped. It is not a body copy plus a boolean: the
source's tool is applied again at each copy position, so one mutation makes one
feature row and one undo entry, and every copied face gets its own construction
names under the pattern feature.

```yaml
- id: pt2
  kind: pattern
  pattern:
    subject: feature
    source_feature: "@ex1"       # required: an earlier extrude, revolve or sweep
    mode: linear                 # linear | rectangular | circular
    count: 3                     # total instances, the source's own included
    pitch: 20.0                  # linear: spacing along direction
    direction: [1, 0, 0]         # linear: or direction_query
    invert: false
    target_body: "@body_ex1"     # optional: the body to apply to when the source touched several
```

`source_feature` must name a feature earlier in the log whose operation is
`add` or `cut`; a `new` source is refused (it does not add into the body), and
an `up_to` extrude is refused because its trim would travel with each rigid
copy. The allowed source kinds are `extrude`, `revolve` and `sweep`; a hole
pattern is the sketch's own multiple drill sites, and a fillet or shell has no
standalone tool to repeat.

For either subject, `count` is the total instance count and always includes the
source: the source occupies instance 0 (and, for a feature subject, its own
application already happened), so `count: 3` makes two copies and `count: 2`
makes one. The kernel refuses a count below 2 because the count includes the
source; the loader still opens an old document with such a count so the pattern
can be corrected.
Rectangular mode always leaves the seed cell to the source, so it makes
`count_x * count_y - 1` copies; 1xN is a legitimate row, while 1x1 is refused
because it would make no copy. The body is the one the
source feature created or modified; when it touched more than one (a cut with
no merge target reaches every body), the solver refuses with the list and
`target_body` picks one. A copy that cannot apply is named: some applied is a
`partial` feature listing how many copies landed and which copy failed, none
applied is an error.

Copies apply through the same body operation the source used, one at a time. A
cut copy that shares no volume with the body is a failure for that copy. An add
copy that does not touch the body is an island: it is a regular new part, not a
failure, and the target keeps its id while the island takes a `_1`, `_2`...
sibling id. If some cut copies applied the feature reports `partial` with the
applied count and the failing copies, and if none applied it is a feature
error. The body keeps its id and its `created_by`, so the pattern changes the
part's material without renaming it.

### mirror

```yaml
- id: mir1
  kind: mirror
  mirror:
    body: "@body_ex1"
    plane: "@builtin_plane_front"   # query; required
    keep_original: true             # false replaces the source in place
    merge: true                     # fuse mirror into source when keep_original
```

### split

```yaml
- id: sp1
  kind: split
  split:
    bodies: ["@ex1"]              # required, >= 1 body ref (a feature ref = all its bodies)
    plane: "@pl1"                 # required: @builtin_plane_*, Front/Top/Right,
                                  # @<plane feature id>, or a ?...:flatface query
    keep: above                   # above | below | both (default above)
```

`above` is the side the plane normal points to. Builtin normals: Front +Z,
Top +Y, Right +X. An `add_plane` feature has its own normal. A planar face pick
uses the face's OUTWARD normal, so `above` of a picked body face is the air side
of that face.

`keep: both` keeps every piece. The original body id stays on the above half
(the geometric first solid of that side); every further piece becomes a sibling
in geometric order (`<id>_1`, `<id>_2`, ...) of the same creator, so
`@<featureId>` still names every piece and `part_style` (name, colour) stays on
the above half. A one-sided keep can disconnect its kept side too (two arms
above a slot), and each piece then becomes a sibling the same way. `keep: below`
keeps only the other side.

The cap the plane leaves is named `<featureId>|splitcap|<bodyId>|<side>` (one
per body and side), so a pick on a cap survives a plane offset edit, a body
resize and a change between `above` and `both` (the above cap) or `below` and
`both` (the below cap). Faces the plane crosses keep their UUID on the kept
side; with `both` each crossed face gets one `split|i` child per half.

A split fails loud rather than deleting silently: a plane that misses a body,
or a kept side with no material, is a feature exception and the body is left
exactly as it was. The other bodies are only touched after every picked body
has passed and every name is minted, so one failing body does not leave the
feature half applied. Accepted limitation: the final re-seat can still refuse
when the result's pieces are a near-tie for the geometric sibling order (or a
centroid cannot be read). That refusal happens after the earlier bodies were
re-seated, so those keep the split while the failing body stays whole. Ordering
is never guessed: a flipped body id would silently move a part's name and
colour.

### delete_body / import_step

```yaml
- id: db1
  kind: delete_body
  delete_body:
    bodies:                         # one or more body refs/queries; duplicates collapse
      - "@body_ex1"
      - "@body_ex2"
```

```yaml
- id: import1
  kind: import_step
  file_id: "cube.step"
  scale: 1.0
```

`import_step` keeps its params flat on the feature: it is the one
expression-capable kind with no kind sub-dict (`ExprPayloads` in
`kernel/evalExpr.ts`). `file_id` names an entry in the file registry
(`stores/fileRegistry`), which resolves to the STEP bytes for the solve; the old
inline `file_data` spelling is refused by name.

### variable

```yaml
- id: width
  kind: variable
  label: width                   # the variable name (must be a valid identifier)
  variable:
    expression: "10 + 2"         # number or formula; evaluated against earlier variables
    unit: "mm"                   # optional display hint
```

`value` (number) is reserved for the solver's evaluated result: it is never
authored, and nothing writes it back into the document today (the solved value
is rendered from the solve results, not read back from this field). A variable's
`unit` is a display hint only: nothing converts values from it, and the feature
tree shows it beside the solved value.

### helix

A reference curve (not a body). A helix laid on a cylinder: pick a cylindrical
face, a circular/straight edge or a sketch circle/line as the reference. The
radius comes from the reference (`derived`) or is typed (`entered`). `mode`
names the two given quantities; the rest are derived with circumference
`C = 2*pi*r`.

```yaml
- id: hx1
  kind: helix
  helix:
    reference: ?...@u|f_...:cylinderface   # cylinder face | circular/straight edge | sketch circle/line
    radius_mode: derived   # derived | entered
    radius: 5              # read only when entered; > 0
    mode: pitch_turns      # see the mode table
    pitch: 1.5             # axial rise per turn, > 0
    turns: 10              # > 0, fractional allowed
    height: 15             # total axial length, > 0
    helix_angle: 5         # deg, (0, 90)
    height_from_reference: false   # height = the face's axial length (cylinder face only)
    offset: 0              # axial start shift along the climb direction, may be negative
    start_angle: 0         # deg, any value; the fine adjustment
    hand: right            # right | left
    direction: normal      # normal | reverse
```

All fields are stored even when the mode ignores them, so switching mode never
loses input. Every numeric field is expression-capable.

| mode | given | derived |
|------|-------|---------|
| `pitch_turns` | pitch, turns | height = pitch * turns |
| `pitch_height` | pitch, height | turns = height / pitch |
| `turns_height` | turns, height | pitch = height / turns |
| `angle_turns` | helix_angle, turns | pitch = C * tan(angle), height = pitch * turns |
| `angle_height` | helix_angle, height | pitch = C * tan(angle), turns = height / pitch |

`height_from_reference: true` takes `height` from a cylinder face's axial extent
in the modes that use height (a thread over the whole boss). With any other
reference it is a solve error. The reference axis `a0`, the zero direction `x0`,
the climb direction (`a0` for `normal`, `-a0` for `reverse`), `start_angle`,
`hand` and `offset` are independent: flipping one never moves what another
controls. `hand` is the curve's chirality about `a0`, so a right-hand thread
stays right-hand when `direction` flips.

The solve registers `_curve_<id>` (plain descriptor data), `<id>` (its axis),
`<id>/start` and `<id>/end`, and reports the derived values. A run or measure
reply also carries the placement under `curves.<id>` as
`{origin, axis, start, end, radius, pitch, turns, height, hand}`, where `axis`
is the climb direction (`direction: reverse` negates it). `@<id>/start` and
`@<id>/end` stay valid point refs, for example as a sweep profile plane's
`origin`, so a profile can be placed on the curve without a throwaway plane. A
helix is never a `bodyStore` body. A bare `$<id>` or `@<id>` is a valid sweep
`path` (the way to sweep a thread): it must be the sweep's only path ref, and a
`multisection` sweep refuses it.

## Constraints

Constraint operands are query strings: a local ref (`$line1`, or `$line1start`
for a vertex) names an entity of the same sketch, `@builtin_origin` names the
document origin, and absolute or ancestry queries (`@sk1/line1/start`,
`?4;@ex1:solid`) name anything else. The loader also accepts the pre-resolved
dict forms on read: `{"entity": "<eid>", "point": "<key>"}` (`point` names a
vertex key such as `start`, `end`, `center`, `xy`; absent means the whole
entity) and `{"external_xy": [x, y]}`. The app writes the string form.

| kind | description |
|------|-------------|
| `coincident` | Points coincide, or point-on-line/point-on-circle, or line collinear |
| `horizontal` | Y-diff zero |
| `vertical` | X-diff zero |
| `length` | Distance minus value |
| `radius` | Radius minus value |
| `diameter` | 2*radius minus value |
| `line_distance` | Perpendicular distance minus value |
| `normal` | Dot product of directions |
| `parallel` | Cross product of directions |
| `angle` | Angle between lines (deg) |
| `tangent` | Line perpendicular to radius |
| `equal_length` | Length difference |
| `point_distance` | Distance minus value |
| `point_distance_x` | X-component of point-to-point distance minus value |
| `point_distance_y` | Y-component of point-to-point distance minus value |
| `midpoint` | Point at midpoint of line |
| `concentric` | Center-delta x and y |
| `radius_difference` | Difference of two radii minus value |
| `fixed` | Params pinned to initial |
| `group` | Members hold their shape and their offset from the anchor point; the set may translate (2 DOF) |
| `projection` | Holds an entity to its projected source shape and position |
| `colinear` | Two lines collinear (parallel and on one line), or a point on the infinite line through a line |
| `ngon` | Sugar: regular polygon over `refs` (member lines), optionally pinned to the `circle` circumcircle; lowered to equal_length, angle and coincident rows |
| `dock` | Sugar: `point` pinned to the implied contact of the `host` constraint (today a tangent's foot); lowered to coincident rows, and floats when the host is deleted |

`sign` (+1 or -1) picks the side a directional dimension measures on, keeping
`value` non-negative; absent means the legacy side-agnostic absolute behavior.
`pos` is the dimension label position, a 2D offset in sketch space relative to
the constraint's anchor point. Both are authored, never solver output.

A point key names a point only on a kind that has it: `$c0center` on a
`circle`, `$a0start` on an `arc`, `$e0major1` on an `ellipse`. A constraint whose
operand names a key the target's current kind does not have (a `center` on a
`line`, an ellipse axis key on a `circle`) is dropped from that solve and
reported in `dropped_constraints`, with the key and the kind named, rather than
bound to an arbitrary point. The row stays in the document, so a kind that
returns to one with that key re-enables it.

## Query Syntax

| Prefix | Kind | Example |
|--------|------|---------|
| `$<eid><sub>` | LocalQuery - entity in current sketch | `$line1`, `$line1start` |
| `@<feature_id>/<eid>/<sub>` | AbsoluteQuery - cross-feature | `@sk1/line1/start`, `@builtin_plane_front` |
| `?<hex_lengths>;<id_strings>[:<type>]` | AncestryQuery - hierarchical | `?4;@ex1:solid` |

Sub suffixes: `start`, `end`, `center`, `xy`, the ellipse axis keys
(`major1`/`major2`/`minor1`/`minor2`) and the spline controls (`c1`, `c2`).
Ancestry types: `solid`, `face` and its subtypes (`flatface`, `cylinderface`,
`coneface`, `sphereface`, `torusface`), `edge` and `straightedge`, `vertex`.

Geometric classifiers disambiguate topology elements that share ancestry. They are minted `@cls_*` tokens that ride the ancestry id list (no grammar change), not a separate suffix: cardinal/axial (`@cls_xp`/`@cls_xn`/`@cls_yp`/`@cls_yn`/`@cls_zp`/`@cls_zn`) and line-division (`@cls_ld_<lineid>_p|n`). See `docs/query.md` for the resolution tiers.

## Built-in Planes

| Name | origin | x_axis | y_axis | normal |
|------|--------|--------|--------|--------|
| `builtin_plane_front` | `[0,0,0]` | `[1,0,0]` | `[0,1,0]` | `[0,0,1]` |
| `builtin_plane_top` | `[0,0,0]` | `[1,0,0]` | `[0,0,-1]` | `[0,1,0]` |
| `builtin_plane_right` | `[0,0,0]` | `[0,0,-1]` | `[0,1,0]` | `[1,0,0]` |

Shorthands `"Front"`, `"Top"`, `"Right"` also recognized.

## Constraint Status

Derived from the constraint Jacobian at the solution
(`sketch-solver/src/solve.rs`):

- **fully_constrained** - the residual is satisfied and the Jacobian rank
  reaches the parameter count (`rank == n_params`); rank counts singular values
  above `RANK_TOL = 1e-6`.
- **underconstrained** - the residual is satisfied but the rank is below the
  parameter count.
- **overconstrained** - the final residual norm is not within
  `LOSS_REL = 1e-7` times the sketch's size (`Problem::scale`, the diagonal of
  the seed geometry's bounding box, `residuals/scale.rs`), or it is not finite.
  The solver then reports a per-constraint miss fraction so the UI can localise
  the conflict.

There is no rigid-body DOF allowance: a point pinned at the origin still leaves
a removable rotation DOF.

## Frontend Adapter Note

The conversion from solver result flat arrays to the named-field format
(`{line1: {start: [x,y], end: [x,y]}}`) lives in the frontend rendering layer,
not the solver: `utils/geometry/geometryMapping.ts` (`unflattenGeometry`). Flat
arrays are used on the wire so solver output is isomorphic with the document
`initial` field.
