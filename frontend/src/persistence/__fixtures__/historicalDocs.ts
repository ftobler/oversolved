// Golden documents, one per historical shape the loader must still read. Each
// text is written the way the version that produced it wrote it, stale keys
// included; the docSchema suites load them and snapshot the migrated result.

export interface HistoricalDocument {
  name: string
  // What the shape predates, for the test's own reporting.
  note: string
  text: string
}

// The pre-versioning part: no `version`, a sketch carrying a degenerate
// vertical (bugreports/weird_constraint_20260621_214037.md), transform and
// delete_body with the singular `body` pick (pluralized 2026-07), and an
// import_step whose inline payload was lifted by the workspace migration but
// whose `file_data` survived a crash between the two writes.
export const LEGACY_V0_PART: HistoricalDocument = {
  name: 'legacy part',
  note: 'pre-versioning heals: dead axis constraint, singular body picks, stale inline payload',
  text: `features:
  - id: sk1
    kind: sketch
    initial:
      line1: [0, 0, 10, 0]
      circ1: [5, 5, 3]
    entities:
      - id: line1
        kind: line
      - id: circ1
        kind: circle
    constraints:
      - id: c_dead
        kind: vertical
        a: "$circ1"
        b: "$line1"
      - id: c_ok
        kind: coincident
        a: "$line1start"
        b: "@builtin_origin"
  - id: t1
    kind: transform
    transform:
      body: "@body_ex1"
      operation: new
      translation: [0, 0, 0]
  - id: db1
    kind: delete_body
    delete_body:
      body: "@body_ex1"
  - id: is1
    kind: import_step
    file_id: file-abc
    file_data: "AAA="
`,
}

// A version-stamped document that still carries a pre-versioning shape. The
// stamp predates the fixes, so the ladder must not skip its steps on it.
export const LEGACY_V1_PART: HistoricalDocument = {
  name: 'legacy v1 part',
  note: 'version: 1 does not excuse a legacy shape',
  text: `version: 1
kind: part
features:
  - id: t2
    kind: transform
    transform:
      body: "@body_ex2"
      operation: replace
`,
}

export const CURRENT_PART: HistoricalDocument = {
  name: 'current part',
  note: 'current shape, nothing to migrate',
  text: `version: 1
kind: part
features:
  - id: Origin
    kind: origin
  - id: sk1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      line1: [0, 0, 20, 0]
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c1
        kind: horizontal
        a: "$line1"
  - id: ex1
    kind: extrude
    extrude:
      sketch: ["@sk1"]
      distance: 10
      direction: normal
part_style:
  ex1:
    name: Body
    color: "#4f8a8b"
    visible: true
`,
}

// A document stamped behind the ladder version: the target-3 canonicalization
// steps still run on it (2 < 3) and change nothing, because it is already
// canonical.
export const CURRENT_V2_PART: HistoricalDocument = {
  name: 'current v2 part',
  note: 'stamped one behind the ladder, nothing to migrate',
  text: `version: 2
kind: part
features:
  - id: Origin
    kind: origin
  - id: sk1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      line1: [0, 0, 20, 0]
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c1
        kind: horizontal
        a: "$line1"
`,
}

// A document stamped one behind the current ladder version: the target-4 mate
// offset step still runs on it (3 < 4) and changes nothing, because the flip
// touches assembly documents only.
export const CURRENT_V3_PART: HistoricalDocument = {
  name: 'current v3 part',
  note: 'stamped one behind the ladder, nothing to migrate',
  text: `version: 3
kind: part
features:
  - id: Origin
    kind: origin
  - id: sk1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      line1: [0, 0, 20, 0]
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c1
        kind: horizontal
        a: "$line1"
`,
}

// The stamp at the ladder current version: the ladder must leave such a
// document alone. The literal 4 is cross-checked against CURRENT_DOC_VERSION in
// the load suite, so bumping the loader's version without adding a fixture for
// the new stamp fails loudly instead of silently never exercising the gate.
export const CURRENT_V4_PART: HistoricalDocument = {
  name: 'current v4 part',
  note: 'stamped at the ladder current version, nothing to migrate',
  text: `version: 4
kind: part
features:
  - id: Origin
    kind: origin
  - id: sk1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      line1: [0, 0, 20, 0]
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c1
        kind: horizontal
        a: "$line1"
`,
}

export const CURRENT_ASSEMBLY: HistoricalDocument = {
  name: 'current assembly',
  note: 'current assembly shape',
  text: `kind: assembly
features:
  - id: AssemblyOrigin
    kind: origin
  - id: f1
    kind: part_instance
    instance:
      handle: hA
      doc_id: part-1
      doc_rev: 3
      transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
  - id: m1
    kind: mate
    mate:
      kind: fixed
      label: Fixed 1
      ref_a: { part: "__assembly", anchor: "__assembly/AssemblyOrigin" }
      ref_b: { part: hA, anchor: "hA/origin" }
`,
}

// An assembly stamped at version 3: every offset shape the v4 sign flip has
// to negate on a fixed mate (scalar, full vector, partial vector, expression
// string), plus a tangential offset that must come through untouched because
// only `kind: fixed` changed convention.
export const LEGACY_V3_ASSEMBLY_OFFSETS: HistoricalDocument = {
  name: 'legacy v3 assembly offsets',
  note: 'fixed-mate offsets negate to the plus convention, tangential offset does not',
  text: `version: 3
kind: assembly
features:
  - id: AssemblyOrigin
    kind: origin
  - id: f1
    kind: part_instance
    instance:
      handle: hA
      doc_id: part-1
      doc_rev: 3
      transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
  - id: m_scalar
    kind: mate
    mate:
      kind: fixed
      ref_a: { part: "__assembly", anchor: "__assembly/AssemblyOrigin" }
      ref_b: { part: hA, anchor: "hA/origin" }
      offset: 7
  - id: m_vector
    kind: mate
    mate:
      kind: fixed
      ref_a: { part: "__assembly", anchor: "__assembly/AssemblyOrigin" }
      ref_b: { part: hA, anchor: "hA/origin" }
      offset: { x: 3, y: -4 }
  - id: m_expr
    kind: mate
    mate:
      kind: fixed
      ref_a: { part: "__assembly", anchor: "__assembly/AssemblyOrigin" }
      ref_b: { part: hA, anchor: "hA/origin" }
      offset: "w / 2"
  - id: m_tangential
    kind: mate
    mate:
      kind: tangential
      ref_a: { part: "__assembly", anchor: "__assembly/AssemblyOrigin" }
      ref_b: { part: hA, anchor: "hA/origin" }
      offset: 5
  - id: m_absent
    kind: mate
    mate:
      kind: fixed
      ref_a: { part: "__assembly", anchor: "__assembly/AssemblyOrigin" }
      ref_b: { part: hA, anchor: "hA/origin" }
`,
}

export const ALL_HISTORICAL_PART_DOCS: HistoricalDocument[] = [
  LEGACY_V0_PART,
  LEGACY_V1_PART,
  CURRENT_PART,
  CURRENT_V2_PART,
  CURRENT_V3_PART,
  CURRENT_V4_PART,
]

export const ALL_HISTORICAL_ASSEMBLY_DOCS: HistoricalDocument[] = [
  CURRENT_ASSEMBLY,
  LEGACY_V3_ASSEMBLY_OFFSETS,
]
