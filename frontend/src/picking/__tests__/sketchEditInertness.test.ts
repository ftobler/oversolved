import { describe, it, expect } from 'vitest'
import { IdPipeline } from '../IdPipeline'

/**
 * When a sketch is being edited, B-rep layers (face/edge/vertex) must
 * become inert in the ID buffer so the resolver cannot return a B-rep
 * entity. The pipeline exposes a single setter; the driver wires it to a
 * Zustand-state predicate. Here we exercise the pipeline-level contract.
 */

describe('IdPipeline.setBrepInertPredicate', () => {
  it('marks the B-rep layers inert when the predicate returns true', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    p.setBrepInertPredicate(() => true)
    expect(p.faceLayer.inertWhen!()).toBe(true)
    expect(p.edgeLayer.inertWhen!()).toBe(true)
    expect(p.vertexLayer.inertWhen!()).toBe(true)
    // Helper layers remain pickable.
    expect(p.planeLayer.inertWhen).toBeUndefined()
    expect(p.sketchEntityLayer.inertWhen).toBeUndefined()
    expect(p.sketchVertexLayer.inertWhen).toBeUndefined()
    expect(p.originLayer.inertWhen).toBeUndefined()
    p.dispose()
  })

  it('clears the inert flag when given null', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    p.setBrepInertPredicate(() => true)
    p.setBrepInertPredicate(null)
    expect(p.faceLayer.inertWhen).toBeUndefined()
    expect(p.edgeLayer.inertWhen).toBeUndefined()
    expect(p.vertexLayer.inertWhen).toBeUndefined()
    p.dispose()
  })

  it('predicate is consulted live so toggling state flips inertness', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    let editing = false
    p.setBrepInertPredicate(() => editing)
    expect(p.faceLayer.inertWhen!()).toBe(false)
    editing = true
    expect(p.faceLayer.inertWhen!()).toBe(true)
    p.dispose()
  })
})
