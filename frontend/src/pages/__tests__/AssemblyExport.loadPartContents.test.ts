// The STEP export seam parses each instanced PartDoc verbatim; a legacy part
// with a singular transform `body` must be migrated to the plural `bodies`
// before its B-rep is rehydrated on the OCC worker.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadPartContents } from '@/utils/assemblyExport'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'
import type { PartInstance } from '@/types/cad'

const { loadMock } = vi.hoisted(() => ({ loadMock: vi.fn() }))
vi.mock('@/adapters/backend', () => ({ backendBundle: { documents: { load: loadMock } } }))

function instance(handle: string, doc_id: string): PartInstance {
  return { handle, doc_id, doc_rev: 1, transform: IDENTITY_TRANSFORM }
}

describe('AssemblyExport loadPartContents', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns a migrated doc for legacy singular transform YAML', async () => {
    loadMock.mockResolvedValue({
      content: 'kind: part\nfeatures:\n  - id: t1\n    kind: transform\n    transform:\n      body: "@body_ex1"\n      operation: new\n',
      name: 'Legacy',
    })
    const out = await loadPartContents([instance('h1', 'doc-a')])
    const sub = (out['doc-a'].features as Array<Record<string, unknown>>)[0].transform as Record<string, unknown>
    expect(sub.bodies).toEqual(['@body_ex1'])
    expect('body' in sub).toBe(false)
  })

  it('loads each referenced doc once, keyed by doc id', async () => {
    loadMock.mockResolvedValue({ content: 'kind: part\nfeatures: []', name: 'P' })
    const out = await loadPartContents([instance('h1', 'doc-a'), instance('h2', 'doc-a'), instance('h3', 'doc-b')])
    expect(loadMock).toHaveBeenCalledTimes(2)
    expect(out['doc-a']).toBeDefined()
    expect(out['doc-b']).toBeDefined()
  })
})
