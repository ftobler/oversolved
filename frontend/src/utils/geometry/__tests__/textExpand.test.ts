// @vitest-environment node
//
// The glyph table and the pure text expander: the checked-in asset is the one
// the generator writes, it covers printable ASCII, and placement only scales,
// rotates and translates. The applier's rounding and the drive refusals are in
// utils/__tests__/yamlMutations.addText.test.ts.

import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  expandText, textFieldsProblem, textEntityCount, SKETCH_GLYPHS, MAX_TEXT_ENTITIES,
  FIRST_TEXT_CODE, LAST_TEXT_CODE, type PlacedContour,
} from '../textExpand'
import { liveText } from '@/testing/sourceScan'

const here = dirname(fileURLToPath(import.meta.url))
const frontendDir = resolve(here, '../../../..')
const advance = (ch: string) => SKETCH_GLYPHS.glyphs[String(ch.codePointAt(0))].advance

function lastPoint(contour: PlacedContour): [number, number] {
  const seg = contour.segments[contour.segments.length - 1]
  return seg.points[seg.points.length - 1]
}

function allPoints(contours: PlacedContour[]): [number, number][] {
  return contours.flatMap(c => [c.start, ...c.segments.flatMap(s => s.points)])
}

describe('the sketch glyph asset', () => {
  it('covers every printable ASCII code point with a positive em', () => {
    expect(SKETCH_GLYPHS.unitsPerEm).toBeGreaterThan(0)
    for (let code = FIRST_TEXT_CODE; code <= LAST_TEXT_CODE; code++) {
      const glyph = SKETCH_GLYPHS.glyphs[String(code)]
      expect(glyph, `code ${code}`).toBeDefined()
      expect(glyph.advance, `code ${code}`).toBeGreaterThan(0)
    }
  })

  it('holds no segment shorter than 1e-6 font units, and every contour closes on its start', () => {
    for (const [code, glyph] of Object.entries(SKETCH_GLYPHS.glyphs)) {
      for (const contour of glyph.contours) {
        let pen = contour.start
        for (const seg of contour.segments) {
          expect([2, 6], `code ${code}`).toContain(seg.length)
          const to = seg.slice(-2)
          expect(Math.hypot(to[0] - pen[0], to[1] - pen[1]), `code ${code}`).toBeGreaterThan(1e-6)
          pen = to
        }
        expect(pen, `code ${code}`).toEqual(contour.start)
      }
    }
  })

  it('is the asset the generator writes (generateSketchGlyphs.mjs --check)', () => {
    // execFileSync throws on a non-zero exit, which is the stale-asset signal.
    const out = execFileSync('node', [resolve(frontendDir, 'scripts/generateSketchGlyphs.mjs'), '--check'], { encoding: 'utf8' })
    expect(out).toContain('current')
  }, 60_000)
})

