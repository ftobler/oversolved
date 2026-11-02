// Cross-module guard for the selection wrapper stripper (g2-H2). Every module
// used to hand-roll its own `split(':')` slice of a selection ID and they
// drifted apart: face handled here, edge not there, vertex joined differently.
// There is now ONE authoritative stripper (utils/query/selectionId.ts
// stripSelectionWrapper). This guard fails the moment a hand-rolled copy
// reappears outside it.
//
// Honest about what it is: a lint-shaped heuristic like the other source scans
// in this suite. It does not flag every `split(':')` -- index access like
// `t.split(':')[1]` in the sketch entity adapters is legitimate. It targets
// the wrapper-strip idioms `.split(':').slice(...)`, which is `split` then
// `slice` on the same expression and has no non-selection-id use.

import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { productionFiles, liveText } from '@/testing/sourceScan'

const SRC = join(__dirname, '../../')

const srcOnlyFiles = productionFiles(SRC)

describe('one source for selection wrapper stripping', () => {
  it('scans a non-empty source tree', () => {
    // Guards the guard: a broken walk would report a clean tree forever.
    expect(srcOnlyFiles.length).toBeGreaterThan(150)
  })

  it('every module uses stripSelectionWrapper, never a hand-rolled split', () => {
    const offenders = srcOnlyFiles
      .filter(f => !f.endsWith('utils/query/selectionId.ts'))
      .filter(f => /\.split\(['"]:['"]\)\.slice\(/.test(liveText(f)))
      .map(f => f.slice(SRC.length + 1))
    expect(offenders).toEqual([])
  })
})