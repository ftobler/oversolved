// @vitest-environment node
//
// The names-for-people rule, as a tripwire: no user-facing warning may print a
// raw document id. The check is a 16+ character id-looking token, so a new
// message that interpolates an `eid`, `featureId` or `sketchId` fails here even
// if no test pins its exact wording.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PartDoc, PartFeature, SketchFeature } from '@/types/cad'
import { resetSketchSolver, setSketchSolver, solveSketch } from '../sketch'
import { applyAddConstraint, applyAddEntity, applyAddRect } from '@/utils/yamlMutations/sketch'
import { initGlobalRepo } from '../../query'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { partSpecFromText } from '@/utils/partExport'
import { ignoredConstraintWarning } from '@/utils/constraintProblems'
import { entityLoopDropMessage } from '../sweep'
import { circleDrillSiteReason } from '../shared/drillSite'
import { entityDisplayName, featureDisplayName } from '@/utils/core/displayNames'
import { leakedIds } from '@/testing/warningText'

const solveBytes = loadSolver()

function expectNoIds(text: string): void {
  expect(leakedIds(text), `message leaks an id: ${text}`).toEqual([])
}

/** Long ids, so a leak cannot hide behind a short fixture id. */
const LONG = {
  line1: 'lineXyZ0123456789abc',
  line2: 'lineAbC9876543210zyx',
  line3: 'lineQwE1122334455rty',
  line4: 'linePlM5566778899nbv',
  circle: 'circLe0123456789XyZa',
}

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

const solve = (feature: SketchFeature, features?: PartFeature[]) => {
  const rows = features ?? [feature]
  const byId = Object.fromEntries(rows.map(row => [row.id, row as unknown as Record<string, unknown>]))
  return solveSketch(feature as unknown as Record<string, unknown>, initGlobalRepo(), {}, byId)
}

describe.skipIf(solveBytes === null)('warning text names things, never ids (real solver)', () => {
  beforeAll(() => {
    if (solveBytes === null) throw new Error('unreachable: skipIf guards the suite')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })
  afterAll(() => resetSketchSolver())

  it('an underconstrained sketch names its free entities and leaks no id', () => {
    const feature = emptySketch('Free')
    applyAddRect(docOf(feature), 'sk1', [0, 0], [40, 30], null, null, [
      LONG.line1, LONG.line2, LONG.line3, LONG.line4,
    ])

    const out = solve(feature)
    const warning = String(out.solver_warning ?? '')
    expect(warning).toContain('Free: line 1, line 2, line 3, line 4')
    expectNoIds(warning)
    for (const entity of feature.entities ?? []) {
      expect(warning, entity.id).not.toContain(entity.id)
    }
    expect(out.free_entities).toEqual([LONG.line1, LONG.line2, LONG.line3, LONG.line4])
  })

  it('an ignored constraint names the row and leaks no id', () => {
    const feature = emptySketch('Hole')
    const doc = docOf(feature)
    applyAddEntity(doc, 'sk1', 'circle', [0, 0, 5], LONG.circle, undefined, true)
    applyAddConstraint(doc, 'sk1', 'coincident', [`vertex:sk1:${LONG.circle}:center`, '@builtin_origin'])
    applyAddConstraint(doc, 'sk1', 'length', [`vertex:sk1:${LONG.circle}:center`], 3)

    const out = solve(feature)
    const warning = String(out.solver_warning ?? '')
    expect(warning).toMatch(/^length 1 names geometry it cannot use \(operand kind\)/)
    expectNoIds(warning)
    expect(warning).not.toContain(LONG.circle)
  })

  it('a hole pick refusal names the sketch and the circle', () => {
    const sketch = {
      id: 'sk1',
      kind: 'sketch',
      entities: [{ id: 'c1XyZ0123456789', kind: 'circle' }],
    }
    const message = circleDrillSiteReason('sk1', 'c1XyZ0123456789', false, undefined, {
      sketch, features: [sketch],
    })
    expect(message).toContain('circle 1 of sketch 1')
    expectNoIds(message)
  })

  it('a dropped sweep entity names the curve and leaks no id', () => {
    const message = entityLoopDropMessage(
      ['rectXyZ0123456789'],
      [],
      [{ kind: 'leftover', leftover: 1, total: 2, surface: 0 }],
      { entities: [{ id: 'rectXyZ0123456789', kind: 'line' }] },
    )
    expect(message).toContain('line 1')
    expectNoIds(message ?? '')
  })

  it('the naming helpers never print the id they were given', () => {
    const sketch = {
      id: 'sk9',
      kind: 'sketch',
      entities: [{ id: 'lnXyZ0123456789', kind: 'line' }],
      constraints: [{ id: 'cXyZ0123456789', kind: 'coincident' }],
    }
    expect(entityDisplayName(sketch, 'lnXyZ0123456789')).toBe('line 1')
    expect(featureDisplayName({ id: 'exXyZ0123456789', kind: 'extrude' })).toBe('the extrude')
    expectNoIds(ignoredConstraintWarning('cXyZ0123456789', 'coincident', 'stale reference', sketch))
    expectNoIds(entityDisplayName(sketch, 'lnXyZ0123456789') ?? '')
    expectNoIds(featureDisplayName({ id: 'exXyZ0123456789', kind: 'extrude' }))
  })

  it('the long-id regression recipe emits only named warnings', () => {
    // The arc-extreme recipe's sketch carries a 16+ character dimension id and
    // is the repo's real long-id warning fixture. Replay its LIVE solve.
    const recipe = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../../regressions/arc-extreme-x-dimension/recipe.yaml'),
      'utf8',
    )
    const doc = partSpecFromText(recipe) as unknown as PartDoc
    const sketch = (doc.features ?? []).find(feature => feature.kind === 'sketch') as SketchFeature
    const out = solve(sketch, doc.features ?? [])
    const warning = String(out.solver_warning ?? '')
    expect(warning).toContain('x distance 2 holds the profile only at the arc')
    expectNoIds(warning)
    for (const entity of sketch.entities ?? []) expect(warning).not.toContain(entity.id)
    for (const constraint of sketch.constraints ?? []) expect(warning).not.toContain(constraint.id)
  })

  it('the tripwire catches a planted id and ignores the command vocabulary', () => {
    // The guard has to fail on a real id, or a green run means nothing.
    expect(leakedIds('Free: dnh9Ms-9bgP6RO0z.')).toEqual(['dnh9Ms-9bgP6RO0z'])
    expect(leakedIds('c_point_distance_x_OJPy7uYJ')).toEqual(['c_point_distance_x_OJPy7uYJ'])
    expect(leakedIds('Underconstrained: 4 degrees of freedom.')).toEqual([])
    // Command and mutation names a hint legitimately carries.
    expect(leakedIds('move it up with `reorder_features` (before this row)')).toEqual([])
    expect(leakedIds('freeze_projection: that pick names no projection')).toEqual([])
  })
})