describe('expandText', () => {
  it('"I" is one contour, "O" two (outer and counter), a space none', () => {
    expect(expandText('I')).toHaveLength(1)
    expect(expandText('O')).toHaveLength(2)
    expect(expandText(' ')).toEqual([])
  })

  it('advances the pen by each glyph\'s advance; a space only advances', () => {
    const size = SKETCH_GLYPHS.unitsPerEm  // one font unit per sketch unit
    const i = expandText('i', { size })
    const shifted = expandText(' i', { size })
    const pairs = allPoints(i).map((p, k) => [p, allPoints(shifted)[k]] as const)
    for (const [a, b] of pairs) {
      expect(b[0] - a[0]).toBeCloseTo(advance(' '), 9)
      expect(b[1]).toBeCloseTo(a[1], 9)
    }
    // "Hi": the i's outline sits one H advance to the right of a lone i.
    const hi = expandText('Hi', { size })
    const hContours = expandText('H').length
    allPoints(hi.slice(hContours)).forEach((p, k) => {
      expect(p[0] - allPoints(i)[k][0]).toBeCloseTo(advance('H'), 9)
    })
  })

  it('every contour ends on its own start', () => {
    for (const contour of expandText('Oh, 8&B!', { origin: [3, -2], size: 7, angle: 30 })) {
      const end = lastPoint(contour)
      expect(end[0]).toBeCloseTo(contour.start[0], 9)
      expect(end[1]).toBeCloseTo(contour.start[1], 9)
    }
  })

  it('size scales about the baseline origin; angle 90 maps +x advance to +y', () => {
    const one = allPoints(expandText('A', { size: 10, origin: [5, 5] }))
    const two = allPoints(expandText('A', { size: 20, origin: [5, 5] }))
    one.forEach((p, k) => {
      expect(two[k][0] - 5).toBeCloseTo(2 * (p[0] - 5), 9)
      expect(two[k][1] - 5).toBeCloseTo(2 * (p[1] - 5), 9)
    })
    const flat = allPoints(expandText('A', { size: 10 }))
    const turned = allPoints(expandText('A', { size: 10, angle: 90 }))
    flat.forEach((p, k) => {
      expect(turned[k][0]).toBeCloseTo(-p[1], 9)
      expect(turned[k][1]).toBeCloseTo(p[0], 9)
    })
  })

  it('center and right shift the run by half and all of its advance', () => {
    const size = 12
    const width = (advance('H') + advance('i')) * size / SKETCH_GLYPHS.unitsPerEm
    const left = allPoints(expandText('Hi', { size }))
    const center = allPoints(expandText('Hi', { size, align: 'center' }))
    const right = allPoints(expandText('Hi', { size, align: 'right' }))
    left.forEach((p, k) => {
      expect(p[0] - center[k][0]).toBeCloseTo(width / 2, 9)
      expect(p[0] - right[k][0]).toBeCloseTo(width, 9)
      expect(right[k][1]).toBeCloseTo(p[1], 9)
    })
  })
})

describe('textFieldsProblem', () => {
  it('accepts a plain run and refuses each bad field by name', () => {
    expect(textFieldsProblem({ text: 'Hi', size: 5, origin: [1, 2], angle: 15, align: 'center' })).toBeNull()
    expect(textFieldsProblem({ text: '' })).toContain('text must be a non-empty string')
    expect(textFieldsProblem({ text: 'Hi', size: 0 })).toContain('size must be a positive finite')
    expect(textFieldsProblem({ text: 'Hi', size: Number.NaN })).toContain('size must be a positive finite')
    expect(textFieldsProblem({ text: 'Hi', origin: [1] })).toContain('origin must be a finite [x, y]')
    expect(textFieldsProblem({ text: 'Hi', angle: Infinity })).toContain('angle must be a finite number')
    expect(textFieldsProblem({ text: 'Hi', align: 'justify' })).toContain('align must be one of left, center, right')
  })

  it('names an unsupported character by code point, astral ones whole', () => {
    expect(textFieldsProblem({ text: 'café' })).toContain('"é" (U+00E9)')
    expect(textFieldsProblem({ text: 'a\nb' })).toContain('(U+000A)')
    expect(textFieldsProblem({ text: 'x\u{1F600}' })).toContain('(U+1F600)')
  })

  it('refuses a run over MAX_TEXT_ENTITIES, naming the cap', () => {
    const perW = textEntityCount('W')
    const text = 'W'.repeat(Math.floor(MAX_TEXT_ENTITIES / perW) + 1)
    expect(textEntityCount(text)).toBeGreaterThan(MAX_TEXT_ENTITIES)
    expect(textFieldsProblem({ text })).toContain(`MAX_TEXT_ENTITIES (${MAX_TEXT_ENTITIES})`)
  })
})

describe('the runtime carries no font parser and fetches nothing', () => {
  it('textExpand imports the checked-in asset and no troika, Typr, fetch or font URL', () => {
    const src = liveText(resolve(here, '../textExpand.ts'))
    expect(src).toContain("from '@/assets/fonts/roboto-400-glyphs.json'")
    expect(src).not.toMatch(/troika|typr/i)
    expect(src).not.toMatch(/\bfetch\s*\(/)
    expect(src).not.toMatch(/\.woff2?\b|\.ttf\b|\.otf\b|https?:/)
  })
})
