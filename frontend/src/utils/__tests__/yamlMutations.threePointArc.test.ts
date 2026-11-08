import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PartDoc, PartConstraint, SketchFeature } from '@/types/cad'
import { applyAddThreePointArc } from '@/utils/yamlMutations'
import { parseTarget } from '@/utils/yamlMutations/helpers'
import { vertexPoint } from '@/utils/geometry/offsetProfile'
import { featureAt } from '@/testing/featureAccess'

// The three-point arc sugar is the MCP form of what the app's arc tool draws:
// a start, a point on the arc, and an end. The stored arc is CCW from a0_deg to
// a1_deg, so these tests pin both the circle and which stored vertex key the
// given start lands on.

const FID = 'sk'
const V_START = 'vertex:sk:other:end'
const V_END = 'vertex:sk:other2:start'

function sketchDoc(): PartDoc {
  return { features: [{ id: FID, kind: 'sketch', plane: '@builtin_plane_front', entities: [], initial: {}, constraints: [] }] }
}

const feat = (doc: PartDoc): SketchFeature => featureAt(doc, 0, 'sketch')
const arc = (doc: PartDoc) => {
  const feature = feat(doc)
  const entity = feature.entities!.find(e => e.kind === 'arc')!
  return { id: entity.id, params: feature.initial![entity.id] }
}
const coincidents = (doc: PartDoc): PartConstraint[] =>
  (feat(doc).constraints ?? []).filter(c => c.kind === 'coincident')

let warnSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('applyAddThreePointArc geometry', () => {
  it('authors the circumcircle and puts the given start on the arc start vertex', () => {
    const doc = sketchDoc()
    applyAddThreePointArc(doc, FID, [2, 1], [1, 1.5], [0, 1])
    const { params } = arc(doc)
    expect(params[0]).toBeCloseTo(1, 6)
    expect(params[1]).toBeCloseTo(0.25, 6)
    expect(params[2]).toBeCloseTo(1.25, 6)
    expect(params[3]).toBeCloseTo(36.869898, 6)
    expect(params[4]).toBeCloseTo(143.130102, 6)
    const start = vertexPoint('arc', params, 'start')!
    expect(start[0]).toBeCloseTo(2, 6)
    expect(start[1]).toBeCloseTo(1, 6)
  })

  it('reversing start and end keeps the circle and stores the given start as the end vertex', () => {
    // start -> through -> end runs clockwise here, so the CCW storage swaps the
    // two keys; the authored start still has to be the point the caller gave.
    const doc = sketchDoc()
    applyAddThreePointArc(doc, FID, [0, 1], [1, 1.5], [2, 1])
    const { params } = arc(doc)
    expect(params[0]).toBeCloseTo(1, 6)
    expect(params[1]).toBeCloseTo(0.25, 6)
    expect(params[2]).toBeCloseTo(1.25, 6)
    expect(params[3]).toBeCloseTo(36.869898, 6)
    expect(params[4]).toBeCloseTo(143.130102, 6)
    const end = vertexPoint('arc', params, 'end')!
    expect(end[0]).toBeCloseTo(0, 6)
    expect(end[1]).toBeCloseTo(1, 6)
  })

  it('a through point on the far side gives the major arc (270 degrees)', () => {
    const doc = sketchDoc()
    applyAddThreePointArc(doc, FID, [1, 0], [-1, 0], [0, 1])
    const { params } = arc(doc)
    expect(params[0]).toBeCloseTo(0, 6)
    expect(params[1]).toBeCloseTo(0, 6)
    expect(params[2]).toBeCloseTo(1, 6)
    const sweep = ((params[4] - params[3]) % 360 + 360) % 360
    expect(sweep).toBeCloseTo(270, 6)
  })
})

