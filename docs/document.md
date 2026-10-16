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
(the dev bridge, the MCP server and the headless CLI in `frontend/src/drive`),
and the import/export paths. The JSON Schema in `persistence/partDocSchema.ts`
is the contract.

The assembly document (parts, instances, mates) is a separate format and is not
covered here.

## Document Structure

```yaml
version: 1
kind: part

features:
  - id: sk1
    kind: sketch
    ...
```

Top-level fields: `version` (int), `kind` (string, currently `"part"`), `features` (list).

A feature keeps its base fields (`id`, `kind`, `label`, `visible`, `suppressed`) flat and every other param under the field named after its kind (`extrude: {...}`; `definition:` for a plane). A reference from one feature to another feature is absolute, `@<featureId>`; `$` is host-local to a sketch's own entities. `persistence/docSchema.ts` folds the legacy flat params and the `$id` feature refs onto these canonical forms on load; `persistence/partDocSchema.ts` is the hand-written JSON Schema contract (kept in step with `types/cad.ts` by the compile-time kind tether and the corpus test), served as the MCP resource `oversolved://schema/part-document`.

## Feature Kinds

### sketch

```yaml
- id: sk1
  kind: sketch
  plane: "@builtin_plane_front"   # query; defaults to front plane
  label: "Sketch 1"
  hide: false
  initial:                         # warm-start guesses [flat param arrays]
    line_base:   [0.0, 0.0, 17.32, 0.0]
  entities:
    - id: line_base
      kind: line
  constraints:
    - id: c1
      kind: horizontal
      target: { entity: line_base }
```

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
    distance: 10.0              # depth is a legacy alias
    direction: normal           # normal | reverse | symmetric
    operation: new              # new | add | cut
```

### revolve

```yaml
- id: rev1
  kind: revolve
  revolve:
    sketch: "@sk1"
    angle: 360.0
    axis: "@sk1/axisLine"       # required pick: line edge, sketch line, or circular edge
    operation: new
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
```

### transform

```yaml
- id: tr1
  kind: transform
  transform:
    bodies: ["@body_ex1"]
    translation: [20, 0, 0]
    rotation_angle: 90.0
    operation: new               # new | replace
```

Note: the pick is a list; a document that still says `body:` (the pre-plural
form) is migrated to `bodies:` on load by `migrateLegacyBodyPicks`, so the code
tab should always write the plural key.

### array

```yaml
- id: arr1
  kind: array
  array:
    source_body: "extrude1"
    mode: linear                 # linear | rectangular
    count_x: 3
    pitch_x: 20.0
```

### circular_array

A rotational array is its own feature kind (not a `mode` of `array`):

```yaml
- id: carr1
  kind: circular_array
  circular_array:
    source_body: "extrude1"
    count: 4
    step_angle: 90.0             # optional; defaults to 360 / count
    axis: "@sk1/axisLine"        # query; or axis_origin + axis_direction
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

### variable

```yaml
- id: width
  kind: variable
  label: width                   # the variable name (must be a valid identifier)
  variable:
    expression: "10 + 2"         # number or formula; evaluated against earlier variables
```

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

Refs use `{"entity": "<eid>", "point": "start"|"end"|"center"|"xy"}` or `{"external_xy": [x, y]}`. `point` defaults to `start`.

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

## Query Syntax

| Prefix | Kind | Example |
|--------|------|---------|
| `$<eid><sub>` | LocalQuery - entity in current sketch | `$line1/start` |
| `@<feature_id>/<eid>/<sub>` | AbsoluteQuery - cross-feature | `@sk1/line1/start`, `@builtin_plane_front` |
| `?<hex_lengths>;<id_strings>[:<type>]` | AncestryQuery - hierarchical | `?4;@ex1:solid` |

Sub suffixes: `start`, `end`, `center`, `xy`. Ancestry types: `solid`, `face`, `flatface`, `cylinderface`, `edge`, `straightedge`, `vertex`.

Geometric classifiers disambiguate topology elements that share ancestry. They are minted `@cls_*` tokens that ride the ancestry id list (no grammar change), not a separate suffix: cardinal/axial (`@cls_xp`/`@cls_xn`/`@cls_yp`/`@cls_yn`/`@cls_zp`/`@cls_zn`) and line-division (`@cls_ld_<lineid>_p|n`). See `docs/query.md` for the resolution tiers.

## Built-in Planes

| Name | origin | x_axis | y_axis | normal |
|------|--------|--------|--------|--------|
| `builtin_plane_front` | `[0,0,0]` | `[1,0,0]` | `[0,1,0]` | `[0,0,1]` |
| `builtin_plane_top` | `[0,0,0]` | `[1,0,0]` | `[0,0,-1]` | `[0,1,0]` |
| `builtin_plane_right` | `[0,0,0]` | `[0,0,-1]` | `[0,1,0]` | `[1,0,0]` |

Shorthands `"Front"`, `"Top"`, `"Right"` also recognized.

## Constraint Status

Determined from Jacobian rank at the solution (no rigid-body DOF allowance: a
point pinned at the origin still leaves a removable rotation DOF):
- **fully_constrained** - Jacobian rank reaches the parameter count (rank == n_params)
- **underconstrained** - Jacobian rank < n_params
- **overconstrained** - final residual loss > 1e-4

## Frontend Adapter Note

The frontend rendering layer (`Geometry3D`) converts solver result flat arrays to named-field format (`{line1: {start: [x,y], end: [x,y]}}`). Flat arrays are used on the wire so solver output is isomorphic with the document `initial` field.
