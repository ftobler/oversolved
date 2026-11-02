// The builder worker spike is gone: `builderWorker.ts` was a dead second OCC
// worker that no production module imported, and its bootstrap wired
// `loadOccWeb` (which needs `document`/`window` and returns null in a Worker),
// so it would fail if anyone wired it up. `spikeBuild.ts` was the other half.
// The real solve worker (`solverWorker.ts`) is the single OCC host and uses
// `loadOccWorker` instead. This guard is the headstone. It fails the moment
// someone revives the broken pattern, because "it compiles and tests pass"
// says nothing about a file no one imports.
//
// Honest about what it is: a lint-shaped heuristic like the other source scans
// in this suite. It strips comments so prose cannot trip it, and it pins the
// files themselves on disk so a bare identifier rename is still caught.

import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { join } from 'path'
import { productionFiles, liveText } from '@/testing/sourceScan'

const SRC = join(__dirname, '../../../')

const srcOnlyFiles = productionFiles(SRC)

describe('dead builder worker spike stays deleted', () => {
  it('scans a non-empty source tree', () => {
    // Guards the guard: a broken walk would report a clean tree forever.
    expect(srcOnlyFiles.length).toBeGreaterThan(150)
  })

  it('keeps builderWorker.ts off the disk', () => {
    expect(existsSync(join(SRC, 'kernel/occ/builderWorker.ts'))).toBe(false)
  })

  it('keeps spikeBuild.ts off the disk', () => {
    expect(existsSync(join(SRC, 'kernel/occ/spikeBuild.ts'))).toBe(false)
  })

  it('no production source imports builderWorker or spikeBuild', () => {
    const offenders = srcOnlyFiles
      .filter(f => /builderWorker|spikeBuild/.test(liveText(f)))
      .map(f => f.slice(SRC.length + 1))
    expect(offenders).toEqual([])
  })
})
