// Always-on tests for the import_step leaf's OCC-free guard paths. The STEP
// decode itself needs the WASM artifact and lives in importStepReal.test.ts.

import { describe, it, expect } from 'vitest'
import { solveImportStep } from './importStep'
import type { OccModule } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Repository } from '../query'

const oc = null as unknown as OccModule
const scope = null as never
const table = null as unknown as HandleTable
const repo = null as unknown as Repository

describe('solveImportStep guard paths', () => {
  it('throws on a non-finite scale instead of feeding NaN to the identity computation', () => {
    // Hand-edited or expression-derived YAML can carry scale: .nan; Number()
    // turns that into NaN, which used to flow into the placement identity
    // unchecked. No OCC is touched before the guard fires.
    for (const bad of [NaN, Infinity]) {
      expect(() =>
        solveImportStep(oc, scope, table, { id: 'i1', file_data: '', scale: bad }, repo, {}),
      ).toThrow(/scale must be a finite number/)
    }
  })
})
