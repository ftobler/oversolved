import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { EntryMeta } from '@/workspace/types'
import type { WorkspaceSession } from '@/workspace/session'
import { useWhereUsed } from '@/components/layout/filesSeams'

const entries: EntryMeta[] = [
  { id: 'part-1', path: 'documents/Bracket.yaml', kind: 'document', name: 'Bracket', docKind: 'part' },
  { id: 'asm-1', path: 'documents/Gearbox.yaml', kind: 'document', name: 'Gearbox', docKind: 'assembly' },
]

function sessionWith(referenceEdges: () => Promise<Record<string, string[]>>): WorkspaceSession {
  return {
    workspace: 'ws',
    referenceEdges: vi.fn(referenceEdges),
    referencesOf: vi.fn(async () => []),
  } as unknown as WorkspaceSession
}

describe('useWhereUsed', () => {
  it('inverts one referenceEdges read into a document-to-document where-used index', async () => {
    const session = sessionWith(async () => ({ 'asm-1': ['part-1'] }))
    const { result } = renderHook(() => useWhereUsed(session, entries))

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.inverse.get('part-1')).toEqual(['asm-1'])
    expect(session.referenceEdges).toHaveBeenCalledTimes(1)
    // The old body read one metadata row per entry; the index reads the map once.
    expect(session.referencesOf).not.toHaveBeenCalled()
  })

  it('is not ready until the edge map resolves', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const session = sessionWith(async () => {
      await gate
      return { 'asm-1': ['part-1'] }
    })
    const { result } = renderHook(() => useWhereUsed(session, entries))

    expect(result.current.ready).toBe(false)
    expect(result.current.inverse.size).toBe(0)

    release()
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.inverse.get('part-1')).toEqual(['asm-1'])
  })
})
