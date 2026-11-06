// @vitest-environment node
//
// add_text at the document boundary: the applier writes plain line/spline
// rows whose shared endpoints are the identical rounded pair, a refused run
// writes nothing, and the drive rule refuses what the applier refuses plus a
// missing sketch as an unknown target. The session history and the reply shape
// are in drive/__tests__/addTextDrive.test.ts.

import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import { applyAddText, planAddText, textEntityRows } from '@/utils/yamlMutations'
import { MAX_SKETCH_ENTITIES } from '@/utils/geometry/sketchPattern'
import { mutationValueViolation } from '@/drive/mutationValues'
import { expandText, MAX_TEXT_ENTITIES, textEntityCount } from '@/utils/geometry/textExpand'
import { outlineSignedArea } from '@/testing/outlineArea'

const sketchOf = (doc: PartDoc): SketchFeature => doc.features!.find(f => f.id === 'sk') as SketchFeature

const rowsOf = (doc: PartDoc) => {
  const sketch = sketchOf(doc)
  return (sketch.entities ?? []).map(e => ({ id: e.id, kind: e.kind, params: sketch.initial![e.id] }))
}

const startOf = (params: number[]) => params.slice(0, 2)
const endOf = (params: number[]) => params.slice(-2)

const noDoc = { doc: null, fileIds: null, fieldSchema: () => null }

describe('applyAddText', () => {
  it('writes one line or spline row per glyph segment, ids unique, no constraints', () => {
    const doc = makeDoc(makeSketch('sk'))
    applyAddText(doc, 'sk', { text: 'OI', size: 10, origin: [1.25, -3] })
    const rows = rowsOf(doc)
    expect(rows).toHaveLength(textEntityCount('OI'))
    expect(new Set(rows.map(r => r.id)).size).toBe(rows.length)
    expect(new Set(rows.map(r => r.kind))).toEqual(new Set(['line', 'spline']))
    for (const r of rows) expect(r.params).toHaveLength(r.kind === 'line' ? 4 : 8)
    expect(sketchOf(doc).constraints ?? []).toEqual([])
  })

  it('chains every contour end-to-start on identical stored pairs and closes it exactly', () => {
    const doc = makeDoc(makeSketch('sk'))
    applyAddText(doc, 'sk', { text: 'B8%', size: 3.3333333, origin: [0.1234567, 7.7654321], angle: 17 })
    const rows = rowsOf(doc)
    // Rows arrive contour by contour; a contour closes when an end returns to
    // the stored start that opened it, and the next row opens the next one.
    let opened: number[] | null = null
    let contours = 0
    rows.forEach((row, k) => {
      if (opened === null) opened = startOf(row.params)
      else expect(startOf(row.params)).toEqual(endOf(rows[k - 1].params))
      if (endOf(row.params)[0] === opened[0] && endOf(row.params)[1] === opened[1]) {
        opened = null
        contours++
      }
    })
    expect(opened).toBeNull()
    expect(contours).toBe(expandText('B8%').length)
    // Every stored number is on the 1e-6 grid the sketch writer rounds to.
    for (const r of rows) for (const v of r.params) expect(Math.abs(v * 1e6 - Math.round(v * 1e6))).toBeLessThan(1e-6)
  })

  it('stores an area within the rounding slack of the unrounded glyph outline', () => {
    const fields = { text: 'OI', size: 10 }
    const stored = Math.abs(outlineSignedArea(textEntityRows(fields).map(([kind, params]) => ({ kind, params }))))
    const raw = Math.abs(outlineSignedArea(expandText(fields.text, fields).flatMap(c => {
      let prev = c.start
      return c.segments.map(s => {
        const params = [...prev, ...s.points.flat()]
        prev = s.points[s.points.length - 1]
        return { kind: s.kind, params }
      })
    })))
    expect(stored).toBeGreaterThan(0)
    expect(Math.abs(stored - raw) / raw).toBeLessThan(1e-4)
  })

  it('appends after existing entities and leaves them untouched', () => {
    const doc = makeDoc(makeSketch('sk', { entities: [{ id: 'l1', kind: 'line' }], initial: { l1: [0, 0, 1, 0] } }))
    applyAddText(doc, 'sk', { text: 'I' })
    const rows = rowsOf(doc)
    expect(rows[0]).toEqual({ id: 'l1', kind: 'line', params: [0, 0, 1, 0] })
    expect(rows.length).toBe(1 + textEntityCount('I'))
  })

  it('a refused run, a run of spaces, or a missing sketch writes nothing', () => {
    for (const fields of [
      { text: '' }, { text: 'Hi', size: 0 }, { text: 'café' },
      { text: 'W'.repeat(MAX_TEXT_ENTITIES) }, { text: '   ' },
    ]) {
      const doc = makeDoc(makeSketch('sk'))
      const before = structuredClone(doc)
      applyAddText(doc, 'sk', fields)
      expect(doc, JSON.stringify(fields).slice(0, 40)).toEqual(before)
    }
    const doc = makeDoc(makeSketch('sk'))
    const before = structuredClone(doc)
    applyAddText(doc, 'nope', { text: 'Hi' })
    expect(doc).toEqual(before)
  })
})

