// @vitest-environment node
//
// The version-9 split through the real kernel: a document written with the
// retired `pattern` kind, loaded through the ladder, must build exactly the
// document a hand-written `linear_pattern` / `circular_pattern` row builds.
// Equal volumes, bodies and face UUIDs is the migration's contract: the feature
// id and every copy's construction key survive, so nothing downstream (a
// boolean's `@<patternId>` expansion, a face query, an undo replay) moves.
//
// Skips when OCC.js or the sketch solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { DisposeScope } from '../../occ/disposeScope'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadPartDoc } from '@/persistence/docSchema'
import { volumeOf } from '../../occ/volume'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { BuildResponse } from '../../builder'
import type { PartSolid } from '../../types3d'

const oc = await loadOcc()
const solveBytes = loadSolver()

type Dict = Record<string, unknown>

function rectSketch(id: string, w: number, h: number, x0 = 0, y0 = 0): Dict {
  const points: [number, number][] = [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]]
  const entities = points.map((_, i) => ({ id: `l${i}`, kind: 'line' }))
  const initial: Record<string, number[]> = {}
  const constraints: Dict[] = []
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length]
    initial[`l${i}`] = [a[0], a[1], b[0], b[1]]
    constraints.push({
      id: `c${i}`, kind: 'coincident',
      a: { entity: `l${i}`, point: 'end' },
      b: { entity: `l${(i + 1) % points.length}`, point: 'start' },
    })
    constraints.push({ id: `h${i}`, kind: a[1] === b[1] ? 'horizontal' : 'vertical', target: { entity: `l${i}` } })
  })
  return { id, kind: 'sketch', plane: '@builtin_plane_front', entities, initial, constraints }
}

function boxDoc(feature: Dict, version: number): Record<string, unknown> {
  return {
    version,
    kind: 'part',
    features: [
      rectSketch('sk1', 10, 10),
      { id: 'ex1', kind: 'extrude', extrude: { sketch: '@sk1', distance: 5, direction: 'normal', operation: 'new' } },
      feature,
    ],
  }
}

/** A plate with one slot cut, so a feature-subject pattern can repeat the cut. */
function slottedDoc(feature: Dict, version: number): Record<string, unknown> {
  return {
    version,
    kind: 'part',
    features: [
      rectSketch('sk1', 40, 20),
      { id: 'ex1', kind: 'extrude', extrude: { sketch: '@sk1', distance: 5, direction: 'normal', operation: 'new' } },
      rectSketch('sk_slot', 4, 4, 6, 6),
      { id: 'ex2', kind: 'extrude', extrude: { sketch: '@sk_slot', distance: 10, direction: 'normal', operation: 'cut' } },
      feature,
    ],
  }
}

function loaded(doc: Record<string, unknown>): Record<string, unknown> {
  const result = loadPartDoc(doc)
  expect(result.ok, JSON.stringify(!result.ok ? result.error : null)).toBe(true)
  if (!result.ok) throw new Error('load failed')
  return result.doc as unknown as Record<string, unknown>
}

interface View {
  volumes: Record<string, number>
  uuids: Record<string, string[]>
}

