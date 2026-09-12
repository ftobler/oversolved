import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useFileMeta } from '../useFileMeta'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { getFileRegistry } from '@/stores/fileRegistry'
import { resetFakeIndexedDb } from '@/stores/documentStore/__tests__/fakeIndexedDb'
import { resetDbConnection } from '@/stores/documentStore/idb'
import type { WorkspaceSession } from '@/workspace/session'

// The feature row's file meta resolves session-first: a STEP adopted from a
// folder/zip/.oversolved lives in the workspace, so the flat registry alone
// would read it as "Missing file".

function installSession(readEntry: (id: string) => Promise<unknown>): void {
  useWorkspaceSessionStore.setState({
    session: {
      workspace: 'ws',
      readEntry: vi.fn(readEntry),
    } as unknown as WorkspaceSession,
  })
}

beforeEach(() => {
  useWorkspaceSessionStore.setState({ session: null })
})

describe('useFileMeta', () => {
  it('reads a workspace file entry ahead of the flat registry', async () => {
    installSession(async id => ({
      id, kind: 'file', name: 'adopted.step', mime: 'application/step', fileKind: 'step',
      bytes: new Uint8Array([1, 2, 3, 4]),
    }))
    const { result } = renderHook(() => useFileMeta('f1'))
    await waitFor(() => expect(result.current).not.toBeNull())
    expect(result.current).toMatchObject({ name: 'adopted.step', size: 4, kind: 'step' })
  })

  it('falls back to the flat registry when the workspace has no such entry', async () => {
    resetFakeIndexedDb()
    resetDbConnection()
    const entry = await getFileRegistry().create({
      name: 'staged.step', kind: 'step', mime: 'application/step', bytes: new Uint8Array([1, 2]),
    })
    installSession(async () => { throw new Error('Entry not found: x') })
    const { result } = renderHook(() => useFileMeta(entry.id))
    await waitFor(() => expect(result.current).not.toBeNull())
    expect(result.current).toMatchObject({ name: 'staged.step', size: 2 })
  })

  it('reports missing when neither the workspace nor the registry has the file', async () => {
    resetFakeIndexedDb()
    resetDbConnection()
    installSession(async () => { throw new Error('Entry not found: x') })
    const { result } = renderHook(() => useFileMeta('nope'))
    await waitFor(() => expect(result.current).toBe('missing'))
  })

  it('reports missing for an import with no file reference', () => {
    const { result } = renderHook(() => useFileMeta(undefined))
    expect(result.current).toBe('missing')
  })
})