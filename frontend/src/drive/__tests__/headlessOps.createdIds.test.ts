// @vitest-environment node
//
// A rect, center rect or n-gon reports its entities in minting order and the
// number of constraints it minted; the constraint ids stay readable from the
// document. Every other creating mutation still names all of its ids.

import { describe, it, expect } from 'vitest'
import type { SketchFeature } from '@/types/cad'
import { emptyDriveDoc, runHeadless } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'

const SKETCH: ScriptStep = { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } }

describe('compact created ids', () => {
  it('add_rect lists four lines in bottom, right, top, left order plus a constraint count', async () => {
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [SKETCH, { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 6] } }],
    })
    const step = result.outcome.steps[1]
    const sketch = result.doc!.features!.find(f => f.id === 'sk1') as SketchFeature
    const entityIds = new Set(sketch.entities!.map(entity => entity.id))
    expect(step.createdIds).toHaveLength(4)
    expect(step.createdIds.every(id => entityIds.has(id))).toBe(true)
    const [bottom, right, top, left] = step.createdIds.map(id => sketch.initial![id])
    expect([bottom[1], bottom[3]]).toEqual([0, 0])
    expect([right[0], right[2]]).toEqual([10, 10])
    expect([top[1], top[3]]).toEqual([6, 6])
    expect([left[0], left[2]]).toEqual([0, 0])
    expect(step.constraints).toBe(sketch.constraints!.length)
    expect(step.constraints).toBeGreaterThan(0)
  })

  it('add_center_rect and add_ngon list entities only and count the rest', async () => {
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        SKETCH,
        { mutation: { type: 'add_center_rect', featureId: 'sk1', center: [0, 0], corner: [5, 3] } },
        { mutation: { type: 'add_ngon', featureId: 'sk1', center: [20, 0], corner: [24, 0], sides: 6 } },
      ],
    })
    const sketch = result.doc!.features!.find(f => f.id === 'sk1') as SketchFeature
    const constraintIds = new Set(sketch.constraints!.map(c => c.id))
    for (const step of result.outcome.steps.slice(1)) {
      expect(step.createdIds.some(id => constraintIds.has(id))).toBe(false)
      expect(step.constraints).toBeGreaterThan(0)
    }
    expect(result.outcome.steps[1].createdIds).toHaveLength(5)
    expect(result.outcome.steps.slice(1).reduce((n, s) => n + s.constraints!, 0)).toBe(sketch.constraints!.length)
  })

  it('a creating mutation outside the helpers keeps its constraint ids and has no count', async () => {
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        SKETCH,
        { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 5, 0] } },
      ],
    })
    expect(result.outcome.steps[1].ok).toBe(true)
    expect(result.outcome.steps[1].createdIds).toHaveLength(1)
    expect(result.outcome.steps[1]).not.toHaveProperty('constraints')
  })
})