describe('planAddText', () => {
  it('refuses a run that draws nothing: only spaces, or a size every segment rounds away at', () => {
    expect(planAddText({ text: '   ' }, 0)).toHaveProperty('reason', expect.stringContaining('draws no outline'))
    expect(planAddText({ text: '.', size: 1e-7 }, 0)).toHaveProperty('reason', expect.stringContaining('draws no outline'))
    expect(planAddText({ text: ' . ' }, 0)).toHaveProperty('rows')
  })

  it('drops a contour rounding leaves as two lines there and back, never a zero-area loop', () => {
    // Somewhere between "every glyph survives" and "nothing survives" the
    // smallest contours collapse first; whatever is kept must be a real loop.
    for (const size of [1e-3, 3e-4, 1e-4, 3e-5]) {
      const rows = textEntityRows({ text: 'i.:;!', size })
      let run: typeof rows = []
      for (const row of rows) {
        run.push(row)
        const opened = run[0][1].slice(0, 2)
        const end = row[1].slice(-2)
        if (end[0] === opened[0] && end[1] === opened[1]) {
          const linesOnly = run.every(([kind]) => kind === 'line')
          expect(linesOnly && run.length < 3, `size ${size}`).toBe(false)
          run = []
        }
      }
      expect(run).toEqual([])
    }
  })

  it('refuses a run that would take the sketch over MAX_SKETCH_ENTITIES', () => {
    const rows = textEntityCount('Hi')
    expect(planAddText({ text: 'Hi' }, MAX_SKETCH_ENTITIES - rows)).toHaveProperty('rows')
    expect(planAddText({ text: 'Hi' }, MAX_SKETCH_ENTITIES - rows + 1))
      .toHaveProperty('reason', expect.stringContaining(`the sketch holds at most ${MAX_SKETCH_ENTITIES}`))
  })
})

describe('the add_text drive rule', () => {
  it('refuses the same values as the applier, prefixed with the mutation', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ text: '' }, 'add_text: text must be a non-empty string'],
      [{ text: 'Hi', size: 0 }, 'add_text: size must be a positive finite'],
      [{ text: 'café' }, '(U+00E9)'],
      [{ text: 'W'.repeat(MAX_TEXT_ENTITIES) }, `MAX_TEXT_ENTITIES (${MAX_TEXT_ENTITIES})`],
      [{ text: 'Hi', align: 'top' }, 'align must be one of'],
    ]
    for (const [fields, message] of cases) {
      const violation = mutationValueViolation('add_text', { type: 'add_text', featureId: 'sk', ...fields }, noDoc)
      expect(violation?.code).toBe('invalid-mutation')
      expect(violation?.message).toContain(message)
    }
  })

  it('names a missing sketch as an unknown target', () => {
    const doc = makeDoc(makeSketch('sk'))
    const violation = mutationValueViolation('add_text', { type: 'add_text', featureId: 'nope', text: 'Hi' },
      { ...noDoc, doc })
    expect(violation).toEqual({ code: 'unknown-target', message: 'add_text names no sketch feature "nope"' })
    expect(mutationValueViolation('add_text', { type: 'add_text', featureId: 'sk', text: 'Hi' }, { ...noDoc, doc }))
      .toBeNull()
  })

  it('refuses the plan\'s doc-aware cases: nothing drawn, and the sketch cap', () => {
    const doc = makeDoc(makeSketch('sk'))
    expect(mutationValueViolation('add_text', { type: 'add_text', featureId: 'sk', text: '  ' }, { ...noDoc, doc })?.message)
      .toContain('add_text: text "  " draws no outline')
    const full = makeDoc(makeSketch('sk', {
      entities: Array.from({ length: MAX_SKETCH_ENTITIES }, (_, i) => ({ id: `p${i}`, kind: 'point' })),
      initial: Object.fromEntries(Array.from({ length: MAX_SKETCH_ENTITIES }, (_, i) => [`p${i}`, [i, 0]])),
    }))
    expect(mutationValueViolation('add_text', { type: 'add_text', featureId: 'sk', text: 'I' }, { ...noDoc, doc: full })?.message)
      .toContain(`the sketch holds at most ${MAX_SKETCH_ENTITIES}`)
  })
})
