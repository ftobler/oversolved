import { describe, it, expect } from 'vitest'
import type { PartDoc, PartFeature, PartConstraint } from '@/types/cad'
import { VERTEX_POINT_KEYS } from '@/types/vertexKeys'
import { partDocToSketches } from '../partDocToSketches'
import { addConstraintProblem } from '@/utils/constraintProblems'
import { applyAddConstraint } from '@/utils/yamlMutations'
import type { SketchFeature } from '@/types/cad'

describe('partDocToSketches', () => {
  it('resolves $-form sketch-local refs to dict form', () => {
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        plane: '@builtin_plane_front',
        entities: [
          { id: 'bottom', kind: 'line' },
          { id: 'right', kind: 'line' },
        ],
        initial: { bottom: [0, 0, 10, 0], right: [10, 0, 10, 10] },
        constraints: [
          { id: 'c1', kind: 'coincident', a: '$bottomend', b: '$rightstart' },
          { id: 'c2', kind: 'horizontal', target: '$bottom' },
          { id: 'c3', kind: 'length', target: '$bottom', value: 10 },
        ],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(skipped).toHaveLength(0)
    expect(sketches).toHaveLength(1)
    const c = sketches[0].sketch.constraints
    expect(c[0]).toMatchObject({
      kind: 'coincident',
      a: { entity: 'bottom', point: 'end' },
      b: { entity: 'right', point: 'start' },
    })
    expect(c[1]).toMatchObject({ kind: 'horizontal', target: { entity: 'bottom' } })
    expect(c[2]).toMatchObject({ kind: 'length', target: { entity: 'bottom' }, value: 10 })
  })

  it('disambiguates a minted base64url id ending in a vertex-key word by full-id membership', () => {
    // wire-format-hardening (B1): a minted bare id can itself end in a
    // pure-word suffix. A ref whose FULL string names a known entity resolves
    // as that whole id; a ref whose residual alone names a known entity (the
    // `$pwfYD59xKWiSyQhmcenter` sub-point shape) resolves as eid + point.
    const b64 = 'k-g9YNviFC85Z-7Kxy'
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        plane: '@builtin_plane_front',
        entities: [{ id: b64, kind: 'line' }, { id: 'pwfYD59xKWiSyQhm', kind: 'circle' }],
        initial: { [b64]: [0, 0, 10, 0], pwfYD59xKWiSyQhm: [10, 10, 5] },
        constraints: [
          { id: 'c_bare', kind: 'horizontal', target: `$${b64}` },
          { id: 'c_sub', kind: 'coincident', a: '$pwfYD59xKWiSyQhmcenter', b: '@builtin_origin' },
        ],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(skipped).toHaveLength(0)
    const cs = sketches[0].sketch.constraints
    expect(cs).toHaveLength(2)
    expect(cs[0]).toMatchObject({ kind: 'horizontal', target: { entity: b64 } })
    expect(cs[1]).toMatchObject({
      kind: 'coincident',
      a: { entity: 'pwfYD59xKWiSyQhm', point: 'center' },
    })
  })

  it('drops constraints whose refs do not resolve locally (mirrors historical behavior)', () => {
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'p1', kind: 'point' }],
        initial: { p1: [0, 0] },
        constraints: [
          { id: 'keep', kind: 'fixed', target: '$p1', x: 0, y: 0 },
          // references a non-local / ancestral entity -> dropped
          { id: 'drop', kind: 'coincident', a: '$p1', b: '$nonexistentstart' },
        ],
      },
    ]
    const { sketches } = partDocToSketches(features)
    const ids = sketches[0].sketch.constraints.map((c) => c.id)
    expect(ids).toEqual(['keep'])
  })

  it('drops a point key the target kind does not have and keeps the valid ones', () => {
    // `center` on a line is not an operand: the solver's fallback would bind the
    // line's start, silently turning a centre coincidence into an endpoint
    // one. The row is dropped and named; valid keys on the same sketch stay.
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        plane: '@builtin_plane_front',
        entities: [
          { id: 'L1', kind: 'line' },
          { id: 'C1', kind: 'circle' },
          { id: 'A1', kind: 'arc' },
          { id: 'E1', kind: 'ellipse' },
          { id: 'P1', kind: 'point' },
        ],
        initial: {
          L1: [0, 0, 10, 0], C1: [0, 0, 5], A1: [0, 0, 5, 0, 90],
          E1: [0, 0, 8, 4, 0], P1: [1, 1],
        },
        constraints: [
          { id: 'bad', kind: 'coincident', a: '$L1center', b: '$P1xy' },
          { id: 'circle', kind: 'coincident', a: '$C1center', b: '$P1xy' },
          { id: 'arc', kind: 'coincident', a: '$A1start', b: '$P1xy' },
          { id: 'ellipse', kind: 'point_distance', a: '$E1center', b: '$E1major1', value: 8 },
        ],
      },
    ]
    const { sketches } = partDocToSketches(features)
    // A plain entity has no source to re-project, so the reason carries no
    // remedy sentence.
    expect(sketches[0].droppedConstraints).toEqual([
      { id: 'bad', kind: 'coincident', reason: 'operand center not on line' },
    ])
    expect(sketches[0].sketch.constraints.map(c => c.id)).toEqual(['circle', 'arc', 'ellipse'])
  })

  it('keeps a fit spline interior point and rejects a key its block does not carry', () => {
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        plane: '@builtin_plane_front',
        entities: [{ id: 'F1', kind: 'fit_spline' }, { id: 'P1', kind: 'point' }],
        // Four fit points, no handles: start, fit1, fit2, end.
        initial: { F1: [0, 0, 5, 5, 10, 0, 15, 5], P1: [1, 1] },
        constraints: [
          { id: 'fitted', kind: 'coincident', a: '$F1fit1', b: '$P1xy' },
          { id: 'bad', kind: 'coincident', a: '$F1fit3', b: '$P1xy' },
        ],
      },
    ]
    const { sketches } = partDocToSketches(features)
    expect(sketches[0].droppedConstraints).toEqual([
      { id: 'bad', kind: 'coincident', reason: 'operand fit3 not on fit_spline' },
    ])
    expect(sketches[0].sketch.constraints.map(c => c.id)).toEqual(['fitted'])
  })

  it('drops a coincident whose center key the resolved spline lacks', () => {
    // The arc -> spline half of the kind change: a spline has no `center`, so
    // the row cannot bind one. Dropping it is what keeps the solver's fallback
    // (the spline's midpoint) from reading as a solved coincidence.
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        plane: '@builtin_plane_front',
        entities: [{ id: 'S1', kind: 'spline' }, { id: 'P1', kind: 'point' }],
        initial: { S1: [0, 0, 5, 5, 10, 5, 15, 0], P1: [3, 4] },
        constraints: [
          { id: 'cc', kind: 'coincident', a: '$P1xy', b: '$S1center' },
          { id: 'start', kind: 'coincident', a: '$P1xy', b: '$S1start' },
        ],
      },
    ]
    const { sketches } = partDocToSketches(features)
    expect(sketches[0].droppedConstraints).toEqual([
      { id: 'cc', kind: 'coincident', reason: 'operand center not on spline' },
    ])
    // `start` survives: a spline still has it.
    expect(sketches[0].sketch.constraints.map(c => c.id)).toEqual(['start'])
  })

  it('names the project-as-point remedy only for a projected entity', () => {
    // The same lost key on an entity a `projection` holds can be kept by
    // projecting the source's centre as a declared point, so only that row names
    // the remedy. A plain entity has no source to re-aim.
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        plane: '@builtin_plane_front',
        entities: [{ id: 'S1', kind: 'spline' }, { id: 'P1', kind: 'point' }],
        initial: { S1: [0, 0, 5, 5, 10, 5, 15, 0], P1: [3, 4] },
        constraints: [
          { id: 'proj', kind: 'projection', target: '$S1', source: '?edge;circle' },
          { id: 'cc', kind: 'coincident', a: '$P1xy', b: '$S1center' },
        ],
      },
    ]
    const { sketches } = partDocToSketches(features)
    expect(sketches[0].droppedConstraints).toEqual([
      {
        id: 'cc', kind: 'coincident',
        reason: 'operand center not on spline; project the center as a point to keep it',
      },
    ])
  })

  it('keeps the two-point horizontal/vertical form on whole point entities', () => {
    // Horizontal/vertical are overloaded: the one-entity form is a line, but the
    // a/b form compares two points resolved through `point()`, where a whole
    // point entity IS the point. Judged by role, not by operand kind alone. A
    // whole non-point entity in the pair is the degenerate pick
    // `dropDeadAxisConstraints` prunes, so it is dropped here too.
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        plane: '@builtin_plane_front',
        entities: [
          { id: 'P1', kind: 'point' }, { id: 'P2', kind: 'point' }, { id: 'C1', kind: 'circle' },
        ],
        initial: { P1: [0, 0], P2: [0, 5], C1: [2, 2, 1] },
        constraints: [
          { id: 'v_pair', kind: 'vertical', a: '$P1', b: '$P2' },
          { id: 'v_dead', kind: 'vertical', a: '$C1', b: '$P1' },
          { id: 'h_target', kind: 'horizontal', target: '$P1' },
        ],
      },
    ]
    const { sketches } = partDocToSketches(features)
    // The point pair lowers; the dead pair and the single-target-on-a-point drop.
    expect(sketches[0].sketch.constraints.map(c => c.id)).toEqual(['v_pair'])
    expect(sketches[0].droppedConstraints).toEqual([
      { id: 'v_dead', kind: 'vertical', reason: 'vertical does not apply to circle and point' },
      { id: 'h_target', kind: 'horizontal', reason: 'horizontal does not apply to point' },
    ])
  })

  it('lowers the vertical pair the add-time rule authors for two point entities', () => {
    // The parity the table claims, end to end: what `addConstraintProblem`
    // accepts for a whole point pair is exactly what the lowering keeps.
    const doc: PartDoc = {
      version: 1,
      kind: 'part',
      features: [{
        id: 'sk1',
        kind: 'sketch',
        plane: '@builtin_plane_front',
        entities: [{ id: 'P1', kind: 'point' }, { id: 'P2', kind: 'point' }],
        initial: { P1: [0, 0], P2: [0, 5] },
        constraints: [],
      }],
    }
    applyAddConstraint(doc, 'sk1', 'vertical', ['entity:sk1:P1', 'entity:sk1:P2'])
    const row = (doc.features![0] as SketchFeature).constraints![0]
    expect(row).toMatchObject({ kind: 'vertical', a: '$P1', b: '$P2' })
    const { sketches } = partDocToSketches(doc.features)
    expect(sketches[0].droppedConstraints).toEqual([])
    expect(sketches[0].sketch.constraints).toEqual([
      { id: row.id, kind: 'vertical', a: { entity: 'P1' }, b: { entity: 'P2' } },
    ])
  })

  it('drops a constraint kind the target entity kind cannot take', () => {
    // The kind-applicability half, read from the registry table the add-time
    // guards use: a point is not a line, an ellipse has no length or radius, and
    // a line and an ellipse share no measure for `equal_length`.
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        plane: '@builtin_plane_front',
        entities: [
          { id: 'L1', kind: 'line' }, { id: 'P1', kind: 'point' },
          { id: 'E1', kind: 'ellipse' }, { id: 'A1', kind: 'arc' },
        ],
        initial: { L1: [0, 0, 10, 0], P1: [1, 1], E1: [0, 0, 8, 4, 0], A1: [0, 0, 5, 0, 90] },
        constraints: [
          { id: 'h_point', kind: 'horizontal', target: '$P1' },
          { id: 'len_arc', kind: 'length', target: '$A1', value: 5 },
          { id: 'dia_ellipse', kind: 'diameter', target: '$E1', value: 8 },
          { id: 'equal_mixed', kind: 'equal_length', a: '$L1', b: '$E1' },
          { id: 'keep_h', kind: 'horizontal', target: '$L1' },
          { id: 'keep_equal', kind: 'equal_length', a: '$A1', b: '$A1' },
          { id: 'keep_center', kind: 'coincident', a: '$E1center', b: '$P1xy' },
          // An ellipse shares its centre with a circle or an arc, so a concentric
          // on a projection that tilted to an ellipse keeps its row.
          { id: 'keep_concentric', kind: 'concentric', a: '$E1', b: '$A1' },
        ],
      },
    ]
    const { sketches } = partDocToSketches(features)
    expect(sketches[0].droppedConstraints).toEqual([
      { id: 'h_point', kind: 'horizontal', reason: 'horizontal does not apply to point' },
      { id: 'len_arc', kind: 'length', reason: 'length does not apply to arc' },
      { id: 'dia_ellipse', kind: 'diameter', reason: 'diameter does not apply to ellipse' },
      { id: 'equal_mixed', kind: 'equal_length', reason: 'equal_length does not apply to line and ellipse' },
    ])
    // A centre key on a kind that has one is untouched: the gate only refuses
    // the operands the current kind cannot take.
    expect(sketches[0].sketch.constraints.map(c => c.id))
      .toEqual(['keep_h', 'keep_equal', 'keep_center', 'keep_concentric'])
  })

  it('the add-time refusal and the solve-time drop name the same sentence', () => {
    // One table, two readers, with no projection in play: the declared kind and
    // the resolved kind are the same ellipse, so both must refuse it in the same
    // words. A projection whose kind resolves away from its declaration is the
    // solve's report, not an add-time refusal (see the table header).
    const feature: SketchFeature = {
      id: 'sk1',
      kind: 'sketch',
      plane: '@builtin_plane_front',
      entities: [{ id: 'E1', kind: 'ellipse' }],
      initial: { E1: [0, 0, 8, 4, 0] },
      constraints: [{ id: 'd', kind: 'diameter', target: '$E1', value: 8 }],
    }
    const drop = partDocToSketches([feature]).sketches[0].droppedConstraints
    expect(drop).toEqual([{ id: 'd', kind: 'diameter', reason: 'diameter does not apply to ellipse' }])
    expect(addConstraintProblem(feature, 'diameter', ['$E1'], 8)).toBe(drop[0].reason)
  })

  it('never edits the document rows it drops', () => {
    // A kind round trip (back to the kind the row was authored for) re-enables
    // the row on the next solve only if the lowering left it in the document.
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        plane: '@builtin_plane_front',
        entities: [{ id: 'E1', kind: 'ellipse' }],
        initial: { E1: [0, 0, 8, 4, 0] },
        constraints: [{ id: 'd', kind: 'diameter', target: '$E1', value: 8 }],
      },
    ]
    const before = JSON.stringify(features)
    expect(partDocToSketches(features).sketches[0].sketch.constraints).toEqual([])
    expect(JSON.stringify(features)).toBe(before)
  })

  it('skips center_rect sketches', () => {
    const features: PartFeature[] = [
      {
        id: 'sugar',
        kind: 'sketch',
        entities: [{ id: 'r1', kind: 'center_rect' }],
        initial: {},
        constraints: [],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(sketches).toHaveLength(0)
    expect(skipped.map((s) => s.featureId).sort()).toEqual(['sugar'])
  })

  it('resolves @builtin_origin to external_xy:[0,0]', () => {
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'c1', kind: 'circle' }],
        initial: { c1: [0, 0, 5] },
        constraints: [
          { id: 'c_coincident', kind: 'coincident', a: '$c1center', b: '@builtin_origin' },
          { id: 'c_diameter', kind: 'diameter', target: '$c1', value: 10 },
        ],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(skipped).toHaveLength(0)
    expect(sketches).toHaveLength(1)
    const c = sketches[0].sketch.constraints
    expect(c).toHaveLength(2)
    expect(c[0]).toMatchObject({
      kind: 'coincident',
      a: { entity: 'c1', point: 'center' },
      b: { external_xy: [0, 0] },
    })
    expect(c[1]).toMatchObject({ kind: 'diameter', target: { entity: 'c1' }, value: 10 })
  })

  it('resolves @builtin_origin to the projected originLocal on an offset plane', () => {
    // On a sketch whose plane does not pass through the document origin, the
    // origin lives at nonzero local 2D coords. The lowering must carry those, or
    // a coincident-to-origin pins to the plane's local (0,0) -- a different 3D
    // point ("line constrained to origin" bug).
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'c1', kind: 'circle' }],
        initial: { c1: [0, 0, 5] },
        constraints: [
          { id: 'c_coincident', kind: 'coincident', a: '$c1center', b: '@builtin_origin' },
        ],
      },
    ]
    const { sketches } = partDocToSketches(features, [3, -7])
    expect(sketches[0].sketch.constraints[0]).toMatchObject({
      kind: 'coincident',
      a: { entity: 'c1', point: 'center' },
      b: { external_xy: [3, -7] },
    })
  })

  it('expands an ngon sugar constraint to equal_length + angle (not dropped)', () => {
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [
          { id: 'l0', kind: 'line' }, { id: 'l1', kind: 'line' },
          { id: 'l2', kind: 'line' }, { id: 'l3', kind: 'line' },
        ],
        initial: { l0: [1, 0, 0, 1], l1: [0, 1, -1, 0], l2: [-1, 0, 0, -1], l3: [0, -1, 1, 0] },
        constraints: [
          { id: 'ng', kind: 'ngon', refs: ['$l0', '$l1', '$l2', '$l3'] },
        ],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(skipped).toHaveLength(0)
    const cs = sketches[0].sketch.constraints
    // 4 sides -> 3 equal_length + (4-3)=1 angle; no raw `ngon` survives.
    expect(cs.filter((c) => c.kind === 'ngon')).toHaveLength(0)
    expect(cs.filter((c) => c.kind === 'equal_length')).toHaveLength(3)
    const angles = cs.filter((c) => c.kind === 'angle')
    expect(angles).toHaveLength(1)
    expect(angles[0]).toMatchObject({ value: 90, a: { entity: 'l0' }, b: { entity: 'l1' } })
    expect(cs[0]).toMatchObject({ kind: 'equal_length', a: { entity: 'l0' }, b: { entity: 'l1' } })
  })

  // A hexagon with its construction circumcircle, in the stored wire form.
  function centeredHexagon(withCircle: boolean): SketchFeature[] {
    const ids = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5']
    const initial: Record<string, number[]> = { circ: [0, 0, 10] }
    ids.forEach((id, i) => {
      const a1 = (i / 6) * 2 * Math.PI, a2 = ((i + 1) / 6) * 2 * Math.PI
      initial[id] = [10 * Math.cos(a1), 10 * Math.sin(a1), 10 * Math.cos(a2), 10 * Math.sin(a2)]
    })
    const ngon: PartConstraint = { id: 'ng', kind: 'ngon', refs: ids.map(id => `$${id}`) }
    if (withCircle) ngon.circle = '$circ'
    return [{
      id: 'sk1',
      kind: 'sketch',
      entities: [...ids.map(id => ({ id, kind: 'line' })), { id: 'circ', kind: 'circle', construction: true }],
      initial,
      constraints: [ngon],
    }]
  }

  it('an ngon with a circle lowers to the old primitives plus three vertex-on-circle pins', () => {
    const cs = partDocToSketches(centeredHexagon(true)).sketches[0].sketch.constraints
    expect(cs.filter((c) => c.kind === 'equal_length')).toHaveLength(5)
    expect(cs.filter((c) => c.kind === 'angle')).toHaveLength(3)
    const pins = cs.filter((c) => c.kind === 'coincident')
    // Three concyclic points fix a circle: spread over the polygon (0, N/3, 2N/3)
    // so the pins stay well conditioned.
    expect(pins).toEqual([
      { id: 'ng_on0', kind: 'coincident', a: { entity: 'l0', point: 'start' }, b: { entity: 'circ' } },
      { id: 'ng_on1', kind: 'coincident', a: { entity: 'l2', point: 'start' }, b: { entity: 'circ' } },
      { id: 'ng_on2', kind: 'coincident', a: { entity: 'l4', point: 'start' }, b: { entity: 'circ' } },
    ])
  })

  it('a triangle pins all three of its vertices', () => {
    const features: PartFeature[] = [{
      id: 'sk1',
      kind: 'sketch',
      entities: [{ id: 'a', kind: 'line' }, { id: 'b', kind: 'line' }, { id: 'c', kind: 'line' }, { id: 'o', kind: 'circle' }],
      initial: { a: [1, 0, 0, 1], b: [0, 1, -1, 0], c: [-1, 0, 1, 0], o: [0, 0, 1] },
      constraints: [{ id: 'ng', kind: 'ngon', refs: ['$a', '$b', '$c'], circle: '$o' }],
    }]
    const pins = partDocToSketches(features).sketches[0].sketch.constraints.filter((c) => c.kind === 'coincident')
    expect(pins.map((c) => (c.a as { entity: string }).entity)).toEqual(['a', 'b', 'c'])
  })

  it('an ngon without a circle (an old document) lowers exactly as before', () => {
    const withOut = partDocToSketches(centeredHexagon(false)).sketches[0].sketch.constraints
    expect(withOut.map((c) => c.kind)).toEqual([
      ...Array(5).fill('equal_length'), ...Array(3).fill('angle'),
    ])
  })

  it('a circle ref that no longer resolves drops only the pins', () => {
    const features = centeredHexagon(true)
    features[0].entities = features[0].entities!.filter((e) => e.id !== 'circ')
    const cs = partDocToSketches(features).sketches[0].sketch.constraints
    expect(cs.map((c) => c.kind)).toEqual([
      ...Array(5).fill('equal_length'), ...Array(3).fill('angle'),
    ])
  })

  it('expands a dock constraint to two coincident-to-locus pins against its host', () => {
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [
          { id: 'circA', kind: 'circle' }, { id: 'circB', kind: 'circle' },
          { id: 'pt', kind: 'point' },
        ],
        initial: { circA: [0, 0, 5], circB: [10, 0, 5], pt: [5, 0] },
        constraints: [
          { id: 'tan', kind: 'tangent', a: '$circA', b: '$circB' },
          { id: 'dk', kind: 'dock', point: '$ptxy', host: 'tan' },
        ],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(skipped).toHaveLength(0)
    const cs = sketches[0].sketch.constraints
    // The tangent survives; the dock becomes two coincidents pinning pt to each
    // curve as a locus (no vertex key on the curve operand). No raw `dock`.
    expect(cs.filter((c) => c.kind === 'dock')).toHaveLength(0)
    expect(cs.filter((c) => c.kind === 'tangent')).toHaveLength(1)
    const coincidents = cs.filter((c) => c.kind === 'coincident')
    expect(coincidents).toHaveLength(2)
    expect(coincidents[0]).toMatchObject({ a: { entity: 'pt', point: 'xy' }, b: { entity: 'circA' } })
    expect(coincidents[1]).toMatchObject({ a: { entity: 'pt', point: 'xy' }, b: { entity: 'circB' } })
    // Locus form: the curve operand carries NO point key.
    expect((coincidents[0].b as { point?: string }).point).toBeUndefined()
  })

  it('drops a dock whose host constraint is gone (fail-soft float)', () => {
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [
          { id: 'circA', kind: 'circle' }, { id: 'circB', kind: 'circle' },
          { id: 'pt', kind: 'point' },
        ],
        initial: { circA: [0, 0, 5], circB: [10, 0, 5], pt: [5, 0] },
        constraints: [
          // host 'tan' was deleted; the dangling dock lowers to nothing so pt
          // floats as an ordinary under-constrained point.
          { id: 'dk', kind: 'dock', point: '$ptxy', host: 'tan' },
        ],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(skipped).toHaveLength(0)
    expect(sketches[0].sketch.constraints).toHaveLength(0)
  })

  it('drops a constraint whose dict ref carries a point name outside VERTEX_POINT_KEYS', () => {
    // A typo'd dict point must not ride through: downstream lowering maps an
    // unknown name to Sel.absent, which the Rust solver reads as whole-curve
    // locus, quietly turning an endpoint-to-point coincident into
    // point-on-curve. Dropped like any other unresolvable ref instead.
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'l1', kind: 'line' }],
        initial: { l1: [0, 0, 10, 0] },
        constraints: [
          { id: 'keep', kind: 'horizontal', target: '$l1' },
          { id: 'drop', kind: 'coincident', a: { entity: 'l1', point: 'strt' }, b: '@builtin_origin' } as unknown as PartConstraint,
        ],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(skipped).toHaveLength(0)
    expect(sketches[0].sketch.constraints.map((c) => c.id)).toEqual(['keep'])
  })

  it('drops a constraint whose dict ref carries a non-string point value', () => {
    // A truthy non-string point is present but not a VERTEX_POINT_KEYS member,
    // so it drops like any other unresolvable ref rather than degrading to
    // bare locus.
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'l1', kind: 'line' }],
        initial: { l1: [0, 0, 10, 0] },
        constraints: [
          { id: 'keep', kind: 'horizontal', target: '$l1' },
          { id: 'drop', kind: 'coincident', a: { entity: 'l1', point: 3 }, b: '@builtin_origin' } as unknown as PartConstraint,
        ],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(skipped).toHaveLength(0)
    expect(sketches[0].sketch.constraints.map((c) => c.id)).toEqual(['keep'])
  })

  it('drops a whole constraint whose present scalar is non-numeric', () => {
    // A present-but-bad scalar must not be stripped and the constraint kept: the
    // Rust side reads a dimension with no value as no residual, so the sketch
    // would silently solve underconstrained. A half-authored x/y pair is the
    // same corruption. All of these drop, mirroring the unresolvable-ref path.
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'l1', kind: 'line' }],
        initial: { l1: [0, 0, 10, 0] },
        constraints: [
          { id: 'keep', kind: 'horizontal', target: '$l1' },
          { id: 'drop_value', kind: 'length', target: '$l1', value: 'ten' } as unknown as PartConstraint,
          { id: 'drop_xy', kind: 'fixed', target: '$l1', x: 1 } as unknown as PartConstraint,
          { id: 'drop_axis', kind: 'fixed', target: '$l1', axis: 4 } as unknown as PartConstraint,
          { id: 'drop_sign', kind: 'distance', target: '$l1', sign: 'plus' } as unknown as PartConstraint,
        ],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(skipped).toHaveLength(0)
    expect(sketches[0].sketch.constraints.map((c) => c.id)).toEqual(['keep'])
  })

  // Each point key is exercised on a kind that can actually carry it: the
  // key-existence gate drops a valid spelling only when the target lacks it
  // (pinned by the test above), so the parser table uses a kind per key.
  const KIND_FOR_POINT_KEY: Record<string, { kind: string; initial: number[] }> = {
    start: { kind: 'spline', initial: [0, 0, 1, 1, 2, 2, 3, 3] },
    end: { kind: 'spline', initial: [0, 0, 1, 1, 2, 2, 3, 3] },
    c1: { kind: 'spline', initial: [0, 0, 1, 1, 2, 2, 3, 3] },
    c2: { kind: 'spline', initial: [0, 0, 1, 1, 2, 2, 3, 3] },
    center: { kind: 'circle', initial: [0, 0, 5] },
    xy: { kind: 'point', initial: [0, 0] },
    major1: { kind: 'ellipse', initial: [0, 0, 8, 4, 0] },
    major2: { kind: 'ellipse', initial: [0, 0, 8, 4, 0] },
    minor1: { kind: 'ellipse', initial: [0, 0, 8, 4, 0] },
    minor2: { kind: 'ellipse', initial: [0, 0, 8, 4, 0] },
  }

  it.each([...VERTEX_POINT_KEYS])('passes dict-ref point %s through unchanged', (pt) => {
    const spec = KIND_FOR_POINT_KEY[pt]
    expect(spec, pt).toBeDefined()
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'e1', kind: spec.kind }],
        initial: { e1: spec.initial },
        constraints: [
          { id: 'c', kind: 'coincident', a: { entity: 'e1', point: pt }, b: '@builtin_origin' } as unknown as PartConstraint,
        ],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(skipped).toHaveLength(0)
    expect(sketches[0].sketch.constraints[0]).toMatchObject({
      kind: 'coincident',
      a: { entity: 'e1', point: pt },
    })
    expect(sketches[0].droppedConstraints).toEqual([])
  })

  it('lowers a two-line colinear to one coincident with the same refs and id', () => {
    // The solver has no colinear kind. Its coincident arm reads two bare lines
    // as the collinear row pair, so the lowering must hand it that rather than
    // pass the kind through (where lowerSketch used to drop it silently).
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'l1', kind: 'line' }, { id: 'pb', kind: 'line' }],
        initial: { l1: [2, 0.3, 5, 0.1], pb: [0, 0, 9, 0] },
        constraints: [{ id: 'cl', kind: 'colinear', a: '$l1', b: '$pb' }],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(skipped).toHaveLength(0)
    expect(sketches[0].droppedConstraints).toEqual([])
    expect(sketches[0].sketch.constraints).toEqual([
      { id: 'cl', kind: 'coincident', a: { entity: 'l1' }, b: { entity: 'pb' } },
    ])
  })

  it('lowers a colinear of a point and a line to the point-on-line coincident, either order', () => {
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'l1', kind: 'line' }, { id: 'p1', kind: 'point' }],
        initial: { l1: [0, 0, 10, 0], p1: [3, 2] },
        constraints: [
          { id: 'cp', kind: 'colinear', a: '$p1xy', b: '$l1' },
          { id: 'cl', kind: 'colinear', a: '$l1', b: '$p1xy' },
        ],
      },
    ]
    const cs = partDocToSketches(features).sketches[0].sketch.constraints
    // The solver's coincident arm picks the point-on-line row from the operand
    // shape, so the pick order the author used is kept as stored.
    expect(cs).toEqual([
      { id: 'cp', kind: 'coincident', a: { entity: 'p1', point: 'xy' }, b: { entity: 'l1' } },
      { id: 'cl', kind: 'coincident', a: { entity: 'l1' }, b: { entity: 'p1', point: 'xy' } },
    ])
  })

  it('accepts a line vertex as the point side of a colinear', () => {
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'l1', kind: 'line' }, { id: 'l2', kind: 'line' }],
        initial: { l1: [0, 0, 10, 0], l2: [2, 2, 6, 4] },
        constraints: [{ id: 'cv', kind: 'colinear', a: '$l1start', b: '$l2' }],
      },
    ]
    const cs = partDocToSketches(features).sketches[0].sketch.constraints
    expect(cs).toEqual([
      { id: 'cv', kind: 'coincident', a: { entity: 'l1', point: 'start' }, b: { entity: 'l2' } },
    ])
  })

  it('drops a colinear whose operands are not two lines or a point and a line', () => {
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [
          { id: 'l1', kind: 'line' }, { id: 'c1', kind: 'circle' },
          { id: 'p1', kind: 'point' }, { id: 'p2', kind: 'point' },
        ],
        initial: { l1: [0, 0, 10, 0], c1: [0, 0, 2], p1: [0, 0], p2: [1, 1] },
        constraints: [
          { id: 'circle_line', kind: 'colinear', a: '$c1', b: '$l1' },
          { id: 'two_points', kind: 'colinear', a: '$p1xy', b: '$p2xy' },
          { id: 'one_operand', kind: 'colinear', a: '$l1' },
          { id: 'keep', kind: 'horizontal', target: '$l1' },
        ],
      },
    ]
    const { sketches } = partDocToSketches(features)
    expect(sketches[0].sketch.constraints.map((c) => c.id)).toEqual(['keep'])
    expect(sketches[0].droppedConstraints).toEqual([
      { id: 'circle_line', kind: 'colinear', reason: 'colinear needs two lines or a point and a line' },
      { id: 'two_points', kind: 'colinear', reason: 'colinear needs two lines or a point and a line' },
      { id: 'one_operand', kind: 'colinear', reason: 'colinear needs two lines or a point and a line' },
    ])
  })

  it('reports a colinear stale ref as a stale reference, not as a shape error', () => {
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'l1', kind: 'line' }],
        initial: { l1: [0, 0, 10, 0] },
        constraints: [{ id: 'cl', kind: 'colinear', a: '$ghost', b: '$l1' }],
      },
    ]
    const { sketches } = partDocToSketches(features)
    expect(sketches[0].sketch.constraints).toEqual([])
    expect(sketches[0].droppedConstraints).toEqual([
      { id: 'cl', kind: 'colinear', reason: 'stale reference' },
    ])
  })

  it('ignores non-sketch features', () => {
    const features: PartFeature[] = [
      { id: 'ex1', kind: 'extrude', extrude: undefined } as unknown as PartFeature,
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(sketches).toHaveLength(0)
    expect(skipped).toHaveLength(0)
  })

  it('judges an entity on the resolved kind supplied by SketchProjectionFacts', () => {
    const features = [{
      id: 'sk1',
      kind: 'sketch',
      plane: '@builtin_plane_front',
      entities: [{ id: 'e', kind: 'circle' }],
      initial: { e: [0, 0, 5] },
      constraints: [{ id: 'd', kind: 'diameter', target: '$e', value: 10 }],
    }] as unknown as PartFeature[]
    const { sketches } = partDocToSketches(features, [0, 0], [], {
      resolvedKinds: { e: 'line' },
    })
    expect(sketches[0].sketch.entities).toEqual([{ id: 'e', kind: 'line', construction: undefined, handles: undefined }])
    expect(sketches[0].droppedConstraints).toEqual([
      { id: 'd', kind: 'diameter', reason: 'diameter does not apply to line' },
    ])
  })

  it('takes a derived member arity from derivedInitial', () => {
    const feature = {
      id: 'sk1',
      kind: 'sketch',
      plane: '@builtin_plane_front',
      entities: [],
      initial: {},
      constraints: [{ id: 'c', kind: 'coincident', a: { entity: 'm', point: 'fit2' }, b: '@builtin_origin' }],
    } as unknown as PartFeature
    // A three-point fit spline has no fit2 key; a five-point one does.
    const short = partDocToSketches([feature], [0, 0], [], {
      derivedKinds: { m: 'fit_spline' },
      derivedInitial: { m: [0, 0, 1, 1, 2, 2] },
    })
    expect(short.sketches[0].droppedConstraints).toEqual([
      { id: 'c', kind: 'coincident', reason: 'operand fit2 not on fit_spline' },
    ])
    const long = partDocToSketches([feature], [0, 0], [], {
      derivedKinds: { m: 'fit_spline' },
      derivedInitial: { m: [0, 0, 1, 1, 2, 2, 3, 3, 4, 4] },
    })
    expect(long.sketches[0].droppedConstraints).toEqual([])
    expect(long.sketches[0].sketch.entities).toContainEqual({ id: 'm', kind: 'fit_spline', construction: undefined, handles: undefined })
    expect(long.sketches[0].sketch.initial.m).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4])
  })
})
