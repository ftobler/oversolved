# Part Document - Schema

## What the document is

A part document is an ordered list of feature records. Each record is one layer
of a build: the state after feature N is the accumulation of features `[0..N]`.
The rollback position is an index into that list, and an incremental rebuild
reuses the unchanged prefix (`findFirstDirty`, `kernel/builder.ts`).

The records are flat: no nesting, no control flow, no user functions. Repetition
is a feature kind (`array`, `circular_array`). Dependencies between features are
references (query strings, see Query Syntax) plus the list order; numeric params
may be expression strings evaluated against earlier `variable` features
(`kernel/evalExpr.ts`). Some kinds are shorthand that is lowered before the
solver runs (`center_rect`, the `ngon` constraint).

The same document is the target for every author: the GUI, the drive surface
(the dev bridge and the headless operations in `frontend/src/drive`; the CLI
and MCP entry points in `frontend/scripts`), and the import/export paths. The
JSON Schema in `persistence/partDocSchema.ts` is the contract.

The assembly document (parts, instances, mates) is a separate format and is not
covered here.

## Document Structure

```yaml
version: 3
kind: part

features:
  - id: sk1
    kind: sketch
```

Top-level fields: `version` (int, the migration-ladder stamp; the ladder target
is `CURRENT_DOC_VERSION = 3` in `persistence/docSchema.ts`, and a missing or
older stamp runs the steps that bring it up), `kind` (string, `"part"`),
`rollback` (int, an index into `features`; absent means the end of the stack,
and a rolled-back document reopens where the user left it), `features` (list),
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
`utils/yamlMutations/partStyle.ts`). The rollback bar cannot be dragged above
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
| `center_rect` | compound (expanded to 4 lines) | xy, size |

Projection is not a kind: any base-kind entity (`line`/`circle`/`arc`/`point`) that carries a `source` field is projected from a 3D source and gets an automatic `fixed` constraint pinning it. Legacy `projected_*` kinds are still accepted on read and normalized to their base kind. Any entity can set `construction: true`.

### plane

```yaml
- id: pl1
  kind: plane
  definition:
    mode: offset                 # offset | three_point | plane_point | line_angle | on_face | on_face_edge_angle | edge_point
    plane: "@builtin_plane_front"
    offset: 10.0
    rotation: 0.0
```

### extrude

```yaml
- id: ex1
  kind: extrude
  extrude:
    sketch: "@sk1"              # or list of refs
    distance: 10.0              # required; the legacy `depth` spelling is read as an alias
    direction: normal           # normal | reverse | symmetric
    operation: new              # new | add | cut
    termination: blind          # blind | up_to
    up_to: "@body_ex1/face/0"   # up_to only: a plane, a point, or a planar face
    merge_target: "@body_ex1"   # optional: the body the result fuses into
```

`up_to` trims the extrude at the picked element instead of at `distance`. A
target that does not resolve, or meets several elements, falls back to the blind
distance with a solver warning; a non-planar face target and
`direction: symmetric` are refused.

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

### sweep

```yaml
- id: sw1
  kind: sweep
  sweep:
    sketch: "@sk1"              # profile ref (or list)
    path: "@sk2/spine"          # path ref (or list)
    operation: add              # new | add | cut
    merge_target: "@body_ex1"   # optional
```

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

### shell

```yaml
- id: sh1
  kind: shell
  shell:
    faces: ["?query:flatface"]   # removed faces (openings); may be empty
    thickness: 1.0               # expression-capable, > 0
    direction: inward            # inward | outward (inward keeps the outer skin)
    source_body: "@body_ex1"     # required when faces is empty
```

An empty `faces` list makes a closed hollow (one solid with an inner void), so
`source_body` is required: no face names the body. Faces naming several bodies
is an error.

### loft

```yaml
- id: lo1
  kind: loft
  loft:
    profiles: ["@sk1", "@sk2", "@sk3"]  # two or more, in order along the loft
    ruled: false                        # false (default) smooth, true ruled bands
    operation: new                      # new | add | cut
    merge_target: "@body_ex1"           # add/cut target, optional
```

