# AST — Feature/Sketch Document Schema

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
  sketch: "$sk1"                # or list of refs
  distance: 10.0                # depth alias
  direction: normal             # normal | reverse | symmetric
  operation: new                # new | add | cut
```

### revolve

```yaml
- id: rev1
  kind: revolve
  sketch: "$sk1"
  angle: 360.0
  axis_origin: [0, 0, 0]
  axis_direction: [0, 1, 0]
  operation: new
```

### sweep

```yaml
- id: sw1
  kind: sweep
  sweep:
    sketch: "$sk1"               # profile ref (or list)
    path: "@sk2/spine"           # path ref (or list)
    operation: add               # new | add | cut
    merge_target: "@body_ex1"    # optional
```

### fillet / chamfer

```yaml
- id: fil1
  kind: fillet
  edges: ["?query:edge"]
  radius: 1.0
```

```yaml
- id: ch1
  kind: chamfer
  edges: ["?query:edge"]
  distance: 1.0
  kind: distance                # distance | angle_distance
```

### boolean

```yaml
- id: bool1
  kind: boolean
  boolean:
    operation: union             # union | subtract | intersect
    target: "@extrude1"
    tools: ["@extrude2"]
    keep_tools: false
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
    body: "@body_ex1"
    translation: [20, 0, 0]
    rotation_angle: 90.0
    operation: new               # new | replace
```

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
| `$<eid><sub>` | LocalQuery — entity in current sketch | `$line1/start` |
| `@<feature_id>/<eid>/<sub>` | AbsoluteQuery — cross-feature | `@sk1/line1/start`, `@builtin_plane_front` |
| `?<hex_lengths>;<id_strings>[:<type>]` | AncestryQuery — hierarchical | `?4;@ex1:solid` |

Sub suffixes: `start`, `end`, `center`, `xy`. Ancestry types: `solid`, `face`, `flatface`, `cylinderface`, `edge`, `straightedge`, `vertex`.

Geometric classifiers disambiguate topology elements that share ancestry. They are minted `@cls_*` tokens that ride the ancestry id list (no grammar change), not a separate suffix: cardinal/axial (`@cls_xp`/`@cls_xn`/`@cls_yp`/`@cls_yn`/`@cls_zp`/`@cls_zn`) and line-division (`cls_ld_<lineid>_p|n`). See `docs/query.md` for the resolution tiers.

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
- **fully_constrained** — Jacobian rank reaches the parameter count (rank == n_params)
- **underconstrained** — Jacobian rank < n_params
- **overconstrained** — final residual loss > 1e-4

## Frontend Adapter Note

The frontend rendering layer (`Geometry3D`) converts solver result flat arrays to named-field format (`{line1: {start: [x,y], end: [x,y]}}`). Flat arrays are used on the wire so solver output is isomorphic with the document `initial` field.
