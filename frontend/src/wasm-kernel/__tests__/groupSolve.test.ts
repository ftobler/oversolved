// @vitest-environment node
//
// The Group constraint on the real Rust solver, through the same lowering the
// app runs: a group over a line and a circle leaves the sketch at 2 DOF, one
// coincident to the origin projection closes them and translates both entities
// rigidly, and a length that disagrees with the held shape is a conflict.
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
  it('leaves 2 DOF and keeps the shape, then a pinned coincident closes them', () => {
    const doc = groupedDoc()
    const free = solve(doc)
    expect(free.out.overallStatus).toBe(Status.underconstrained)
    expect(free.out.diagnostics.dof).toBe(2)
    expect(free.out.diagnostics.residualNorm).toBeLessThan(1e-6)
    expect(free.params.l1).toEqual([2, 3, 6, 3])
    expect(free.params.c1).toEqual([10, 3, 2.5])

    // Pin the line's start to the document origin, the whole group translates.
    applyAddConstraint(doc, 'sk', 'coincident', ['vertex:sk:l1:start', '@builtin_origin'])
    const pinned = solve(doc)
    expect(pinned.out.overallStatus).toBe(Status.fully_constrained)
    expect(pinned.out.diagnostics.dof).toBe(0)
    // (2,3) -> (0,0) is one translation for every member.
    expect(pinned.params.l1[0]).toBeCloseTo(0, 6)
    expect(pinned.params.l1[1]).toBeCloseTo(0, 6)
    expect(pinned.params.l1[2]).toBeCloseTo(4, 6)
    expect(pinned.params.l1[3]).toBeCloseTo(0, 6)
    expect(pinned.params.c1[0]).toBeCloseTo(8, 6)
    expect(pinned.params.c1[1]).toBeCloseTo(0, 6)
    expect(pinned.params.c1[2]).toBeCloseTo(2.5, 6)
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
  it('arrives at 2 DOF and a pinned coincident closes them', () => {
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
    expect(free.out.diagnostics.dof).toBe(2)

    const first = (feature.entities ?? [])[0].id
    applyAddConstraint(doc, 'sk', 'coincident', [`vertex:sk:${first}:start`, '@builtin_origin'])
    const pinned = solve(doc)
    expect(pinned.out.overallStatus).toBe(Status.fully_constrained)
    expect(pinned.out.diagnostics.dof).toBe(0)
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
