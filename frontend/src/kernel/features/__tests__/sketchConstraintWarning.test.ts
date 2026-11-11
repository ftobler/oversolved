// @vitest-environment node
//
// The sketch constraint law at the kernel boundary: an underconstrained sketch
// carries its DOF count and the yellow build warning, a fully constrained one
// carries neither, and the drag path never invents a warning (only the cold
// solve runs the status pass). Runs against the real node wasm; skips when the
// gitignored pkg-node build is absent (run `just wasm`).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  prepareDragContext,
  resetSketchSolver,
  setSketchSolver,
  solveSketch,
  solveSketchDrag,
} from '../sketch'
import { applyAddConstraint, applyAddEntity } from '@/utils/yamlMutations/sketch'
import {
  applyAddCenterRect, applyAddNgon, applyAddRect,
} from '@/utils/yamlMutations/sketchSugar'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { initGlobalRepo } from '../../query'
import type { PartDoc, SketchFeature } from '@/types/cad'

const solveBytes = loadSolver()

type Dict = Record<string, unknown>

function emptySketch(label = 'Rectangle'): SketchFeature {
  return {
    id: 'sk1',
    kind: 'sketch',
    label,
    plane: '@builtin_plane_front',
    entities: [],
    initial: {},
    constraints: [],
  } as unknown as SketchFeature
}

function docOf(feature: SketchFeature): PartDoc {
  return { version: 1, kind: 'part', features: [feature] } as unknown as PartDoc
}

const solve = (feature: SketchFeature) =>
  solveSketch(feature as unknown as Dict, initGlobalRepo(), {}, {})

