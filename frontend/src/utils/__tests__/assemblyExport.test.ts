import { describe, it, expect, vi } from 'vitest'
import type { AssemblyDoc, PartResult, PartInstance, Transform3D } from '@/types/cad'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'
import {
  assemblyStlBytes,
  assemblyStlMeshes,
  buildExportParts,
  buildExportPartsFromLeaves,
  exportableInstances,
  flattenExportLeaves,
} from '@/utils/assemblyExport'

const MOVED: Transform3D = { tx: 10, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }

function instance(handle: string, doc_id: string, extra: Partial<PartInstance> = {}): PartInstance {
  return { handle, doc_id, doc_rev: 1, transform: IDENTITY_TRANSFORM, ...extra }
}

function doc(instances: PartInstance[]): AssemblyDoc {
  return {
    kind: 'assembly',
    features: instances.map(i => ({ id: `f_${i.handle}`, kind: 'part_instance' as const, instance: i })),
  }
}

function part(id: string, createdBy: string, mesh?: PartResult['mesh']): PartResult {
  return { id, created_by: createdBy, modified_by: [], mesh }
}

/** One triangle, in the typed-array form the assembly solve always produces. */
const TRI_MESH = {
  vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  faces: new Uint32Array([0, 1, 2]),
}

describe('exportableInstances', () => {
  it('returns part instances in document order', () => {
    const d = doc([instance('h1', 'doc_a'), instance('h2', 'doc_b')])
    expect(exportableInstances(d).map(i => i.handle)).toEqual(['h1', 'h2'])
  })

  it('drops a hidden instance: the export mirrors the visible scene', () => {
    const d = doc([instance('h1', 'doc_a', { visible: false }), instance('h2', 'doc_b')])
    expect(exportableInstances(d).map(i => i.handle)).toEqual(['h2'])
  })

  it('keeps an instance whose visible flag was never written', () => {
    expect(exportableInstances(doc([instance('h1', 'doc_a')]))).toHaveLength(1)
  })

  it('ignores mate features and an empty document', () => {
    const d: AssemblyDoc = {
      kind: 'assembly',
      features: [{ id: 'm1', kind: 'mate', mate: undefined }],
    }
    expect(exportableInstances(d)).toEqual([])
    expect(exportableInstances({ kind: 'assembly', features: [] })).toEqual([])
  })
})

describe('buildExportParts', () => {
  const contents = {
    doc_a: { id: 'ignored', features: [{ id: 'Origin' }, { id: 'Top' }, { id: 'ex1' }] },
    doc_b: { features: [{ id: 'ex2' }] },
  }

  it('strips the built-in features and stamps the part doc id onto the spec', () => {
    const parts = buildExportParts([instance('h1', 'doc_a')], {}, contents)
    expect(parts).toHaveLength(1)
    expect(parts[0].spec.id).toBe('doc_a')
    expect(parts[0].spec.features).toEqual([{ id: 'ex1' }])
  })

  it('carries the solved transform, not the placed seed', () => {
    const parts = buildExportParts([instance('h1', 'doc_a')], { h1: MOVED }, contents)
    expect(parts[0].transform).toEqual(MOVED)
  })

  it('falls back to the seed transform when the solve produced none for a handle', () => {
    const parts = buildExportParts([instance('h1', 'doc_a', { transform: MOVED })], {}, contents)
    expect(parts[0].transform).toEqual(MOVED)
  })

  it('exports two instances of one part at their own transforms', () => {
    const parts = buildExportParts(
      [instance('h1', 'doc_a'), instance('h2', 'doc_a')],
      { h1: IDENTITY_TRANSFORM, h2: MOVED },
      contents,
    )
    expect(parts.map(p => p.transform)).toEqual([IDENTITY_TRANSFORM, MOVED])
  })

  it('skips an instance whose part document could not be loaded', () => {
    const parts = buildExportParts([instance('h1', 'missing'), instance('h2', 'doc_b')], {}, contents)
    expect(parts).toHaveLength(1)
    expect(parts[0].spec.id).toBe('doc_b')
  })

  it('treats a feature-less part document as having no features', () => {
    const parts = buildExportParts([instance('h1', 'doc_c')], {}, { doc_c: {} })
    expect(parts[0].spec.features).toEqual([])
  })
})

