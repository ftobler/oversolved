// The editor error boundary: a child that throws on render flushes the
// session's shadow copy synchronously (asserted through fake-indexeddb),
// records a crash report, and shows the recovery screen with its two exits.
// The effect-registered case pins the ordering the flush relies on: the
// boundary's catch runs before the failed subtree's passive cleanups, so the
// handle is still registered when it is asked to flush.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useEffect, type ReactNode } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import EditorErrorBoundary from '@/components/misc/EditorErrorBoundary'
import {
  attachAutosave,
  registerRecoveryEditor,
  resetRecoveryEditor,
  type AutosaveHandle,
} from '@/recovery/autosave'
import { readRecoveryJournal } from '@/recovery/journal'
import { listCrashReports } from '@/recovery/crashReports'
import { createDocSession, type DocSession } from '@/session/DocSession'
import { createFakeSolveScheduler } from '@/session/__tests__/fakeSolveScheduler'
import { CommandJournal, journalSink } from '@/drive/journal'
import { docHashOf } from '@/drive/docHash'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import { resetDbConnection } from '@/stores/documentStore/idb'
import type { PartDoc, SketchData } from '@/types/cad'

vi.mock('@/utils/core/downloadBlob', () => ({ downloadBlob: vi.fn() }))

import { downloadBlob } from '@/utils/core/downloadBlob'

function freshDb(): void {
  globalThis.indexedDB = new IDBFactory()
  resetDbConnection()
}

beforeEach(() => {
  freshDb()
  resetRecoveryEditor()
  vi.clearAllMocks()
  // React reports a caught render error to console.error; the suite is not the
  // place to re-print it.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  resetRecoveryEditor()
  vi.restoreAllMocks()
})

function Boom(): ReactNode {
  throw new Error('render exploded')
}

// A child that renders until a flag flips, so the surrounding effects (the
// registry registration among them) have mounted before the throw.
function MaybeBoom({ boom }: { boom: boolean }): ReactNode {
  if (boom) throw new Error('render exploded later')
  return <p>alive</p>
}

interface Harness {
  session: DocSession
  cell: { current: PartDoc | null }
  handle: AutosaveHandle
}

function makeEditor(): Harness {
  const cell: { current: PartDoc | null } = { current: makeDoc(makeSketch('sk1')) }
  const solveResults: { current: Record<string, SketchData> } = { current: {} }
  const journal = new CommandJournal()
  const session = createDocSession({
    cloneDoc: source => structuredClone(source),
    doc: { get: () => cell.current, set: next => { cell.current = next } },
    solve: createFakeSolveScheduler<PartDoc>(),
    solveResults: { get: () => solveResults.current, set: next => { solveResults.current = next } },
    editorFacts: () => ({ editingFeatureId: null, rollbackPosition: null }),
    dirtyFacts: () => ({ dirty: false, saves: 0, savedHash: null }),
    docId: 'doc-1',
    journal: journalSink(journal),
  })
  const handle = attachAutosave({
    session,
    docId: 'doc-1',
    workspace: 'ws-1',
    getRepro: () => journal.repro(),
    getName: () => 'Bracket',
  })
  session.execute({ type: 'add_extrude', featureId: 'ex1', label: 'ex1', sketchQuery: '$sk1', distance: 5 })
  return { session, cell, handle }
}

// The registration pattern the page uses: an effect owns the registry slot,
// and its cleanup unregisters when the subtree unmounts.
function RegisteredEditor({ handle, children }: { handle: AutosaveHandle; children: ReactNode }) {
  useEffect(() => {
    registerRecoveryEditor(handle)
    return () => {
      registerRecoveryEditor(null)
      handle.dispose()
    }
  }, [handle])
  return <>{children}</>
}

describe('EditorErrorBoundary', () => {
  it('flushes the journal from the session and renders the recovery screen', async () => {
    const { cell, handle } = makeEditor()
    registerRecoveryEditor(handle)

    render(
      <EditorErrorBoundary label="editor">
        <Boom />
      </EditorErrorBoundary>,
    )

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('The editor hit an error')).toBeInTheDocument()
    expect(screen.getByText('render exploded')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload editor' })).toBeInTheDocument()

    // The flush read the live doc straight from the session and wrote it.
    await vi.waitFor(async () => {
      const record = await readRecoveryJournal('doc-1')
      expect(record?.docHash).toBe(docHashOf(cell.current))
    })
    // The catch also landed a crash report with the message.
    await vi.waitFor(async () => {
      const reports = await listCrashReports()
      expect(reports[0]?.message).toBe('render exploded')
      expect(reports[0]?.source).toBe('boundary')
    })
    handle.dispose()
  })

  it('flushes before the failed subtree effect cleanup runs', async () => {
    const { cell, handle } = makeEditor()
    const tree = (boom: boolean) => (
      <EditorErrorBoundary label="editor">
        <RegisteredEditor handle={handle}>
          <MaybeBoom boom={boom} />
        </RegisteredEditor>
      </EditorErrorBoundary>
    )
    const view = render(tree(false))
    // The registration effect has run by now; the next render throws.
    view.rerender(tree(true))

    // The effect-registered handle must still have been reachable when the
    // boundary caught: the record holds the doc that was live at the throw.
    await vi.waitFor(async () => {
      const record = await readRecoveryJournal('doc-1')
      expect(record?.docHash).toBe(docHashOf(cell.current))
    })
  })

  it('downloads the captured document and disables the button with no editor', async () => {
    const { handle } = makeEditor()
    registerRecoveryEditor(handle)
    const first = render(
      <EditorErrorBoundary label="editor">
        <Boom />
      </EditorErrorBoundary>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Download document' }))
    expect(downloadBlob).toHaveBeenCalledTimes(1)
    const [blob, filename] = vi.mocked(downloadBlob).mock.calls[0]
    expect(filename).toBe('Bracket.yaml')
    // jsdom's Blob has no text(); FileReader is the readback it supports.
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(blob)
    })
    expect(text).toContain('sk1')
    handle.dispose()

    first.unmount()
    resetRecoveryEditor()
    render(
      <EditorErrorBoundary label="editor">
        <Boom />
      </EditorErrorBoundary>,
    )
    expect(screen.getByRole('button', { name: 'Download document' })).toBeDisabled()
  })

  it('renders children untouched while nothing throws', () => {
    render(
      <EditorErrorBoundary label="viewport">
        <p>healthy editor</p>
      </EditorErrorBoundary>,
    )
    expect(screen.getByText('healthy editor')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
