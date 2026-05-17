import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { IdPipeline, SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME } from '../IdPipeline'
import { setLivePipeline } from '../IdPipelineContext'
import { useSketchIdRegistration } from '../useSketchIdRegistration'
import type { Sketch } from '@/types/cad'

function makeSketch(): Sketch {
  return {
    line1: { start: [0, 0], end: [10, 0] },
    arc1:  { start: [10, 0], end: [10, 10], center: [10, 5], radius: 5,
             angle_start: -Math.PI / 2, angle_end: Math.PI / 2 },
    circle1: { center: [-5, 5], radius: 3 },
    point1: { x: 7, y: 7 },
  }
}

describe('useSketchIdRegistration', () => {
  it('registers entity composites for each non-point entity', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    setLivePipeline(p)
    try {
      const sketch = makeSketch()
      renderHook(() => useSketchIdRegistration({ featureId: 'feat1', sketch }))

      // line, arc, circle -> 3 entity queries; point has no segments.
      const reg = p.registry
      expect(reg.lookupKey(SKETCH_ENTITY_LAYER_NAME, 'entity:feat1:line1')).toBeDefined()
      expect(reg.lookupKey(SKETCH_ENTITY_LAYER_NAME, 'entity:feat1:arc1')).toBeDefined()
      expect(reg.lookupKey(SKETCH_ENTITY_LAYER_NAME, 'entity:feat1:circle1')).toBeDefined()
      expect(reg.lookupKey(SKETCH_ENTITY_LAYER_NAME, 'entity:feat1:point1')).toBeUndefined()
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })

  it('registers vertex composites for each endpoint / center / point', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    setLivePipeline(p)
    try {
      const sketch = makeSketch()
      renderHook(() => useSketchIdRegistration({ featureId: 'feat1', sketch }))

      const reg = p.registry
      // line: start + end
      expect(reg.lookupKey(SKETCH_VERTEX_LAYER_NAME, 'vertex:feat1:line1:start')).toBeDefined()
      expect(reg.lookupKey(SKETCH_VERTEX_LAYER_NAME, 'vertex:feat1:line1:end')).toBeDefined()
      // arc: start + end + center
      expect(reg.lookupKey(SKETCH_VERTEX_LAYER_NAME, 'vertex:feat1:arc1:start')).toBeDefined()
      expect(reg.lookupKey(SKETCH_VERTEX_LAYER_NAME, 'vertex:feat1:arc1:end')).toBeDefined()
      expect(reg.lookupKey(SKETCH_VERTEX_LAYER_NAME, 'vertex:feat1:arc1:center')).toBeDefined()
      // circle: center
      expect(reg.lookupKey(SKETCH_VERTEX_LAYER_NAME, 'vertex:feat1:circle1:center')).toBeDefined()
      // point: xy
      expect(reg.lookupKey(SKETCH_VERTEX_LAYER_NAME, 'vertex:feat1:point1:xy')).toBeDefined()
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })

  it('unregisters everything on unmount', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    setLivePipeline(p)
    try {
      const sketch = makeSketch()
      const { unmount } = renderHook(() => useSketchIdRegistration({ featureId: 'feat1', sketch }))
      expect(p.sketchEntityLayer.bodyCount()).toBe(1)
      expect(p.sketchVertexLayer.bodyCount()).toBe(1)
      act(() => unmount())
      expect(p.sketchEntityLayer.bodyCount()).toBe(0)
      expect(p.sketchVertexLayer.bodyCount()).toBe(0)
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })

  it('respects enabled=false (inactive-sketch suppression)', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    setLivePipeline(p)
    try {
      renderHook(() => useSketchIdRegistration({
        featureId: 'feat1', sketch: makeSketch(), enabled: false,
      }))
      expect(p.sketchEntityLayer.bodyCount()).toBe(0)
      expect(p.sketchVertexLayer.bodyCount()).toBe(0)
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })

  it('stable sketch identity across renders does not churn registry IDs', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    setLivePipeline(p)
    try {
      const sketch = makeSketch()  // same reference across rerenders
      const { rerender } = renderHook(
        ({ s }) => useSketchIdRegistration({ featureId: 'feat1', sketch: s }),
        { initialProps: { s: sketch } },
      )
      const idLine1 = p.registry.lookupKey('sketchEntity', 'entity:feat1:line1')
      rerender({ s: sketch })
      rerender({ s: sketch })
      // Stable sketch ref -> hook does not re-register -> id unchanged.
      expect(p.registry.lookupKey('sketchEntity', 'entity:feat1:line1')).toBe(idLine1)
      expect(p.sketchEntityLayer.bodyCount()).toBe(1)
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })

  it('applies a plane transform so entity coords land in world space', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    setLivePipeline(p)
    try {
      // Identity rotation + origin (10, 20, 30): vertex at (0,0) lands at (10,20,30).
      renderHook(() => useSketchIdRegistration({
        featureId: 'feat1',
        sketch: { line1: { start: [0, 0], end: [1, 0] } },
        planeTransform: {
          rotation: [1, 0, 0,  0, 1, 0,  0, 0, 1],
          origin: [10, 20, 30],
        },
      }))
      const im = p.sketchVertexLayer.scene.children[0] as import('three').InstancedMesh
      const aCenter = im.geometry.getAttribute('aCenter')
      // First vertex is line1.start (0,0) -> world (10,20,30).
      expect([aCenter.getX(0), aCenter.getY(0), aCenter.getZ(0)]).toEqual([10, 20, 30])
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })
})