describe('flattenExportLeaves', () => {
  const childLeaves = (handle: string) => ({
    [handle]: [
      { doc_id: 'part_left', transform: { ...IDENTITY_TRANSFORM, tx: 100 }, visible: true, path: 'left' },
      { doc_id: 'part_right', transform: { ...IDENTITY_TRANSFORM, tx: 110 }, visible: true, path: 'right' },
    ],
  })

  it('replaces a sub-assembly instance with its leaves at composed world poses', () => {
    const leaves = flattenExportLeaves([instance('sub', 'asm-child')], childLeaves('sub'))
    expect(leaves).toEqual([
      { doc_id: 'part_left', transform: { ...IDENTITY_TRANSFORM, tx: 100 } },
      { doc_id: 'part_right', transform: { ...IDENTITY_TRANSFORM, tx: 110 } },
    ])
  })

  it('drops a hidden leaf and a view-hidden child row', () => {
    const hidden = flattenExportLeaves([instance('sub', 'asm-child')], childLeaves('sub'), new Set(['sub/right']))
    expect(hidden.map(leaf => leaf.doc_id)).toEqual(['part_left'])

    const docHidden = childLeaves('sub')
    docHidden.sub[1] = { ...docHidden.sub[1], visible: false }
    expect(flattenExportLeaves([instance('sub', 'asm-child')], docHidden).map(l => l.doc_id))
      .toEqual(['part_left'])
  })

  it('falls back to the instance seed when no solve produced leaves', () => {
    const leaves = flattenExportLeaves([instance('h1', 'doc_a', { transform: MOVED })], {})
    expect(leaves).toEqual([{ doc_id: 'doc_a', transform: MOVED }])
  })

  it('emits one export spec per leaf, even for two leaves of the same document', () => {
    const contents = { part_left: { features: [{ id: 'Origin' }, { id: 'ex1' }] } }
    const parts = buildExportPartsFromLeaves(
      [
        { doc_id: 'part_left', transform: { ...IDENTITY_TRANSFORM, tx: 1 } },
        { doc_id: 'part_left', transform: { ...IDENTITY_TRANSFORM, tx: 2 } },
      ],
      contents,
    )
    expect(parts.map(part => part.transform.tx)).toEqual([1, 2])
    expect(parts[0].spec.features).toEqual([{ id: 'ex1' }])
  })
})

describe('assemblyStlMeshes', () => {
  const parts = {
    'h1:body_0': part('h1:body_0', 'h1', TRI_MESH),
    'h2:body_0': part('h2:body_0', 'h2', TRI_MESH),
  }

  it('scopes bodies to their owning instance via created_by', () => {
    expect(assemblyStlMeshes(parts, [instance('h1', 'doc_a')])).toHaveLength(1)
    expect(assemblyStlMeshes(parts, [instance('h1', 'doc_a'), instance('h2', 'doc_b')])).toHaveLength(2)
  })

  it('skips a body with no mesh', () => {
    const withEmpty = { ...parts, 'h1:body_1': part('h1:body_1', 'h1') }
    expect(assemblyStlMeshes(withEmpty, [instance('h1', 'doc_a')])).toHaveLength(1)
  })

  it('skips a tuple-form mesh rather than mis-reading it as a flat buffer', () => {
    const tuples = {
      't:body_0': part('t:body_0', 't', {
        vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
        faces: [[0, 1, 2]],
      }),
    }
    expect(assemblyStlMeshes(tuples, [instance('t', 'doc_a')])).toEqual([])
  })

  // A quiet skip used to hand the user an STL missing bodies they can see on
  // screen; the skip must at least name the body it drops.
  it('warns once, naming the body, when a tuple-form mesh is skipped', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const mixed = {
      'h1:body_0': part('h1:body_0', 'h1', TRI_MESH),
      't:body_0': part('t:body_0', 't', {
        vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
        faces: [[0, 1, 2]],
      }),
    }
    const meshes = assemblyStlMeshes(mixed, [instance('h1', 'doc_a'), instance('t', 'doc_a')])
    expect(meshes).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0][0]).toContain('t:body_0')
    warnSpy.mockRestore()
  })
})

describe('assemblyStlBytes', () => {
  it('encodes every visible part into one solid', () => {
    const parts = {
      'h1:body_0': part('h1:body_0', 'h1', TRI_MESH),
      'h2:body_0': part('h2:body_0', 'h2', TRI_MESH),
    }
    const bytes = assemblyStlBytes(parts, [instance('h1', 'doc_a'), instance('h2', 'doc_b')])!
    expect(bytes.length).toBe(84 + 2 * 50)
    expect(new DataView(bytes.buffer).getUint32(80, true)).toBe(2)
  })

  it('returns null when nothing has geometry, so the caller can say so', () => {
    expect(assemblyStlBytes({}, [instance('h1', 'doc_a')])).toBeNull()
  })
})
