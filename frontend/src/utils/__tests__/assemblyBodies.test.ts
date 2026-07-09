import { describe, it, expect } from 'vitest'
import { toBodyResults, assemblyBodyId } from '@/utils/assemblyBodies'
import { getBodiesToRender } from '@/components/Viewport/bodyUtils'

const mesh = (x: number) => ({
  vertices: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
  faceIdsPerTriangle: new Uint32Array([0]),
})

describe('toBodyResults', () => {
  it('keys each part instance body by handle so two instances never collide', () => {
    const out = toBodyResults({ h1: [mesh(0)], h2: [mesh(10)] })
    expect(Object.keys(out).sort()).toEqual([assemblyBodyId('h1', 0), assemblyBodyId('h2', 0)].sort())
    expect(out[assemblyBodyId('h1', 0)].created_by).toBe('h1')
  })

  it('carries the solved vertices through untouched (transforms are baked worker-side)', () => {
    const out = toBodyResults({ h1: [mesh(5)] })
    const body = out[assemblyBodyId('h1', 0)]
    expect(body.mesh!.vertices).toEqual(mesh(5).vertices)
    expect(body.mesh!.faces).toEqual(mesh(5).indices)
  })

  it('numbers multiple bodies of one part instance distinctly', () => {
    const out = toBodyResults({ h1: [mesh(0), mesh(3)] })
    expect(Object.keys(out)).toHaveLength(2)
  })

  it('feeds the viewport body-render path unchanged', () => {
    const bodies = toBodyResults({ h1: [mesh(0)], h2: [mesh(10)] })
    const items = getBodiesToRender(bodies, undefined, undefined, undefined)
    expect(items).toHaveLength(2)
    expect(items.map(i => i.bodyId).sort()).toEqual(Object.keys(bodies).sort())
  })
})
