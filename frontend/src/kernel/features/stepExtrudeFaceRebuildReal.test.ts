// @vitest-environment node
//
// Regression gate for the imported-STEP + extrude-a-face rebuild hang
// (bugreport rebuild_problem_20260704_121405 / feature double_with_hole.step).
//
// Extruding a planar face (that has a hole through it) of an imported STEP body
// back onto that same body fed ShapeUpgrade_UnifySameDomain's face merge a
// topology it folds forever -- an uncatchable synchronous spin that hung the
// solver Worker (high CPU, no preview). booleanWithDiff now skips the face merge
// (edge merge only) when the raw boolean result carries freeform faces, which
// imported STEP geometry does and native features do not. See
// occ/booleans.ts `hasFreeformFace`.
//
// Skips when opencascade.js or the Rust solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadOcc } from '../occ/loadOcc'
import { SharedHarness } from '../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from './sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'

const oc = await loadOcc()
const solveBytes = loadSolver()

const STEP_PATH = new URL('../occ/__fixtures__/double_with_hole.step', import.meta.url)
const stepBytes = new Uint8Array(readFileSync(STEP_PATH))

// The AST from the bug report: import_step then an extrude whose profile is the
// z+ (top) flat face of the imported body, added back onto that body.
const IMP = 'G8BSdTsDWV8CpMW-lwVUFqNi'
const files = new Map<string, Uint8Array>([[IMP, stepBytes]])

describe.skipIf(!oc || !solveBytes)('imported STEP extrude-a-face rebuild', () => {
  const h = new SharedHarness(oc!)
  beforeAll(() => { if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) } })

  it('completes without hanging and adds to the imported body', () => {
    const stepFeat = { id: IMP, kind: 'import_step', file_id: IMP, label: 'double_with_hole.step' }
    const r1 = h.run({ features: [stepFeat] }, { files })
    expect(h.res(r1, IMP).status).toBe('ok')

    const faceQueries = (h.body(r1, `body_${IMP}`).mesh as { face_queries?: string[] } | undefined)?.face_queries ?? []
    const faceQuery = faceQueries.find(q => q.includes(':flatface') && q.includes('@cls_zp')) ?? faceQueries[0]
    expect(faceQuery).toBeTruthy()

    const extrudeFeat = {
      id: 'vDZ56mKQ6XEfDjgym9aqUg3c', kind: 'extrude',
      extrude: { direction: 'normal', distance: 10, sketch: [faceQuery] },
    }
    // Partial rebuild (prevState). The imported body is the clean prefix
    // restored from its checkpoint; the extrude's profile face query must
    // resolve against that checkpoint-restored repo. Imports carry no `@u|`
    // construction UUID, so this rides the ancestral tier: the face's ancestral
    // entry (`@<import>@body@cls_zp:flatface`) is persisted in the checkpoint's
    // repo snapshot, so it resolves without any geometry token.
    const r2 = h.run({ features: [stepFeat, extrudeFeat] }, { prevState: r1._build_state, files })
    const res = h.res(r2, 'vDZ56mKQ6XEfDjgym9aqUg3c')
    expect(res.status).toBe('ok')
    expect(res.operation).toBe('add')
    expect(res.body_id).toBe(`body_${IMP}`)
    expect(r2.bodies).toHaveProperty(`body_${IMP}`)
  }, 60000)
})
