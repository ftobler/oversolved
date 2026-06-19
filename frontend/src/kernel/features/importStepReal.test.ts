// @vitest-environment node
//
// Gated real-OCC parity gate for the import_step leaf (features/importStep.ts +
// occ/stepIo.ts). Feeds the same base64 STEP box as
// the now-removed gen_importstep_fixture.py through solveImportStep at scale 1
// and scale 2, and asserts the result dict + imported body volume match Python.
// Exercises the emscripten-FS STEP read path (write/export is deferred to phase 3).
//
// Skips when opencascade.js is absent. The fixture is a frozen golden snapshot;
// its generator (gen_importstep_fixture.py) was deleted with the Python kernel
// in phase 4d.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope } from '../occ/disposeScope'
import { HandleTable } from '../occ/handleTable'
import { volumeOf } from '../occ/booleans'
import { Repository } from '../query'
import { solveImportStep } from './importStep'
import type { Body } from '../types3d'
import type { OccModule, OccShape } from '../occ/occTypes'
import fixture from '../occ/__fixtures__/importStep.json'

const oc = await loadOcc()

type Case = { name: string; scale: number; feature_id: string; result: Record<string, unknown>; volume: number }
const fx = fixture as unknown as { file_data: string; cases: Case[] }

describe.skipIf(!oc)('solveImportStep (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  for (const c of fx.cases) {
    it(`${c.name}: result + imported volume match Python`, () => {
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const bodyStore: Record<string, Body> = {}
        const result = solveImportStep(
          occ,
          scope,
          table,
          { id: c.feature_id, file_data: fx.file_data, scale: c.scale },
          new Repository(),
          bodyStore,
        )
        expect(result).toEqual(c.result)
        const body = bodyStore[c.result.body_id as string]
        expect(volumeOf(occ, scope, table.get<OccShape>(body.shape!))).toBeCloseTo(c.volume, 2)
      } finally {
        scope.dispose()
      }
    })
  }

  it("rejects missing file_data", () => {
    const scope = new DisposeScope()
    const table = new HandleTable({ finalizerGuard: false })
    try {
      expect(() =>
        solveImportStep(occ, scope, table, { id: 'x', file_data: '' }, new Repository(), {}),
      ).toThrow(/requires 'file_data'/)
    } finally {
      scope.dispose()
    }
  })
})
