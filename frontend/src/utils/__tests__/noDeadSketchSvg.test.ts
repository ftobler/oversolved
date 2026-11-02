// The 2D sketch overlay rendered through SketchSvg.tsx (and the whole
// svgRenderUtils.tsx helper module behind it) was deleted: it had no production
// importers, and live dimension/symbol rendering moved to
// Geometry3D/dimensions/. This guard is the headstone. It fails the moment
// someone revives the surface, because "it compiles and tests pass" says
// nothing about a file no one imports.
//
// Honest about what it is: a lint-shaped heuristic like the other source scans
// in this suite. It strips comments so prose cannot trip it, and it pins the
// files themselves on disk so a bare identifier rename is still caught.

import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { join } from 'path'
import { productionFiles, liveText } from '@/testing/sourceScan'

const SRC = join(__dirname, '../../')

const srcOnlyFiles = productionFiles(SRC)

describe('dead sketch SVG surface stays deleted', () => {
  it('scans a non-empty source tree', () => {
    // Guards the guard: a broken walk would report a clean tree forever.
    expect(srcOnlyFiles.length).toBeGreaterThan(150)
  })

  it('keeps SketchSvg.tsx off the disk', () => {
    expect(existsSync(join(SRC, 'components/sketch/SketchSvg.tsx'))).toBe(false)
  })

  it('keeps svgRenderUtils.tsx off the disk', () => {
    expect(existsSync(join(SRC, 'utils/core/svgRenderUtils.tsx'))).toBe(false)
  })

  it('no production source imports SketchSvg or svgRenderUtils', () => {
    const offenders = srcOnlyFiles
      .filter(f => /SketchSvg|svgRenderUtils/.test(liveText(f)))
      .map(f => f.slice(SRC.length + 1))
    expect(offenders).toEqual([])
  })
})
