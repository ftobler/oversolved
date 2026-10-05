// Only the editor's own save knows whether the bytes it wrote are still the
// current document: saveDoc clears dirty only when no edit landed while it was
// in flight. The toolbar Save and Ctrl+S sit on top of that save, so they must
// leave its answer alone. Were either to clear dirty on a resolved true, an edit
// made mid-save would read as saved and a reload would drop it silently.
//
// Driven through the real document hooks and the real toolbars (with the real
// AppHeader, which owns Ctrl+S); only the document store is faked, so each save
// can be held open while the edit lands.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useEffect, useRef } from 'react'

const h = vi.hoisted(() => {
  const gate = () => {
    let resolve!: () => void
    const promise = new Promise<void>(res => { resolve = res })
    return { promise, resolve }
  }
  return {
    gate,
    saveGates: [] as ReturnType<typeof gate>[],
    content: '',
  }
})

vi.mock('@/adapters/backend', () => ({
  backendBundle: {
    documents: {
      load: async () => ({ content: h.content, name: 'Doc' }),
      save: () => {
        const g = h.gate()
        h.saveGates.push(g)
        return g.promise
      },
      rename: async () => {},
      clone: async (uuid: string) => ({ uuid: `${uuid}-copy` }),
    },
  },
}))
import PartToolbar from '@/pages/PartToolbar'
import AssemblyToolbar from '@/pages/AssemblyToolbar'
import { useDocumentState } from '@/hooks/useDocumentState'
import { useAssemblyDoc } from '@/hooks/useAssemblyDoc'
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

// What an editor mutation does: install a fresh doc object (never an in-place
// edit, which is what saveDoc's identity check relies on) and flag dirty.
let editDocument: () => void = () => {}

type Doc = object
interface DocHook {
  doc: Doc | null
  docRef: { current: Doc | null }
  setDoc: (d: never) => void
  saveDoc: (uuid: string, d: never) => Promise<boolean>
}

// The editor pages reduced to their save wiring: the document hook, the guard
// registration Ctrl+S reaches, and the toolbar with the Save button.
function makeEditor(useDoc: () => DocHook, Toolbar: typeof PartToolbar) {
  return function Editor() {
    const { doc, docRef, setDoc, saveDoc } = useDoc()
    const handleSave = async () => (doc ? saveDoc('D', doc as never) : false)
    useUnsavedChangesGuard(handleSave)
    const setDocRef = useRef(setDoc)
    useEffect(() => {
      setDocRef.current = setDoc
      editDocument = () => {
        const edited = { ...docRef.current }
        docRef.current = edited
        setDocRef.current(edited as never)
        useUnsavedChangesStore.getState().setDirty(true)
      }
    })
    if (!doc) return null
    return <Toolbar docName="Doc" onRename={async () => true} handleSave={handleSave} handleClone={() => {}} />
  }
}

const reSolveRef = { current: null }
const PartEditor = makeEditor(
  () => useDocumentState('D', reSolveRef, { solveOnLoad: false }) as unknown as DocHook,
  PartToolbar,
)
const AssemblyEditor = makeEditor(() => useAssemblyDoc('D') as unknown as DocHook, AssemblyToolbar)

const tick = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

async function openEditor(Editor: () => React.ReactElement | null, content: string) {
  h.content = content
  render(
    <MemoryRouter initialEntries={['/workspaces/w/D']}>
      <Editor />
    </MemoryRouter>,
  )
  await tick()
  // The loaded document starts clean; the first edit is what the save is for.
  act(() => { editDocument() })
  expect(useUnsavedChangesStore.getState().dirty).toBe(true)
}

const triggers = {
  'the toolbar Save button': () => fireEvent.click(screen.getByRole('button', { name: 'Save' })),
  'Ctrl+S': () => fireEvent.keyDown(window, { key: 's', ctrlKey: true }),
}

describe.each([
  ['part editor', PartEditor, 'kind: part\nfeatures: []\n'],
  ['assembly editor', AssemblyEditor, 'kind: assembly\nfeatures: []\n'],
])('%s save vs an edit made mid-save', (_name, Editor, content) => {
  beforeEach(() => {
    h.saveGates = []
    useUnsavedChangesStore.getState().setDirty(false)
    useUnsavedChangesStore.getState().setSaveHandler(null)
  })
  afterEach(() => {
    act(() => {
      useUnsavedChangesStore.getState().setDirty(false)
      useUnsavedChangesStore.getState().setSaveHandler(null)
    })
  })

  describe.each(Object.entries(triggers))('through %s', (_trigger, fire) => {
    it('keeps dirty set when an edit lands while the save is in flight', async () => {
      await openEditor(Editor, content)

      await act(async () => { fire() })
      await tick()
      expect(h.saveGates).toHaveLength(1)

      act(() => { editDocument() })
      await act(async () => { h.saveGates[0].resolve() })
      await tick()

      expect(useUnsavedChangesStore.getState().dirty).toBe(true)
      expect(screen.getByRole('button', { name: 'Save' }).classList.contains('dirty')).toBe(true)
    })

    // The control: with no edit in the window, the same path does clear dirty,
    // so the test above is not passing on a save that never clears at all.
    it('clears dirty when nothing was edited during the save', async () => {
      await openEditor(Editor, content)

      await act(async () => { fire() })
      await tick()
      await act(async () => { h.saveGates[0].resolve() })
      await tick()

      expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    })
  })
})
