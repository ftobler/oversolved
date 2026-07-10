import { describe, it, expect } from 'vitest'
import type { AssemblyDoc, BodyResult, PartInstance, Transform3D } from '@/types/cad'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'
import {
  assemblyStlBytes,
  assemblyStlMeshes,
  buildExportParts,
  exportableInstances,
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

function body(id: string, createdBy: string, mesh?: BodyResult['mesh']): BodyResult {
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

describe('assemblyStlMeshes', () => {
  const bodies = {
    'h1:body_0': body('h1:body_0', 'h1', TRI_MESH),
    'h2:body_0': body('h2:body_0', 'h2', TRI_MESH),
  }

  it('scopes bodies to their owning instance via created_by', () => {
    expect(assemblyStlMeshes(bodies, [instance('h1', 'doc_a')])).toHaveLength(1)
    expect(assemblyStlMeshes(bodies, [instance('h1', 'doc_a'), instance('h2', 'doc_b')])).toHaveLength(2)
  })

  it('skips a body with no mesh', () => {
    const withEmpty = { ...bodies, 'h1:body_1': body('h1:body_1', 'h1') }
    expect(assemblyStlMeshes(withEmpty, [instance('h1', 'doc_a')])).toHaveLength(1)
  })

  it('skips a tuple-form mesh rather than mis-reading it as a flat buffer', () => {
    const tuples = {
      't:body_0': body('t:body_0', 't', {
        vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
        faces: [[0, 1, 2]],
      }),
    }
    expect(assemblyStlMeshes(tuples, [instance('t', 'doc_a')])).toEqual([])
  })
})

describe('assemblyStlBytes', () => {
  it('encodes every visible part into one solid', () => {
    const bodies = {
      'h1:body_0': body('h1:body_0', 'h1', TRI_MESH),
      'h2:body_0': body('h2:body_0', 'h2', TRI_MESH),
    }
    const bytes = assemblyStlBytes(bodies, [instance('h1', 'doc_a'), instance('h2', 'doc_b')])!
    expect(bytes.length).toBe(84 + 2 * 50)
    expect(new DataView(bytes.buffer).getUint32(80, true)).toBe(2)
  })

  it('returns null when nothing has geometry, so the caller can say so', () => {
    expect(assemblyStlBytes({}, [instance('h1', 'doc_a')])).toBeNull()
  })
})
