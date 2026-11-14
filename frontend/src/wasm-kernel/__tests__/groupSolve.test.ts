// @vitest-environment node
//
// The Group constraint on the real Rust solver, through the same lowering the
// app runs: a group over a line and a circle leaves the sketch at 3 DOF (two
// translations and a rotation), a coincident to the origin projection leaves
// the rotation, an ordinary horizontal on a member line closes it and translates
// both entities rigidly, and a length that disagrees with the held shape is a
// conflict.
//
// Skips when the Rust solver build is absent.
import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { loadSolver } from '../loadSolver'
import { lowerSketch } from '../lowerSketch'
import { encodeInput, decodeOutput, Status, type SolverOutput } from '../codec'
import { partDocToSketches } from '../partDocToSketches'
import { applyAddConstraint, applyImportDxf } from '@/utils/yamlMutations'

const bytes = loadSolver()

function groupedDoc(): PartDoc {
  const feature: SketchFeature = {
    id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
    entities: [{ id: 'l1', kind: 'line' }, { id: 'c1', kind: 'circle' }],
    initial: { l1: [2, 3, 6, 3], c1: [10, 3, 2.5] },
    constraints: [{ id: 'g1', kind: 'group', refs: ['$l1', '$c1'] }],
  }
  return { features: [feature] }
}

function solve(doc: PartDoc): { out: SolverOutput; params: Record<string, number[]> } {
  const { sketches, skipped } = partDocToSketches(doc.features)
  expect(skipped).toHaveLength(0)
  const { input, layout } = lowerSketch(sketches[0].sketch)
  const out = decodeOutput(bytes!(encodeInput(input)))
  const params: Record<string, number[]> = {}
  for (const l of layout) params[l.id] = out.paramsSolved.slice(l.offset, l.offset + l.size)
  return { out, params }
}

