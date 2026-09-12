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
        solveImportStep(oc, scope, table, { id: 'i1', file_id: 'f1', scale: bad }, repo, {}),
      ).toThrow(/scale must be a finite number/)
    }
  })

  it("refuses a pre-cut inline file_data by name rather than solving empty", () => {
    // A2: there is no migration. The diagnostic must name the field the user has.
    expect(() =>
      solveImportStep(
        oc, scope, table,
        { id: 'i1', file_id: 'f1', file_data: 'SVNPLTEwMzAz' },
        repo, {},
      ),
    ).toThrow(/inline 'file_data' is no longer supported/)
  })

  it("blames the missing file_id, not file_data, when neither is present", () => {
    // The inline check precedes the file_id check: a document with neither must
    // be told what to add, and it must not be the stale inline field.
    expect(() =>
      solveImportStep(oc, scope, table, { id: 'i1' }, repo, {}),
    ).toThrow(/requires 'file_id'/)
  })

  it('throws when the file_id is absent from the solve file map', () => {
    expect(() =>
      solveImportStep(
        oc, scope, table, { id: 'i1', file_id: 'missing' }, repo, {},
        new Map([['other', new Uint8Array([1])]]),
      ),
    ).toThrow(/file 'missing' is not present in the solve file set/)
  })
})
