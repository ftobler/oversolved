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
    mode: linear                 # linear | rectangular | rotational
    count_x: 3
    pitch_x: 20.0
```

### delete_body / import_step

```yaml
- id: db1
  kind: delete_body
  delete_body:
    body: "@body_ex1"
```

```yaml
- id: import1
  kind: import_step
  file_id: "cube.step"
  scale: 1.0
```

## Sketch Entities

| kind | params | meaning |
|------|--------|---------|
| `point` | `[x, y]` | position |
| `line` | `[x1, y1, x2, y2]` | start, end |
| `circle` | `[cx, cy, r]` | center, radius |
| `arc` | `[cx, cy, r, a0, a1]` | center, radius, start angle (deg), end angle (deg) |
| `center_rect` | compound (expanded to 4 lines) | xy, size |
| `projected_*` | same as base type | projected from 3D source |

Projected entities carry a `source` field and get an automatic `fixed` constraint. Any entity can set `construction: true`.

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
| `midpoint` | Point at midpoint of line |
| `concentric` | Center-delta x and y |
| `fixed` | Params pinned to initial |

## Query Syntax

| Prefix | Kind | Example |
|--------|------|---------|
| `$<eid><sub>` | LocalQuery — entity in current sketch | `$line1/start` |
| `@<feature_id><eid><sub>` | AbsoluteQuery — cross-feature | `@sk1/line1/start`, `@builtin_plane_front` |
| `?<hex_lengths>;<id_strings>[:<type>]` | AncestryQuery — hierarchical | `?4;@ex1:solid` |

Sub suffixes: `start`, `end`, `center`, `xy`. Ancestry types: `solid`, `face`, `flatface`, `cylinderface`, `edge`, `straightedge`, `vertex`.

Geometric classifiers (`@pos`, `@neg`, `@inner`, `@outer`, `@north`, `@south`, `@east`, `@west`) disambiguate topology elements sharing ancestry (parsed but not yet used in resolution).

## Built-in Planes

| Name | origin | x_axis | y_axis | normal |
|------|--------|--------|--------|--------|
| `builtin_plane_front` | `[0,0,0]` | `[1,0,0]` | `[0,1,0]` | `[0,0,1]` |
| `builtin_plane_top` | `[0,0,0]` | `[1,0,0]` | `[0,0,-1]` | `[0,1,0]` |
| `builtin_plane_right` | `[0,0,0]` | `[0,0,-1]` | `[0,1,0]` | `[1,0,0]` |

Shorthands `"Front"`, `"Top"`, `"Right"` also recognized.

## Constraint Status

Determined from Jacobian rank at the solution:
- **fully_constrained** — no free DOF (beyond 3 rigid-body DOF)
- **underconstrained** — Jacobian rank < n_params - 3
- **overconstrained** — final residual loss > 1e-4

## Frontend Adapter Note

The frontend rendering layer (`Geometry3D`) converts solver result flat arrays to named-field format (`{line1: {start: [x,y], end: [x,y]}}`). Flat arrays are used on the wire so server output is isomorphic with the document `initial` field.
