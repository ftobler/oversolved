# AST

## High-Level Example

```yaml
oversolve: 1  # version
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
