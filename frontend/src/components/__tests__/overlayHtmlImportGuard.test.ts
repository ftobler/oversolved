/**
 * Every DOM label in a viewport goes through OverlayHtml, which owns the
 * anchor-visibility rule. A direct drei Html import bypasses it and brings back
 * the orthographic behind-camera bug where dimension values vanished while
 * their lines stayed drawn.
 *
 * Comments mention Html all over the viewports, so the scan runs on live text
 * with comments blanked. Test files are skipped: the rule is about what ships.
 */
import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { productionFiles, liveText } from '@/testing/sourceScan'

const COMPONENTS = join(__dirname, '..')
const WRAPPER = join(COMPONENTS, 'Geometry3D', 'OverlayHtml.tsx')
const DIRECT_HTML_IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;'"]*\bHtml\b[^;'"]*\sfrom\s*['"]@react-three\/drei['"]/g

describe('viewport HTML import guard', () => {
  it('funnels every drei Html import in components through OverlayHtml', () => {
    const offenders: string[] = []
    const files = productionFiles(COMPONENTS)
    for (const file of files) {
      if (file === WRAPPER) continue
      const text = liveText(file)
      for (const match of text.matchAll(DIRECT_HTML_IMPORT)) {
        const line = text.slice(0, match.index ?? 0).split('\n').length
        offenders.push(`${file.slice(COMPONENTS.length + 1)}:${line}`)
      }
    }
    expect(offenders).toEqual([])
    // Guards the guard: a broken walk would report a clean tree on zero files.
    expect(files.length).toBeGreaterThan(50)
  })

  it('the wrapper still imports drei Html, so the guard cannot pass vacuously', () => {
    expect(liveText(WRAPPER).match(DIRECT_HTML_IMPORT) ?? []).toHaveLength(1)
  })
})