describe('applyAddThreePointArc refusals', () => {
  it('refuses collinear points by name and authors nothing', () => {
    const doc = sketchDoc()
    const before = JSON.stringify(doc)
    applyAddThreePointArc(doc, FID, [0, 0], [1, 1], [2, 2])
    expect(JSON.stringify(doc)).toBe(before)
    expect(warnSpy).toHaveBeenCalled()
    expect(String(warnSpy.mock.calls[0][0])).toContain('start, through and end are collinear')
    expect(String(warnSpy.mock.calls[0][0])).toContain('use a line')
  })

  it('refuses a coincident start and end by name', () => {
    const doc = sketchDoc()
    const before = JSON.stringify(doc)
    applyAddThreePointArc(doc, FID, [1, 1], [2, 2], [1, 1])
    expect(JSON.stringify(doc)).toBe(before)
    expect(String(warnSpy.mock.calls[0][0])).toContain('start and end coincide; use a circle')
  })

  it('refuses a through point on the start or the end by name', () => {
    const cases: Array<[[number, number], string]> = [
      [[1, 1], 'start and through coincide'],
      [[2, 2], 'through and end coincide'],
    ]
    for (const [through, message] of cases) {
      const doc = sketchDoc()
      applyAddThreePointArc(doc, FID, [1, 1], through, [2, 2])
      expect(String(warnSpy.mock.calls.at(-1)![0])).toContain(message)
      expect(feat(doc).entities).toEqual([])
    }
  })

  it('refuses non-finite points and authors nothing', () => {
    const doc = sketchDoc()
    applyAddThreePointArc(doc, FID, [0, 0], [1, Number.NaN], [2, 0])
    expect(feat(doc).entities).toEqual([])
    expect(warnSpy).toHaveBeenCalled()
  })

  it('refuses a taken authored entityId and authors nothing', () => {
    const doc = sketchDoc()
    applyAddThreePointArc(doc, FID, [2, 1], [1, 1.5], [0, 1], null, null, 'arc1')
    expect(arc(doc).id).toBe('arc1')
    const before = JSON.stringify(doc)
    applyAddThreePointArc(doc, FID, [2, 1], [1, 1.5], [0, 1], null, null, 'arc1')
    expect(JSON.stringify(doc)).toBe(before)
    expect(warnSpy).toHaveBeenCalled()
  })
})

describe('applyAddThreePointArc snap refs', () => {
  it('pins the given start to `start` and the given end to `end` when they run CCW', () => {
    const doc = sketchDoc()
    applyAddThreePointArc(doc, FID, [2, 1], [1, 1.5], [0, 1], V_START, V_END)
    const pins = coincidents(doc)
    expect(pins).toHaveLength(2)
    const atStart = pins.find(p => p.b === parseTarget(V_START, FID))!
    const atEnd = pins.find(p => p.b === parseTarget(V_END, FID))!
    expect(atStart.a).toBe(parseTarget(`vertex:${FID}:${arc(doc).id}:start`, FID))
    expect(atEnd.a).toBe(parseTarget(`vertex:${FID}:${arc(doc).id}:end`, FID))
  })

  it('swaps the keys when the authored order runs CW', () => {
    const doc = sketchDoc()
    applyAddThreePointArc(doc, FID, [0, 1], [1, 1.5], [2, 1], V_START, V_END)
    const pins = coincidents(doc)
    expect(pins).toHaveLength(2)
    const atStart = pins.find(p => p.b === parseTarget(V_START, FID))!
    const atEnd = pins.find(p => p.b === parseTarget(V_END, FID))!
    expect(atStart.a).toBe(parseTarget(`vertex:${FID}:${arc(doc).id}:end`, FID))
    expect(atEnd.a).toBe(parseTarget(`vertex:${FID}:${arc(doc).id}:start`, FID))
  })

  it('authors one pin when both ends name the same vertex', () => {
    const doc = sketchDoc()
    applyAddThreePointArc(doc, FID, [2, 1], [1, 1.5], [0, 1], V_START, V_START)
    expect(coincidents(doc)).toHaveLength(1)
  })

  it('pins both ends when both name the same curve', () => {
    const doc = sketchDoc()
    applyAddThreePointArc(doc, FID, [2, 1], [1, 1.5], [0, 1], 'entity:sk:curve', 'entity:sk:curve')
    expect(coincidents(doc)).toHaveLength(2)
  })

  it('authors no constraint without refs', () => {
    const doc = sketchDoc()
    applyAddThreePointArc(doc, FID, [2, 1], [1, 1.5], [0, 1])
    expect(feat(doc).constraints).toEqual([])
  })
})
