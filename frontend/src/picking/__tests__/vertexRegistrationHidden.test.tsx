import { describe, it, expect, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { IdPipeline } from '../IdPipeline'
import { setLivePipeline } from '../IdPipelineContext'
import { useVertexIdRegistration } from '../useVertexIdRegistration'
import { VERTEX_LAYER_NAME } from '../VertexIdLayer'

/**
 * The vertex half of the seam rule: the hook must thread the body's sparse
 * hidden list into the layer, and a skipped vertex must not shift the pick key
 * of the vertices after it.
 */
describe('useVertexIdRegistration hidden vertices', () => {
  let pipeline: IdPipeline
  afterEach(() => {
    setLivePipeline(null)
    pipeline?.dispose()
  })

  it('registers no pick for a hidden vertex and keeps the next one keyed on its own index', () => {
    pipeline = new IdPipeline({ width: 32, height: 32 })
    setLivePipeline(pipeline)

    const vertices: [number, number, number][] = [[0, 0, 0], [1, 0, 0], [2, 0, 0]]
    renderHook(() => useVertexIdRegistration({
      featureId: 'f1',
      bodyId: 'b1',
      vertices,
      vertexQueries: ['vtx@A', 'vtx@SEAM', 'vtx@C'],
      hiddenVertices: new Set([1]),
    }))

    expect(pipeline.registry.size()).toBe(2)
    expect(pipeline.registry.lookupKey(VERTEX_LAYER_NAME, 'f1/b1#vertex#1')).toBeUndefined()
    const third = pipeline.registry.lookupKey(VERTEX_LAYER_NAME, 'f1/b1#vertex#2')!
    expect(pipeline.registry.lookup(third)!.entityKey).toBe('vtx@C')
  })
})