describe.skipIf(!oc || !solveBytes)('the pattern split through the real kernel', () => {
  const h = new SharedHarness(oc!)
  const occ = oc as OccModule

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  function snapshot(r: BuildResponse): Record<string, PartSolid> {
    return r._build_state!.checkpoints.pt1.body_store_snapshot as Record<string, PartSolid>
  }

  function view(r: BuildResponse): View {
    const store = snapshot(r)
    const volumes: Record<string, number> = {}
    const uuids: Record<string, string[]> = {}
    const scope = new DisposeScope()
    try {
      for (const [id, body] of Object.entries(store)) {
        volumes[id] = volumeOf(occ, scope, h.table.get<OccShape>(body.shape!))
        uuids[id] = [...(body.face_uuids ?? [])].filter((uuid): uuid is string => uuid !== null).sort()
      }
    } finally {
      scope.dispose()
    }
    return { volumes, uuids }
  }

  function build(doc: Record<string, unknown>): View {
    const r = h.run(doc)
    expect(h.res(r, 'pt1').status).toBe('ok')
    return view(r)
  }

  const cases: Array<{ name: string; legacy: Dict; current: Dict }> = [
    {
      name: 'linear',
      legacy: {
        id: 'pt1', kind: 'pattern',
        pattern: { subject: 'body', source_body: '@body_ex1', mode: 'linear', count: 3, pitch: 20, direction: [1, 0, 0], operation: 'add' },
      },
      current: {
        id: 'pt1', kind: 'linear_pattern',
        linear_pattern: { subject: 'body', source_body: '@body_ex1', count: 3, pitch: 20, direction: [1, 0, 0], operation: 'add' },
      },
    },
    {
      name: 'rectangular',
      legacy: {
        id: 'pt1', kind: 'pattern',
        pattern: {
          subject: 'body', source_body: '@body_ex1', mode: 'rectangular', operation: 'add',
          count_x: 2, count_y: 2, pitch_x: 15, pitch_y: 12,
          direction_x: [1, 0, 0], direction_y: [0, 1, 0],
          skip: [[1, 1]],
        },
      },
      current: {
        id: 'pt1', kind: 'linear_pattern',
        linear_pattern: {
          subject: 'body', source_body: '@body_ex1', operation: 'add',
          second_direction: true, count: 2, count_2: 2, pitch: 15, pitch_2: 12,
          direction: [1, 0, 0], direction_2: [0, 1, 0],
          skip: [[1, 1]],
        },
      },
    },
    {
      name: 'circular, evenly spaced',
      legacy: {
        id: 'pt1', kind: 'pattern',
        pattern: {
          subject: 'body', source_body: '@body_ex1', mode: 'circular', count: 4, operation: 'add',
          axis_origin: [20, 20, 0], axis_direction: [0, 0, 1], centered: true,
        },
      },
      current: {
        id: 'pt1', kind: 'circular_pattern',
        circular_pattern: {
          subject: 'body', source_body: '@body_ex1', count: 4, operation: 'add',
          angle: 360, equal_spacing: true, centered: true,
          axis_origin: [20, 20, 0], axis_direction: [0, 0, 1],
        },
      },
    },
    {
      name: 'circular, stepped',
      legacy: {
        id: 'pt1', kind: 'pattern',
        pattern: {
          subject: 'body', source_body: '@body_ex1', mode: 'circular', count: 3, step_angle: 30, operation: 'add',
          axis_origin: [20, 20, 0], axis_direction: [0, 0, 1],
        },
      },
      current: {
        id: 'pt1', kind: 'circular_pattern',
        circular_pattern: {
          subject: 'body', source_body: '@body_ex1', count: 3, operation: 'add',
          angle: 30, equal_spacing: false,
          axis_origin: [20, 20, 0], axis_direction: [0, 0, 1],
        },
      },
    },
  ]

  for (const fixture of cases) {
    it(`builds a ${fixture.name} pattern identically before and after the split`, () => {
      // The legacy side is authored unstamped, so the loader's whole ladder runs.
      const before = build(loaded(boxDoc(fixture.legacy, 1)))
      // The new side is authored at the current stamp, so only validation runs.
      const after = build(loaded(boxDoc(fixture.current, 9)))

      expect(Object.keys(after.volumes).sort()).toEqual(Object.keys(before.volumes).sort())
      for (const id of Object.keys(before.volumes)) {
        expect(after.volumes[id], `${fixture.name} ${id} volume`).toBeCloseTo(before.volumes[id], 6)
        expect(after.uuids[id], `${fixture.name} ${id} face UUIDs`).toEqual(before.uuids[id])
      }
      // The pattern's own copied faces still answer to the feature id.
      expect(before.uuids).not.toEqual({})
    })
  }

  it('builds a feature-subject pattern identically before and after the split', () => {
    const legacy = {
      id: 'pt1', kind: 'pattern',
      pattern: { subject: 'feature', source_features: ['@ex2'], mode: 'linear', count: 3, pitch: 8, direction: [1, 0, 0] },
    }
    const current = {
      id: 'pt1', kind: 'linear_pattern',
      linear_pattern: { subject: 'feature', source_features: ['@ex2'], count: 3, pitch: 8, direction: [1, 0, 0] },
    }
    const before = build(loaded(slottedDoc(legacy, 1)))
    const after = build(loaded(slottedDoc(current, 9)))
    expect(Object.keys(after.volumes).sort()).toEqual(Object.keys(before.volumes).sort())
    expect(after.volumes).toEqual(before.volumes)
    expect(after.uuids).toEqual(before.uuids)
    // Three slots cut into the one plate.
    expect(before.volumes.body_ex1).toBeCloseTo(40 * 20 * 5 - 3 * 4 * 4 * 5, 6)
  })
})