describe.skipIf(!bytes)('group on the real solver', () => {
  it('leaves 3 DOF; a pinned coincident leaves 1 and a horizontal closes the turn', () => {
    const doc = groupedDoc()
    const free = solve(doc)
    expect(free.out.overallStatus).toBe(Status.underconstrained)
    // Two translations and one rotation.
    expect(free.out.diagnostics.dof).toBe(3)
    expect(free.out.diagnostics.residualNorm).toBeLessThan(1e-6)
    expect(free.params.l1).toEqual([2, 3, 6, 3])
    expect(free.params.c1).toEqual([10, 3, 2.5])

    // Pin the line's start to the document origin: the group may still turn.
    applyAddConstraint(doc, 'sk', 'coincident', ['vertex:sk:l1:start', '@builtin_origin'])
    const pinned = solve(doc)
    expect(pinned.out.overallStatus).toBe(Status.underconstrained)
    expect(pinned.out.diagnostics.dof).toBe(1)
    // (2,3) -> (0,0) is one translation for every member; the free turn may
    // settle anywhere, so only the rigid shape is fixed.
    expect(pinned.params.l1[0]).toBeCloseTo(0, 6)
    expect(pinned.params.l1[1]).toBeCloseTo(0, 6)
    const length = (p: number[]) => Math.hypot(p[2] - p[0], p[3] - p[1])
    expect(length(pinned.params.l1)).toBeCloseTo(4, 6)
    expect(pinned.params.c1[2]).toBeCloseTo(2.5, 6)
    expect(Math.hypot(
      pinned.params.c1[0] - pinned.params.l1[0],
      pinned.params.c1[1] - pinned.params.l1[1],
    )).toBeCloseTo(8, 6)

    // An ordinary horizontal on a member line stops the turn.
    applyAddConstraint(doc, 'sk', 'horizontal', ['entity:sk:l1'])
    const closed = solve(doc)
    expect(closed.out.overallStatus).toBe(Status.fully_constrained)
    expect(closed.out.diagnostics.dof).toBe(0)
    expect(closed.params.l1[3]).toBeCloseTo(0, 6)
  })

  it('loads an existing group at its stored shape and only the DOF moved', () => {
    // Every group in an old document is 3 DOF on load. A cold solve holds the
    // stored shape as the reference, so the geometry is unchanged.
    const doc: PartDoc = {
      features: [{
        id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [{ id: 'a', kind: 'arc' }, { id: 'e', kind: 'ellipse' }],
        initial: { a: [0, 0, 3, 20, 130], e: [12, 4, 4, 2, 30] },
        constraints: [{ id: 'g1', kind: 'group', refs: ['$a', '$e'] }],
      }],
    }
    const { out, params } = solve(doc)
    expect(out.diagnostics.dof).toBe(3)
    expect(out.diagnostics.residualNorm).toBeLessThan(1e-6)
    expect(params.a[3]).toBeCloseTo(20, 6)
    expect(params.a[4]).toBeCloseTo(130, 6)
    expect(params.e[4]).toBeCloseTo(30, 6)
  })

  it('a length that disagrees with the held shape is overconstrained', () => {
    const doc = groupedDoc()
    applyAddConstraint(doc, 'sk', 'length', ['entity:sk:l1'], 10)
    const out = solve(doc).out
    expect(out.overallStatus).toBe(Status.overconstrained)
    // Wire order: the two group pieces, the length, then the implicit origin
    // pin. The conflicting length carries a nonzero miss.
    expect(out.constraintMiss[2]).toBeGreaterThan(0)
  })

  it('a spline grouped by c1 and c2 holds their distance when c1 is dragged', () => {
    const doc: PartDoc = {
      features: [{
        id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [{ id: 'sp', kind: 'spline' }],
        initial: { sp: [0, 0, 1, 2, 3, 4, 5, 6] },
        constraints: [{ id: 'g1', kind: 'group', refs: ['$spc1', '$spc2'] }],
      }],
    }
    const { sketches, skipped } = partDocToSketches(doc.features)
    expect(skipped).toHaveLength(0)
    const { input, layout } = lowerSketch(sketches[0].sketch)
    const off = layout.find(l => l.id === 'sp')!.offset
    const reference = [...input.params]
    input.params[off + 2] += 2
    input.params[off + 3] -= 1
    input.paramsReference = reference
    // The drag holds the point under the cursor; without the pin the solve may
    // split the translation between the two points.
    input.pinnedMask = [0b0000_1100]
    const out = decodeOutput(bytes!(encodeInput(input)))
    expect(out.overallStatus).toBe(Status.underconstrained)
    const p = out.paramsSolved
    const pair = (q: number[]) => Math.hypot(q[off + 4] - q[off + 2], q[off + 5] - q[off + 3])
    // The dragged control point moved and the pair kept its length: the offset
    // may now point anywhere, which is the group's free turn.
    expect(p[off + 2]).toBeCloseTo(reference[off + 2] + 2, 6)
    expect(p[off + 3]).toBeCloseTo(reference[off + 3] - 1, 6)
    expect(pair(p)).toBeCloseTo(pair(reference), 6)
    for (const i of [0, 1, 6, 7]) {
      expect(p[off + i]).toBeCloseTo(reference[off + i], 6)
    }
  })

  it('groups two free endpoints: the held point keeps its distance from the drag', () => {
    const doc: PartDoc = {
      features: [{
        id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [{ id: 'a', kind: 'line' }, { id: 'b', kind: 'line' }],
        initial: { a: [0, 0, 4, 0], b: [6, 0, 10, 0] },
        constraints: [{ id: 'g1', kind: 'group', refs: ['$aend', '$bstart'] }],
      }],
    }
    const { sketches } = partDocToSketches(doc.features)
    const { input, layout } = lowerSketch(sketches[0].sketch)
    const a = layout.find(l => l.id === 'a')!.offset
    const b = layout.find(l => l.id === 'b')!.offset
    const reference = [...input.params]
    input.params[a + 2] += 2
    input.params[a + 3] += 1
    input.paramsReference = reference
    input.pinnedMask = [0b0000_1100]  // a.end is the dragged pair
    const out = decodeOutput(bytes!(encodeInput(input)))
    const p = out.paramsSolved
    const held = Math.hypot(reference[b] - reference[a + 2], reference[b + 1] - reference[a + 3])
    expect(held).toBe(2)
    // The drag is at the cursor; the other held endpoint keeps its distance,
    // and with the turn free that distance is all the group states.
    expect(p[a + 2]).toBeCloseTo(reference[a + 2] + 2, 6)
    expect(p[a + 3]).toBeCloseTo(reference[a + 3] + 1, 6)
    expect(Math.hypot(p[b] - p[a + 2], p[b + 1] - p[a + 3])).toBeCloseTo(held, 6)
    // The other endpoints are not members and stay put.
    expect(p[a]).toBeCloseTo(reference[a], 6)
    expect(p[a + 1]).toBeCloseTo(reference[a + 1], 6)
    expect(p[b + 2]).toBeCloseTo(reference[b + 2], 6)
    expect(p[b + 3]).toBeCloseTo(reference[b + 3], 6)
  })
})

