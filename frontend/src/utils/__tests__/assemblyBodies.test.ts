import { describe, it, expect } from 'vitest'
import type { EdgeCurve, EntityAnchorIndex } from '@/kernel/partBundle'
import { toBodyResults, toEdgeCurves, assemblyBodyId, buildEntityMateRefs } from '@/utils/assemblyBodies'
import { assemblyBuiltinEntityKey, assemblyEntityKey } from '@/utils/anchorCandidates'
import { ASSEMBLY_HANDLE, ASSEMBLY_ORIGIN_ID, ASSEMBLY_TOP_ID } from '@/utils/builtins'
import { getBodiesToRender } from '@/components/Viewport/bodyUtils'

const edge = (x: number): EdgeCurve => ({
  id: `e${x}`,
  kind: 'line',
  point: [x + 0.5, 0, 0],
  axis: [1, 0, 0],
  endpoints: [[x, 0, 0], [x + 1, 0, 0]],
})

const mesh = (x: number) => ({
  vertices: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
  faceIdsPerTriangle: new Uint32Array([0]),
  edges: [edge(x)],
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

describe('toEdgeCurves', () => {
  it('keys curves by the same body id toBodyResults mints, so the viewport can join them', () => {
    const payload = { h1: [mesh(0)], h2: [mesh(10)] }
    const curves = toEdgeCurves(payload)
    const bodies = toBodyResults(payload)
    expect(Object.keys(curves).sort()).toEqual(Object.keys(bodies).sort())
    for (const item of getBodiesToRender(bodies, undefined, undefined, undefined)) {
      expect(curves[item.bodyId]).toBeDefined()
    }
  })

  it('carries the solved curves through untouched (transforms are baked worker-side)', () => {
    const curves = toEdgeCurves({ h1: [mesh(5)] })
    expect(curves[assemblyBodyId('h1', 0)]).toEqual([edge(5)])
  })

  it('separates the curves of two bodies of one part instance', () => {
    const curves = toEdgeCurves({ h1: [mesh(0), mesh(3)] })
    expect(curves[assemblyBodyId('h1', 0)]).toEqual([edge(0)])
    expect(curves[assemblyBodyId('h1', 1)]).toEqual([edge(3)])
  })

  it('yields an empty list for a body the bundle gave no edges', () => {
    const curves = toEdgeCurves({ h1: [{ ...mesh(0), edges: [] }] })
    expect(curves[assemblyBodyId('h1', 0)]).toEqual([])
  })
})

describe('buildEntityMateRefs', () => {
  const withAnchors = (x: number, entityAnchors: EntityAnchorIndex) => ({ ...mesh(x), entityAnchors })

  it('maps each entity to the mate refs it offers, scoped by part handle', () => {
    const refs = buildEntityMateRefs({
      h1: [withAnchors(0, { faces: [['f0'], ['f1']], edges: [['e0']], vertices: [['v0']] })],
    })
    expect(refs[assemblyEntityKey('h1', 0, 'face', 1)]).toEqual([{ part: 'h1', anchor: 'f1' }])
    expect(refs[assemblyEntityKey('h1', 0, 'edge', 0)]).toEqual([{ part: 'h1', anchor: 'e0' }])
    expect(refs[assemblyEntityKey('h1', 0, 'vertex', 0)]).toEqual([{ part: 'h1', anchor: 'v0' }])
  })

  it('omits an anchor-less entity, so a freeform face offers no pick at all', () => {
    const refs = buildEntityMateRefs({
      h1: [withAnchors(0, { faces: [['f0'], []], edges: [], vertices: [] })],
    })
    expect(refs[assemblyEntityKey('h1', 0, 'face', 0)]).toEqual([{ part: 'h1', anchor: 'f0' }])
    expect(refs[assemblyEntityKey('h1', 0, 'face', 1)]).toBeUndefined()
  })

  it('keeps two instances of one part apart even though they share anchor ids', () => {
    const index: EntityAnchorIndex = { faces: [['f0']], edges: [], vertices: [] }
    const refs = buildEntityMateRefs({ h1: [withAnchors(0, index)], h2: [withAnchors(10, index)] })
    expect(refs[assemblyEntityKey('h1', 0, 'face', 0)]).toEqual([{ part: 'h1', anchor: 'f0' }])
    expect(refs[assemblyEntityKey('h2', 0, 'face', 0)]).toEqual([{ part: 'h2', anchor: 'f0' }])
  })

  it('offers the assembly built-ins as ground under the reserved handle', () => {
    const refs = buildEntityMateRefs({})
    expect(refs[assemblyBuiltinEntityKey(ASSEMBLY_TOP_ID)]).toEqual([
      { part: ASSEMBLY_HANDLE, anchor: ASSEMBLY_TOP_ID },
    ])
    expect(refs[assemblyBuiltinEntityKey(ASSEMBLY_ORIGIN_ID)]).toEqual([
      { part: ASSEMBLY_HANDLE, anchor: ASSEMBLY_ORIGIN_ID },
    ])
  })

  it('a bundle cached before Stage 7 offers no part picks, only the built-ins', () => {
    const refs = buildEntityMateRefs({ h1: [mesh(0)] })  // no entityAnchors
    expect(refs[assemblyEntityKey('h1', 0, 'face', 0)]).toBeUndefined()
    expect(refs[assemblyBuiltinEntityKey(ASSEMBLY_TOP_ID)]).toBeDefined()
  })

  it('indexes several bodies of one part separately', () => {
    const refs = buildEntityMateRefs({
      h1: [
        withAnchors(0, { faces: [['f0']], edges: [], vertices: [] }),
        withAnchors(3, { faces: [['f9']], edges: [], vertices: [] }),
      ],
    })
    expect(refs[assemblyEntityKey('h1', 0, 'face', 0)]).toEqual([{ part: 'h1', anchor: 'f0' }])
    expect(refs[assemblyEntityKey('h1', 1, 'face', 0)]).toEqual([{ part: 'h1', anchor: 'f9' }])
  })
})
