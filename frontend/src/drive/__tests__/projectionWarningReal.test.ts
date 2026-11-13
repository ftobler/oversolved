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
import type { Body } from '@/kernel/types3d'
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
    const repo = { query: () => null, elements: new Map() } as unknown as Repository
    const out = solveSketch(feature, repo, {} as Record<string, Body>)
    // The reply's `features` list is the drive's own reading of the solve row.
    const outcomes = readSolveOutcomes({ sk2: out } as unknown as BuildResponse['result'])
    const problems = featureProblems(doc, outcomes)
    const row = problems.find(problem => problem.id === 'sk2')
    expect(row).toBeDefined()
    expect(row!.message).toContain('projection proj_held source @sk1/doesNotExist did not resolve')
  })
})