describe.skipIf(solveBytes === null)('sketch constraint warning (real solver)', () => {
  beforeAll(() => {
    if (solveBytes === null) throw new Error('unreachable: skipIf guards the suite')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })
  afterAll(() => resetSketchSolver())

  it('reports a bare rectangle as underconstrained with its DOF and its free lines', () => {
    const feature = emptySketch()
    applyAddRect(docOf(feature), 'sk1', [0, 0], [40, 30], null, null, ['l1', 'l2', 'l3', 'l4'])

    const out = solve(feature)
    expect(out.status).toBe('underconstrained')
    expect(out.dof).toBe(4)
    // The rectangle constrains its shape but not its size or position: all four
    // lines are free.
    expect(out.solver_warning).toBe(
      'Underconstrained: 4 degrees of freedom. Free: l1, l2, l3, l4.',
    )
  })

  it('is fully constrained when the same rectangle is anchored and dimensioned', () => {
    const feature = emptySketch()
    const doc = docOf(feature)
    applyAddRect(doc, 'sk1', [0, 0], [40, 30], '@builtin_origin', null, ['l1', 'l2', 'l3', 'l4'])
    // add_rect names the lines bottom, right, top, left.
    applyAddConstraint(doc, 'sk1', 'length', ['entity:sk1:l1'], 40)
    applyAddConstraint(doc, 'sk1', 'length', ['entity:sk1:l2'], 30)

    const out = solve(feature)
    expect(out.status).toBe('fully_constrained')
    expect(out.dof).toBe(0)
    expect(out.solver_warning).toBeUndefined()
  })

  it('lists five free ids and the remainder count for a larger free set', () => {
    const feature = emptySketch('Holes')
    const entities = feature.entities as Array<{ id: string; kind: string }>
    const initial = feature.initial as Record<string, number[]>
    for (let i = 0; i < 7; i++) {
      entities.push({ id: `p${i + 1}`, kind: 'point' })
      initial[`p${i + 1}`] = [i, 0]
    }

    const out = solve(feature)
    expect(out.status).toBe('underconstrained')
    expect(out.dof).toBe(14)
    expect(out.solver_warning).toBe(
      'Underconstrained: 14 degrees of freedom. Free: p1, p2, p3, p4, p5 and 2 more.',
    )
  })

  it('anchors and dimensions a rectangle from its one-step sugar', () => {
    // Phase 3's incentive: `dimensions` plus an anchor ref must close every
    // DOF without a follow-up add_constraint per side.
    const feature = emptySketch()
    applyAddRect(docOf(feature), 'sk1', [0, 0], [40, 30], '@builtin_origin', null, ['l1', 'l2', 'l3', 'l4'], true)

    const out = solve(feature)
    expect(out.status).toBe('fully_constrained')
    expect(out.dof).toBe(0)
    expect(out.solver_warning).toBeUndefined()
  })

  it('anchors and dimensions a centre rectangle from its one-step sugar', () => {
    const feature = emptySketch()
    applyAddCenterRect(
      docOf(feature), 'sk1', [0, 0], [20, 15], '@builtin_origin', null,
      ['l1', 'l2', 'l3', 'l4', 'p1'], true,
    )

    const out = solve(feature)
    expect(out.status).toBe('fully_constrained')
    expect(out.dof).toBe(0)
  })

  it('anchors and dimensions an n-gon from its one-step sugar', () => {
    const feature = emptySketch('Hexagon')
    const lines = Array.from({ length: 6 }, (_, i) => `l${i + 1}`)
    applyAddNgon(
      docOf(feature), 'sk1', [0, 0], [10, 0], 6, null, '@builtin_origin',
      [...lines, 'c1'], true,
    )

    const out = solve(feature)
    expect(out.status).toBe('fully_constrained')
    expect(out.dof).toBe(0)
  })

  it('dimensions a circle radius, leaving only its centre to anchor', () => {
    const feature = emptySketch('Hole')
    const doc = docOf(feature)
    applyAddEntity(doc, 'sk1', 'circle', [0, 0, 5], 'c1', undefined, true)
    applyAddConstraint(doc, 'sk1', 'coincident', ['vertex:sk1:c1:center', '@builtin_origin'])

    const out = solve(feature)
    expect(out.status).toBe('fully_constrained')
    expect(out.dof).toBe(0)
  })

  it('does not overconstrain a rectangle pinned by both corner refs', () => {
    // Both refs already fix the four DOF; the sugar must skip its dimensions.
    const feature = emptySketch()
    const doc = docOf(feature)
    const entities = feature.entities as Array<{ id: string; kind: string }>
    const initial = feature.initial as Record<string, number[]>
    entities.push({ id: 'p1', kind: 'point' })
    initial.p1 = [40, 30]
    applyAddConstraint(doc, 'sk1', 'point_distance_x', ['vertex:sk1:p1:xy', '@builtin_origin'], 40, undefined, -1)
    applyAddConstraint(doc, 'sk1', 'point_distance_y', ['vertex:sk1:p1:xy', '@builtin_origin'], 30, undefined, -1)
    applyAddRect(doc, 'sk1', [0, 0], [40, 30], '@builtin_origin', 'vertex:sk1:p1:xy', ['l1', 'l2', 'l3', 'l4'], true)

    const out = solve(feature)
    expect(out.status).toBe('fully_constrained')
    expect(out.dof).toBe(0)
  })

  it('does not overconstrain an n-gon pinned by both centre and corner refs', () => {
    const feature = emptySketch('Hexagon')
    const doc = docOf(feature)
    const entities = feature.entities as Array<{ id: string; kind: string }>
    const initial = feature.initial as Record<string, number[]>
    entities.push({ id: 'p1', kind: 'point' })
    initial.p1 = [10, 0]
    applyAddConstraint(doc, 'sk1', 'point_distance_x', ['vertex:sk1:p1:xy', '@builtin_origin'], 10, undefined, -1)
    applyAddConstraint(doc, 'sk1', 'point_distance_y', ['vertex:sk1:p1:xy', '@builtin_origin'], 0, undefined, -1)
    const lines = Array.from({ length: 6 }, (_, i) => `l${i + 1}`)
    applyAddNgon(
      doc, 'sk1', [0, 0], [10, 0], 6, 'vertex:sk1:p1:xy', '@builtin_origin',
      [...lines, 'c1'], true,
    )

    const out = solve(feature)
    expect(out.status).toBe('fully_constrained')
    expect(out.dof).toBe(0)
  })

  it('reports a dropped constraint on an otherwise fully constrained sketch', () => {
    const feature = emptySketch('Hole')
    const doc = docOf(feature)
    applyAddEntity(doc, 'sk1', 'circle', [0, 0, 5], 'c1', undefined, true)
    applyAddConstraint(doc, 'sk1', 'coincident', ['vertex:sk1:c1:center', '@builtin_origin'])
    // A Length names a line; on a circle centre the solver has no slot to read,
    // so it drops the row. The sketch is still fully constrained by the
    // diameter and the centre pin, and the drop is still a warning.
    applyAddConstraint(doc, 'sk1', 'length', ['vertex:sk1:c1:center'], 3)

    const out = solve(feature)
    expect(out.status).toBe('fully_constrained')
    expect(out.solver_warning).toMatch(
      /^constraint c_length_\S+ \(length\) names operands it cannot use \(operand kind\) and was ignored$/,
    )
  })

  it('keeps the underconstrained and dropped warnings together', () => {
    const feature = emptySketch()
    const doc = docOf(feature)
    applyAddRect(doc, 'sk1', [0, 0], [40, 30], null, null, ['l1', 'l2', 'l3', 'l4'])
    // A Length on a point entity is unreadable; the rectangle still needs its
    // size and anchor, so both facts ride the same field.
    applyAddEntity(doc, 'sk1', 'point', [5, 5], 'p1')
    applyAddConstraint(doc, 'sk1', 'length', ['vertex:sk1:p1:xy'], 1)

    const out = solve(feature)
    expect(out.status).toBe('underconstrained')
    expect(out.solver_warning).toContain('Underconstrained:')
    expect(out.solver_warning).toContain('names operands it cannot use')
  })

  it('never puts the warning on a drag solve', () => {
    const feature = emptySketch()
    applyAddRect(docOf(feature), 'sk1', [0, 0], [40, 30], null, null, ['l1', 'l2', 'l3', 'l4'])
    const ctx = prepareDragContext(feature, 'l1', 'start')
    expect(ctx).not.toBeNull()
    const drag = solveSketchDrag(ctx!, ctx!.params0, [1, 1])
    expect(drag).not.toBeNull()
    expect(drag!.status).toBe('underconstrained')
    expect(drag).not.toHaveProperty('solver_warning')
  })
})
