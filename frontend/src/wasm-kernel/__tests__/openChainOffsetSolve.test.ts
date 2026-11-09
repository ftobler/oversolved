// @vitest-environment node
//
// Real-solver regression for apply_offset on an OPEN connected chain. The seed
// rule used to give every entity its own side, so a left-turning chain offset
// its lines inward and grew its fillet arc outward (or the reverse). The clone
// joints were then unsatisfiable and the least-change solver dragged the
// SOURCES to compromise. The walk rule makes +d one side of the chain, so the
// seeds already satisfy the tangent joints and no source moves.
//
// Skips when the Rust solver build is absent.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { loadSolver } from '../loadSolver'
import { lowerSketch } from '../lowerSketch'
import { encodeInput, decodeOutput } from '../codec'
import { partDocToSketches } from '../partDocToSketches'
import { applyAddOffset, applyAddEntity } from '@/utils/yamlMutations'
import { sketchAt } from '@/testing/featureAccess'

const bytes = loadSolver()

type Row = [string, string, number[]]

function emptySketch(): PartDoc {
  return { features: [{ id: 'sk', kind: 'sketch', plane: '@builtin_plane_front', entities: [], initial: {}, constraints: [] }] }
}

function buildChain(rows: Row[]): PartDoc {
  const doc = emptySketch()
  for (const [id, kind, params] of rows) applyAddEntity(doc, 'sk', kind, params, id)
  return doc
}

function solveFeature(doc: PartDoc): Record<string, number[]> {
  const { sketches, skipped } = partDocToSketches(doc.features)
  expect(skipped).toHaveLength(0)
  expect(sketches).toHaveLength(1)
  const { input, layout } = lowerSketch(sketches[0].sketch)
  const out = decodeOutput(bytes!(encodeInput(input)))
  const solved: Record<string, number[]> = {}
  for (const l of layout) solved[l.id] = out.paramsSolved.slice(l.offset, l.offset + l.size)
  return solved
}

/** The clone a source's parallel/concentric relationship points at. */
function cloneOfSource(doc: PartDoc, sourceId: string): string {
  const f = sketchAt(doc)
  const relation = f.constraints!.find(
    (c) => (c.kind === 'parallel' || c.kind === 'concentric') && c.a === '$' + sourceId,
  )!
  return (relation.b as string).slice(1)
}

/** Signed perpendicular distance from source line `a` to the clone's start. */
function perpDistance(a: number[], point: [number, number]): number {
  const dx = a[2] - a[0], dy = a[3] - a[1]
  const n = Math.hypot(dx, dy)
  return (point[0] - a[0]) * (-dy / n) + (point[1] - a[1]) * (dx / n)
}

const LEFT_TURN: Row[] = [
  ['l1', 'line', [0, 0, -7, 0]],
  ['a1', 'arc', [-7, -3, 3, 90, 180]],
  ['l2', 'line', [-10, -3, -10, -10]],
]
const RIGHT_TURN: Row[] = [
  ['l1', 'line', [0, 0, 7, 0]],
  ['a1', 'arc', [7, -3, 3, 0, 90]],
  ['l2', 'line', [10, -3, 10, -10]],
]

describe.skipIf(!bytes)('an open-chain offset solves without moving the sources', () => {
  const cases: Array<[string, Row[], number]> = [
    ['left-turning chain, +1', LEFT_TURN, 1],
    ['right-turning mirror, -1', RIGHT_TURN, -1],
  ]
  for (const [name, rows, distance] of cases) {
    it(`${name}: every source stays put and every clone is one unit away`, () => {
      const doc = buildChain(rows)
      const f = sketchAt(doc)
      const authored = Object.fromEntries(rows.map(([id]) => [id, [...f.initial![id]]]))

      applyAddOffset(doc, 'sk', rows.map(([id]) => id), distance)
      const solved = solveFeature(doc)

      for (const [id] of rows) expect(solved[id]).toEqual(authored[id])

      // The arc copy is the source radius moved one unit toward the inside.
      const arcClone = cloneOfSource(doc, 'a1')
      expect(Math.abs(solved[arcClone][2] - solved.a1[2])).toBeCloseTo(1, 6)
      expect(solved[arcClone][2]).toBeCloseTo(2, 6)

      for (const id of ['l1', 'l2']) {
        const clone = cloneOfSource(doc, id)
        expect(Math.abs(perpDistance(solved[id], [solved[clone][0], solved[clone][1]]))).toBeCloseTo(1, 6)
      }
      // Both lines land inside the turn: down from the top run, and one unit in
      // from the vertical run (which side depends on the twin's mirror).
      expect(solved[cloneOfSource(doc, 'l1')][1]).toBeCloseTo(-1, 6)
      const l2Clone = solved[cloneOfSource(doc, 'l2')]
      expect(l2Clone[0]).toBeCloseTo(name.startsWith('left') ? -9 : 9, 6)
    })
  }

  it('a three-bend chain with alternating turns keeps its sources and offsets every clone', () => {
    // East, a left-bulging arc, west, a right-bulging arc, east: the stored arc
    // directions differ, so only a walk rule picks one side for all five.
    const rows: Row[] = [
      ['s1', 'line', [0, 0, 10, 0]],
      ['b1', 'arc', [10, 5, 5, 270, 90]],
      ['s2', 'line', [10, 10, 0, 10]],
      ['b2', 'arc', [0, 15, 5, 90, 270]],
      ['s3', 'line', [0, 20, 10, 20]],
    ]
    const doc = buildChain(rows)
    const f = sketchAt(doc)
    const authored = Object.fromEntries(rows.map(([id]) => [id, [...f.initial![id]]]))

    applyAddOffset(doc, 'sk', rows.map(([id]) => id), 1)
    const solved = solveFeature(doc)

    for (const [id] of rows) expect(solved[id]).toEqual(authored[id])
    for (const id of ['s1', 's2', 's3']) {
      const clone = cloneOfSource(doc, id)
      expect(Math.abs(perpDistance(solved[id], [solved[clone][0], solved[clone][1]]))).toBeCloseTo(1, 6)
    }
    for (const id of ['b1', 'b2']) {
      const clone = cloneOfSource(doc, id)
      expect(Math.abs(solved[clone][2] - solved[id][2])).toBeCloseTo(1, 6)
    }
  })
})
