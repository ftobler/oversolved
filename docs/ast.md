# AST

## High-Level Example

```yaml
oversolved: 1  # version
queries
  - id: <id>
    kind: <kind>
    ...
features:
  - type: sketch
    plane:
      query: <id>
    initial:
      - <id>: [1, 2]
    entities:
      - id: <id>
        kind: line
    constraints:
      - id: <id>
        kind: coincident
  - type: extrude
    ...
```

---

## Detailed Example

```yaml
version: 1  # integer
kind: part

queries:
  - id: <id:top_plane>
    kind: entity_query
    entity_type: face
    history_type: creation
    operation_id: top_plane_op
    query_type: dummy

  - id: <id:origin_point>
    kind: entity_query
    entity_type: vertex
    history_type: creation
    operation_id: origin_point_op
    query_type: dummy

  - id: <id:sketch_1_profile>
    kind: union_query
    members:
      - kind: sketch_region_query
        source_feature: <id:sketch_1>

features:
  - id: <id:sketch_1>
    kind: sketch
    label: "Sketch 1"
    plane:
      query: <id:top_plane>
    initial:
      - <id:line_base>:   [0.0, 0.0, 17.32, 0.0 ]
      - <id:line_height>: [17.32, 0.0, 17.32, 10.0]
      - <id:line_hyp>:    [17.32, 10.0, 0.0, 0.0 ]
    entities:
      - id: <id:line_base>
        kind: line_segment
      - id: <id:line_height>
        kind: line_segment
      - id: <id:line_hyp>
        kind: line_segment
    constraints:
      - id: <id:c_origin>
        kind: coincident
        a: { entity: <id:line_base>.start }
        b: { query: <id:origin_point> }
      - id: <id:c_horizontal_base>
        kind: horizontal
        target: { entity: <id:line_base> }
      - id: <id:c_perpendicular>
        kind: perpendicular
        a: { entity: <id:line_base> }
        b: { entity: <id:line_height> }
      - id: <id:c_angle_30>
        kind: angle
        a: { entity: <id:line_base> }
        b: { entity: <id:line_hyp> }
        value: 30 deg
      - id: <id:c_length_height>
        kind: length
        target: { entity: <id:line_height> }
        value: 10 mm

  - id: <id:extrude_1>
    kind: extrude
    label: "Extrude 1"
    entities:
      - query: <id:sketch_1_profile>
    body_type: solid
    operation: new
    extents:
      type: blind
      depth: 10 mm
    symmetric: false

```

---

## Prototype Format (implemented)

This is the subset currently understood by the solver. Differences from the full format:
- `initial` is a mapping `entity_id: [x1, y1, x2, y2]` instead of a list
- constraint `value` fields are plain numbers (mm and degrees implied, no unit string)
- `queries` and `plane` are not yet used

```yaml
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    label: "Sketch 1"

    # Starting guesses - solver moves these to satisfy constraints
    initial:
      line_base:   [0.0,   0.0,  17.32,  0.0 ]
      line_height: [17.32, 0.0,  17.32, 10.0 ]
      line_hyp:    [17.32, 10.0,  0.0,   0.0 ]

    # list of primitives on the sketch
    entities:
      - id: line_base
        kind: line_segment
      - id: line_height
        kind: line_segment
      - id: line_hyp
        kind: line_segment

    # lits of constraints on the sketch
    constraints:
      - id: c_horizontal_base
        kind: horizontal
        target: { entity: line_base }
      - id: c_perpendicular
        kind: perpendicular
        a: { entity: line_base }
        b: { entity: line_height }
      - id: c_join
        kind: coincident
        a: { entity: line_base,   point: end   }
        b: { entity: line_height, point: start }
      - id: c_angle_30
        kind: angle
        a: { entity: line_base }
        b: { entity: line_hyp }
        value: 30
      - id: c_length_height
        kind: length
        target: { entity: line_height }
        value: 10
```

Solver output:

```python
result = solve(yaml_str)
result["sketch_1"]["line_base"]["start"]   # (x, y)
result["sketch_1"]["line_base"]["end"]     # (x, y)
result["sketch_1"]["line_height"]["start"] # (x, y)
```

### Supported entity kinds

| kind         | initial parameters              | geometry output fields                                          |
|--------------|---------------------------------|-----------------------------------------------------------------|
| line_segment | [x1, y1, x2, y2]               | start: (x,y), end: (x,y)                                       |
| circle       | [cx, cy, r]                    | center: (x,y), radius: float                                    |
| arc          | [cx, cy, r, a_start, a_end]    | center: (x,y), radius: float, angle_start: deg, angle_end: deg, start: (x,y), end: (x,y) |
| point        | [x, y]                         | x: float, y: float                                              |

Arcs are defined CCW in a y-up coordinate system. `a_start` and `a_end` are angles in degrees
measured from the +x axis. `start` and `end` in the output are the arc endpoints on the circle.

Valid `point` references per entity kind:

| kind         | valid point values            |
|--------------|-------------------------------|
| line_segment | `start` (default), `end`      |
| circle       | `center` (only option)        |
| arc          | `start` (default), `end`      |
| point        | (no point key needed)         |

### Supported constraint kinds