Each profile resolves like an extrude profile (a whole sketch, a picked area or
curve, a planar body face); its outer boundary is the section, so a section's
holes are not carried through the surface. A section that resolves to several
separate regions is an error. The first profile is the start cap, the last the
end cap, whatever their world positions.

### draft

```yaml
- id: dr1
  kind: draft
  draft:
    faces: ["?query;...:flatface"]  # faces to tilt, all on one body
    angle: 3                        # signed degrees, expression-capable
    neutral: "@builtin_plane_front" # required: plane or planar face
    direction: "?query;...:straightedge"  # pull axis, optional
```

The pull direction is oriented from the neutral plane toward the body's
bounding-box centre, so the pick's own sign is ignored and a positive `angle`
always recedes along the pull direction away from the neutral plane (material
comes off) while a negative angle grows the part. An empty `direction` uses the
neutral plane's own normal, oriented the same way.

### move_face

```yaml
- id: mf1
  kind: move_face
  move_face:
    faces: ["?query;...:flatface"]  # planar faces, applied in list order
    distance: 5                     # signed along each face's outward normal,
                                    # expression-capable; 0 is the identity
```

Each face moves along its own outward normal and the faces that bound it are
extended (or trimmed) along their own surfaces, so a cone base pushed down grows
the cone itself. Positive adds material, negative removes it. A move that
removes the whole body is an error. v1 moves planar faces only; a face with a
tangent neighbour (a fillet) is refused.

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
    clearance: 0.1               # subtract only; signed mm, grows (+) or shrinks (-) every tool on all sides
```

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
    thread:                      # optional, cosmetic only (no geometry change)
      designation: M6x1          # a thread-table entry
      nominal: 6.0               # the thread's major diameter, mm
      pitch: 1.0                 # mm per turn
```

A cosmetic thread adds no geometry: the bore stays the authored `diameter`
(normally the table entry's tap drill) and the solve reports the thread's
metadata plus one display helix per drilled bore, drawn on the bore wall. The
pair is checked against the thread table at load time when the table carries the
designation.

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

### array

```yaml
- id: arr1
  kind: array
  array:
    source_body: "@extrude1"     # required
    mode: linear                 # linear | rectangular
    operation: new               # new | add
    include_source: true         # keep the source as instance 0 of the pattern
    count_x: 3
    pitch_x: 20.0
    direction_x: [1, 0, 0]       # or direction_x_query, a straight edge or planar face
    invert_x: false              # reverse the direction
    count_y: 2                   # rectangular only
    pitch_y: 10.0
    direction_y: [0, 1, 0]
    direction_y_query: "?query:straightedge"
    invert_y: false
```

### circular_array

A rotational array is its own feature kind (not a `mode` of `array`):

```yaml
- id: carr1
  kind: circular_array
  circular_array:
    source_body: "@extrude1"
    count: 4
    step_angle: 90.0             # optional; defaults to 360 / count
    axis: "@sk1/axisLine"        # query; or axis_origin + axis_direction
    invert_axis: false           # reverse the sweep sense
    operation: new               # new | add
    include_source: true
```

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
`unit` is a display hint only: nothing converts values from it, and the
parameter table (the part editor's Parameters view) shows every variable as
name / expression / unit / solved value, editing all three authored columns.

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
`<id>/start` and `<id>/end`, and reports the derived values. A helix is never a
`bodyStore` body.

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
| `colinear` | Point on the infinite line through a line |
| `ngon` | Sugar: regular polygon over `refs` (member lines), optionally pinned to the `circle` circumcircle; lowered to equal_length, angle and coincident rows |
| `dock` | Sugar: `point` pinned to the implied contact of the `host` constraint (today a tangent's foot); lowered to coincident rows, and floats when the host is deleted |

`sign` (+1 or -1) picks the side a directional dimension measures on, keeping
`value` non-negative; absent means the legacy side-agnostic absolute behavior.
`pos` is the dimension label position, a 2D offset in sketch space relative to
the constraint's anchor point. Both are authored, never solver output.

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
