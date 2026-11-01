// @vitest-environment node
//
// Entity-picked sweep profiles go through the same closed-loop assembler the
// region paths use. Two disjoint closed rectangles in one sketch produce one
// loop and a leftover diagnostic; sweeping only the first and calling that
// `ok` silently drops the second pick. The sweep reports `partial` naming the
// dropped entities instead. Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'

const oc = await loadOcc()
const solveBytes = loadSolver()

function rect(
  prefix: string,
  x0: number,
  y0: number,
  w: number,
  h: number,
): { entities: Array<{ id: string; kind: 'line' }>; initial: Record<string, number[]>; constraints: Array<Record<string, unknown>> } {
  const bottom = prefix + 'b'
  const right = prefix + 'r'
  const top = prefix + 't'
  const left = prefix + 'l'
  return {
    entities: [
      { id: bottom, kind: 'line' }, { id: right, kind: 'line' },
      { id: top, kind: 'line' }, { id: left, kind: 'line' },
    ],
    initial: {
      [bottom]: [x0, y0, x0 + w, y0],
      [right]: [x0 + w, y0, x0 + w, y0 + h],
      [top]: [x0 + w, y0 + h, x0, y0 + h],
      [left]: [x0, y0 + h, x0, y0],
    },
    constraints: [
      { id: prefix + 'c1', kind: 'coincident', a: { entity: bottom, point: 'end' }, b: { entity: right, point: 'start' } },
      { id: prefix + 'c2', kind: 'coincident', a: { entity: right, point: 'end' }, b: { entity: top, point: 'start' } },
      { id: prefix + 'c3', kind: 'coincident', a: { entity: top, point: 'end' }, b: { entity: left, point: 'start' } },
      { id: prefix + 'c4', kind: 'coincident', a: { entity: left, point: 'end' }, b: { entity: bottom, point: 'start' } },
      { id: prefix + 'c5', kind: 'horizontal', target: { entity: bottom } },
      { id: prefix + 'c6', kind: 'horizontal', target: { entity: top } },
      { id: prefix + 'c7', kind: 'vertical', target: { entity: right } },
      { id: prefix + 'c8', kind: 'vertical', target: { entity: left } },
      { id: prefix + 'c9', kind: 'length', target: { entity: bottom }, value: w },
      { id: prefix + 'c10', kind: 'length', target: { entity: left }, value: h },
    ],
  }
}

function profileSketch(sketchId: string, second: boolean) {
  const one = rect('a', 0, 0, 2, 2)
  const two = second ? rect('b', 4, 0, 2, 2) : null
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Profiles', plane: '@builtin_plane_front',
    entities: [...one.entities, ...(two?.entities ?? [])],
    initial: { ...one.initial, ...(two?.initial ?? {}) },
    constraints: [...one.constraints, ...(two?.constraints ?? [])],
  }
}

function pathSketch(sketchId: string) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Path', plane: '@builtin_plane_top',
    entities: [{ id: 'p0', kind: 'line' as const }],
    initial: { p0: [0, 0, 0, 5] },
    constraints: [],
  }
}

function sweepSpec(id: string, profileRefs: string[]) {
  return {
    id, kind: 'sweep', label: 'Sweep',
    sweep: { sketch: profileRefs, path: '$pth', operation: 'new' },
  }
}

describe.skipIf(!oc || !solveBytes)('sweep entity-picked profiles (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  it('reports a leftover second rectangle as partial with its entity ids', () => {
    const result = h.run({
      features: [
        profileSketch('prof', true),
        pathSketch('pth'),
        sweepSpec('sw1', [
          'entity:prof:ab', 'entity:prof:ar', 'entity:prof:at', 'entity:prof:al',
          'entity:prof:bb', 'entity:prof:br', 'entity:prof:bt', 'entity:prof:bl',
        ]),
      ],
    })
    const res = h.res(result, 'sw1')
    expect(res.status).toBe('partial')
    const message = String(res.exception ?? '')
    expect(message).toMatch(/dropped 4 of 8 picked profile entities/)
    // The surviving loop is one full rectangle; the four ids named are the
    // other rectangle's, whichever one the topo edge order chained first.
    const named = message.split(': ').pop() ?? ''
    const ids = named.split(', ')
    expect(ids).toHaveLength(4)
    const prefix = ids[0][0]
    expect(['a', 'b']).toContain(prefix)
    expect(ids.every((id) => id[0] === prefix)).toBe(true)
  })

  it('sweeps a single picked rectangle as ok', () => {
    const result = h.run({
      features: [
        profileSketch('prof', false),
        pathSketch('pth'),
        sweepSpec('sw1', [
          'entity:prof:ab', 'entity:prof:ar', 'entity:prof:at', 'entity:prof:al',
        ]),
      ],
    })
    expect(h.res(result, 'sw1').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_sw1')
  })
})