| kind           | fields                                                        | residuals (=0 when satisfied)                          |
|----------------|---------------------------------------------------------------|--------------------------------------------------------|
| horizontal     | `target: {entity}`                                            | end.y - start.y                                        |
| vertical       | `target: {entity}`                                            | end.x - start.x                                        |
| length         | `target: {entity}`, `value: float`                            | len(line) - value                                      |
| radius         | `target: {entity}`, `value: float`                            | r - value                                              |
| coincident     | `a: {entity, point}`, `b: {entity, point}`                    | a.x - b.x, a.y - b.y                                   |
| perpendicular  | `a: {entity}`, `b: {entity}`                                  | dot(dir_a, dir_b)                                      |
| angle          | `a: {entity}`, `b: {entity}`, `value: float (deg)`            | cos(angle_between) - cos(value)                        |
| tangent        | `line: {entity}`, `arc: {entity, point}`                      | dot(line_dir, radius_dir) -- line perpendicular to radius |
| normal         | `line: {entity}`, `arc: {entity, point}`                      | cross(line_dir, radius_dir) -- line parallel to radius |
| equal_length   | `a: {entity}`, `b: {entity}`                                  | len(a) - len(b)                                        |
| point_distance | `a: {entity, point}`, `b: {entity, point}`, `value: float`    | dist(a, b) - value                                     |
| midpoint       | `line: {entity}`, `point: {entity}`, `axis: x\|y\|both`       | point - midpoint(line) on specified axis(es)           |
| concentric     | `a: {entity}`, `b: {entity}`                                  | center_a.x - center_b.x, center_a.y - center_b.y       |
| fixed          | `target: {entity, point}`, `x: float`, `y: float`             | point.x - x, point.y - y                               |

`point` defaults to `start` when omitted. `axis` in `midpoint` defaults to `both`.

### Solve response

The server receives the document (as JSON or YAML), solves each sketch feature, and returns
**only new information produced by solving** — it does not echo the input back.
The response structure maps feature IDs to their individual solve results.

#### Per-feature result fields

| field        | type    | description |
|--------------|---------|-------------|
| `solve_ms`   | float   | wall-clock solve time in milliseconds |
| `status`     | string  | `"fully_constrained"` \| `"underconstrained"` \| `"overconstrained"` |
| `geometry`   | object  | solved entity positions (see below) |
| `topology`   | object  | inferred points, vertices, and enclosed areas (see below) |

Constraint residuals are available internally but are not included in the response —
at a valid solution they are ~0 by definition.

#### `geometry` — solved entity positions

Entity positions after solving, keyed by entity ID, in the same parameter-array format
as the input `initial`.  The UI can write these back into `initial` to improve stability
on the next solve (warm-starting the solver with the previous solution).

```yaml
geometry:
  line_base:   [0.0, 0.0, 17.32, 0.0]   # same layout as initial: [x1,y1,x2,y2]
  line_height: [17.32, 0.0, 17.32, 10.0]
  arc1:        [5.0, 5.0, 3.0, 0.0, 90.0]  # [cx,cy,r,a_start,a_end]
```

Using the flat array form (same as `initial`) means the client can diff and merge
without knowing entity kinds.

#### `topology`

Derived connectivity computed after solving.  Contains three sub-objects:

```yaml
topology:
  vertices:
    v1: {x: 0.0,   y: 0.0}    # named endpoints / shared points
    v2: {x: 17.32, y: 0.0}
    v3: {x: 17.32, y: 10.0}

  intersection_points:
    ip1: {x: 5.0, y: 5.0}     # computed curve–curve intersections (no input counterpart)

  surfaces:
    - boundary:
        - {kind: line, start_vertex: v1, end_vertex: v2}
        - {kind: line, start_vertex: v2, end_vertex: v3}
        - {kind: line, start_vertex: v3, end_vertex: v1}
```

`vertices` are shared endpoints of connected entities (coincident-constrained or
exactly meeting).  `intersection_points` are curve-curve crossings not tied to a
constraint.  `surfaces` are closed regions bounded by entity edges, each edge
referencing vertex IDs from `vertices`.

#### Constraint status (feature-level)

Determined from the Jacobian rank at the solution:

- **`fully_constrained`** — no free degrees of freedom (beyond 3 rigid-body DOF)
- **`underconstrained`** — Jacobian rank < n_params − 3; geometry can still float
- **`overconstrained`** — final residual loss > 1e-4; conflicting constraints

#### Frontend adapter note

The frontend rendering layer (`Geometry3D`) works with a named-field `Sketch` format
(`{ line1: { start: [x,y], end: [x,y] } }`) derived from the flat arrays.  The
`reSolve` function in `Part.tsx` is responsible for this conversion on receipt.
The flat-array server format is intentional — it keeps the server output isomorphic
with the document `initial` field, making merge-back trivial.

The `Visualizer` page (`/visualizer`) is a debug tool that may use a different
response shape; its format is not governed by this spec.

#### Example response

this example is in yaml since it is better readable, the server responds in JSON

```yaml
solve_ms: 1.5
result:
  sketch_1:
    solve_ms: 1.4
    status: fully_constrained
    geometry:  # solve output equal in form to the 'initial'
      line_base:   [0.0, 0.0, 17.32, 0.0]
      line_height: [17.32, 0.0, 17.32, 10.0]
      line_hyp:    [17.32, 10.0, 0.0, 0.0]
    features:
      line_base:
        status: fully_constrained
      line_height:
        status: fully_constrained
      line_hyp:
        status: fully_constrained
  topology:
    vertices:
      _v1: [0.0, 0.0]
      _v2: [17.32, 0.0]
      _v3: [17.32, 10.0]
    intersection_points: {}
    surfaces:
      - boundary:
        - kind: line
          start_vertex: _v1
          end_vertex: _v2
        - kind: line
          start_vertex: _v2
          end_vertex: _v3
        - kind: line
          start_vertex: _v3
          end_vertex: _v1
```