/** A minimal DXF with two lines and a circle, the import writer's input. */
function dxfText(): string {
  const groups = ['0', 'SECTION', '2', 'ENTITIES']
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    groups.push('0', 'LINE', '10', String(x1), '20', String(y1), '11', String(x2), '21', String(y2))
  }
  line(0, 0, 10, 0)
  line(10, 0, 10, 6)
  groups.push('0', 'CIRCLE', '10', '5', '20', '3', '40', '1')
  groups.push('0', 'ENDSEC', '0', 'EOF')
  return groups.join('\n') + '\n'
}

describe.skipIf(!bytes)('an imported DXF profile is one group', () => {
  it('arrives at 3 DOF; a pinned coincident and a horizontal close it', () => {
    const doc: PartDoc = {
      features: [{
        id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [], initial: {},
      }],
    }
    applyImportDxf(doc, 'sk', dxfText())
    const feature = doc.features![0] as SketchFeature
    expect(feature.entities).toHaveLength(3)
    const groups = (feature.constraints ?? []).filter(c => c.kind === 'group')
    expect(groups).toHaveLength(1)
    expect(groups[0].refs).toEqual((feature.entities ?? []).map(e => `$${e.id}`))

    const free = solve(doc)
    expect(free.out.overallStatus).toBe(Status.underconstrained)
    expect(free.out.diagnostics.dof).toBe(3)

    const first = (feature.entities ?? [])[0].id
    applyAddConstraint(doc, 'sk', 'coincident', [`vertex:sk:${first}:start`, '@builtin_origin'])
    const pinned = solve(doc)
    expect(pinned.out.overallStatus).toBe(Status.underconstrained)
    expect(pinned.out.diagnostics.dof).toBe(1)

    // The profile still turns about the pinned vertex; its first line is
    // horizontal as drawn, so that row is the closing one.
    applyAddConstraint(doc, 'sk', 'horizontal', [`entity:sk:${first}`])
    const closed = solve(doc)
    expect(closed.out.overallStatus).toBe(Status.fully_constrained)
    expect(closed.out.diagnostics.dof).toBe(0)
  })

  it('group: false imports plain rows, still at the authored DOF', () => {
    const doc: PartDoc = {
      features: [{
        id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [], initial: {},
      }],
    }
    applyImportDxf(doc, 'sk', dxfText(), undefined, false)
    const feature = doc.features![0] as SketchFeature
    expect(feature.entities).toHaveLength(3)
    expect(feature.constraints ?? []).toEqual([])
    const free = solve(doc)
    expect(free.out.overallStatus).toBe(Status.underconstrained)
    // No group: every coordinate of every row is free (4 + 4 + 3 params).
    expect(free.out.diagnostics.dof).toBe(11)
  })
})
