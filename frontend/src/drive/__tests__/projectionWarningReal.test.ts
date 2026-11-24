// @vitest-environment node
//
// An unresolved projection used to be silent over MCP: the entity stays in the
// sketch at its cached params, so the solve reads clean and the drive reply has
// no row for it. The solve now names it on the warning channel, which the drive's
// own feature-outcome reader turns into a `features` problem row.
import { describe, it, expect, beforeEach } from 'vitest'
import { solveSketch, setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { featureProblems, readSolveOutcomes } from '@/drive/featureOutcome'
import type { Repository } from '@/kernel/query'
import type { PartSolid } from '@/kernel/types3d'
import type { BuildResponse, PartDoc } from '@/types/cad'

const solveBytes = loadSolver()

type Dict = Record<string, unknown>

const doc: PartDoc = {
  version: 1,
  kind: 'part',
  features: [
    { id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front' },
    { id: 'sk2', kind: 'sketch', plane: '@builtin_plane_right' },
  ],
}

function heldSketch(source: string, initial: Record<string, number[]>, id = 'sk2'): Dict {
  return {
    id, kind: 'sketch', plane: '@builtin_plane_right',
    entities: [{ id: 'held', kind: 'point' }],
    initial,
    constraints: [{ id: 'proj_held', kind: 'projection', target: '$held', source }],
  }
}

function deadRepo(): Repository {
  return { query: () => null, elements: new Map() } as unknown as Repository
}

describe('an unresolved projection reaches the drive as a feature warning', () => {
  beforeEach(() => {
    resetSketchSolver()
    if (solveBytes) setSketchSolver(solveBytes)
  })

  it('reports a warning row naming the projection and its source', () => {
    if (!solveBytes) return
    const feature: Dict = {
      id: 'sk2', kind: 'sketch', plane: '@builtin_plane_right',
      entities: [{ id: 'held', kind: 'point' }],
      initial: { held: [3, 4] },
      constraints: [{ id: 'proj_held', kind: 'projection', target: '$held', source: '@sk1/doesNotExist' }],
    }
    const out = solveSketch(feature, deadRepo(), {} as Record<string, PartSolid>)
    // The reply's `features` list is the drive's own reading of the solve row.
    const outcomes = readSolveOutcomes({ sk2: out } as unknown as BuildResponse['result'])
    const problems = featureProblems(doc, outcomes)
    const row = problems.find(problem => problem.id === 'sk2')
    expect(row).toBeDefined()
    expect(row!.message).toContain('projection 1 did not resolve')
    // The structured split rides the same problem row: this one had a position.
    expect(row!.projectionErrors).toEqual({ keeps_last_position: ['proj_held'], unpositioned: [] })
  })

  it('names a forward reference in a stored document', () => {
    if (!solveBytes) return
    const feature = heldSketch('@sk3/q3', { held: [3, 4] })
    const featuresById: Record<string, Dict> = {
      sk1: { id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front', entities: [], initial: {}, constraints: [] },
      sk2: feature,
      sk3: {
        id: 'sk3', kind: 'sketch', plane: '@builtin_plane_top',
        entities: [{ id: 'q3', kind: 'point' }], initial: { q3: [1, 1] }, constraints: [],
      },
    }
    const out = solveSketch(feature, deadRepo(), {} as Record<string, PartSolid>, featuresById)
    expect(out.solver_warning).toContain(
      'projection 1 did not resolve; forward reference',
    )
    const forwardDoc: PartDoc = {
      version: 1, kind: 'part',
      features: [
        featuresById.sk1 as never,
        feature as never,
        featuresById.sk3 as never,
      ],
    }
    const outcomes = readSolveOutcomes({ sk2: out } as unknown as BuildResponse['result'])
    const row = featureProblems(forwardDoc, outcomes).find(problem => problem.id === 'sk2')!
    expect(row.projectionErrors).toEqual({ keeps_last_position: ['proj_held'], unpositioned: [] })
  })

  it('lists a never-positioned projection as unpositioned', () => {
    if (!solveBytes) return
    const feature = heldSketch('@sk9/nope', {})
    const out = solveSketch(feature, deadRepo(), {} as Record<string, PartSolid>)
    const outcomes = readSolveOutcomes({ sk2: out } as unknown as BuildResponse['result'])
    const row = featureProblems(doc, outcomes).find(problem => problem.id === 'sk2')!
    expect(row.projectionErrors).toEqual({ keeps_last_position: [], unpositioned: ['proj_held'] })
  })
})
