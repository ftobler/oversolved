import { describe, it, expect, vi, beforeEach } from 'vitest'

const exportViaWorker = vi.fn()
vi.mock('@/kernel/worker/solverClient', () => ({ exportViaWorker: (...args: unknown[]) => exportViaWorker(...args) }))

import { EmptyExportError, exportPartBytes, partExportSpec, partSpecFromText } from '@/utils/partExport'
import { clearWorkerFileIds, markFilesSent } from '@/kernel/worker/workerFiles'

// The one part-export path both the editor's dialog and the workspace list's
// row action call. The worker is the only seam mocked: what reaches it is the
// assertion.
const DOC = {
  features: [
    { id: 'Origin', kind: 'origin' },
    { id: 'Top', kind: 'plane' },
    { id: 'imp1', kind: 'import_step', file_id: 'f1' },
    { id: 'extrude1', kind: 'extrude' },
  ],
}

beforeEach(() => {
  exportViaWorker.mockReset()
  clearWorkerFileIds()
})

describe('partExportSpec', () => {
  it('strips the builtin features and stamps the document id', () => {
    const spec = partExportSpec(DOC, 'u1')
    expect(spec.id).toBe('u1')
    expect((spec.features as { id: string }[]).map(f => f.id)).toEqual(['imp1', 'extrude1'])
  })

  it('keeps the document own id when none is given', () => {
    expect(partExportSpec({ ...DOC, id: 'own' }).id).toBe('own')
  })
})

describe('partSpecFromText', () => {
  it('parses stored text, an empty new part included', () => {
    expect(partSpecFromText('kind: part\nfeatures: []\n')).toMatchObject({ kind: 'part', features: [] })
    expect(partSpecFromText('')).toEqual({})
  })
})

describe('exportPartBytes', () => {
  it('resolves the missing referenced files through the resolver and hands them to the worker', async () => {
    exportViaWorker.mockResolvedValue(new Uint8Array([1, 2]))
    const resolveFile = vi.fn(async () => new Uint8Array([7]))
    const spec = partExportSpec(DOC, 'u1')

    const bytes = await exportPartBytes(spec, { format: 'step', bodyId: null, tessellation: 0 }, { resolveFile })

    expect(Array.from(bytes)).toEqual([1, 2])
    expect(resolveFile).toHaveBeenCalledWith('f1')
    const [sent, options, files] = exportViaWorker.mock.calls[0] as [Record<string, unknown>, unknown, Record<string, Uint8Array>]
    expect(sent).toBe(spec)
    expect(options).toEqual({ format: 'step', bodyId: null, tessellation: 0 })
    expect(Array.from(files.f1)).toEqual([7])
  })

  it('does not re-read a file the live worker already holds', async () => {
    markFilesSent({ f1: new Uint8Array([1]) })
    exportViaWorker.mockResolvedValue(new Uint8Array([1]))
    const resolveFile = vi.fn(async () => new Uint8Array([7]))

    await exportPartBytes(partExportSpec(DOC), { format: 'stl', bodyId: null, tessellation: 0.5 }, { resolveFile })

    expect(resolveFile).not.toHaveBeenCalled()
    expect(exportViaWorker.mock.calls[0][2]).toBeUndefined()
  })

  it('turns a null worker answer into the no-geometry error', async () => {
    exportViaWorker.mockResolvedValue(null)
    await expect(
      exportPartBytes(partExportSpec({ features: [] }), { format: 'step', bodyId: null, tessellation: 0 }, null),
    ).rejects.toBeInstanceOf(EmptyExportError)
  })
})
