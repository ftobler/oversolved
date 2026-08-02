import { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { parse as parseYaml } from 'yaml'
import Part from '@/pages/Part'
import { executeCommand } from '@/utils/core/commandRegistry'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { Wrapper, partDocFetchMock } from '@/__tests__/test-utils'

// The code tab replaces the whole document from text without ever touching
// handleMutation, the only place that pushes undo entries. These tests pin the
// consequences of that: the history is dropped instead of left pointing at a
// pre-YAML document, the text edits still count as unsaved, and unparseable
// text can never strand the user's typing.

vi.mock('@/kernel/solveLocally', () => ({
  solveLocally: vi.fn().mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null }),
}))

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule({ cancelPendingFit: vi.fn() }))

// Spied, not replaced: the StrictMode case below counts parses, and only a real
// parse keeps the rest of the page working.
vi.mock('yaml', async () => {
  const actual = await vi.importActual<typeof import('yaml')>('yaml')
  return { ...actual, parse: vi.fn(actual.parse) }
})

const BASE_DOC = `version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    label: Sketch 1
`

const TYPED_DOC = `version: 1
kind: part
features:
  - id: typed1
    kind: sketch
    label: Typed Sketch
`

function renderPart(strict = false) {
  const page = (
    <MemoryRouter initialEntries={['/documents/doc-1']}>
      <Routes>
        <Route path="/documents/:uuid" element={<Part />} />
      </Routes>
    </MemoryRouter>
  )
  return render(strict ? <StrictMode>{page}</StrictMode> : page, { wrapper: Wrapper })
}

function codeArea() {
  return screen.getByPlaceholderText('Document content...') as HTMLTextAreaElement
}

function featureIds() {
  return usePartEditorStore.getState().features.map(f => f.id)
}

async function enterCodeMode() {
  await act(async () => { fireEvent.click(screen.getByTitle('Code mode')) })
  return codeArea()
}

describe('Part - code tab and undo history', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUnsavedChangesStore.setState({ dirty: false, pendingCallback: null })
    vi.stubGlobal('fetch', partDocFetchMock({ content: BASE_DOC }))
  })

  it('drops the undo history when the code tab is opened', async () => {
    renderPart()
    await screen.findByTitle('Feature mode')

    fireEvent.click(screen.getByTitle('Feature mode'))
    await act(async () => { fireEvent.click(screen.getByTitle('Add Extrude (E)')) })
    expect(usePartEditorStore.getState().undoStack).toHaveLength(1)

    await enterCodeMode()

    // Anything still on the stack would restore a document that predates the
    // YAML the user is about to type, so entering the tab is the cut-off point.
    expect(usePartEditorStore.getState().undoStack).toHaveLength(0)
    expect(usePartEditorStore.getState().redoStack).toHaveLength(0)
  })

  it('leaves undo dead after a Run instead of rewinding past the typed YAML', async () => {
    renderPart()
    await screen.findByTitle('Feature mode')

    fireEvent.click(screen.getByTitle('Feature mode'))
    await act(async () => { fireEvent.click(screen.getByTitle('Add Extrude (E)')) })

    const area = await enterCodeMode()
    fireEvent.change(area, { target: { value: TYPED_DOC } })
    await act(async () => { fireEvent.click(screen.getByTitle('Run')) })
    expect(featureIds()).toEqual(['typed1'])
    // Text and document agree after a Run. Only their parsed MEANING can be
    // compared: in the app a landing solve rewrites codeText from the doc while
    // the tab is open, so the raw typed string is not something a test can hold
    // the page to. (No solve lands under jsdom, so here the text is still the
    // text that was run, which satisfies the same assertion.)
    expect(parseYaml(codeArea().value)).toEqual(usePartEditorStore.getState().doc)

    await act(async () => { executeCommand('undo') })

    // The pre-Run stack used to survive, so this undo silently reverted the
    // YAML edit AND the extrude that preceded it in one step.
    expect(featureIds()).toEqual(['typed1'])
    expect(usePartEditorStore.getState().undoStack).toHaveLength(0)
    expect(usePartEditorStore.getState().redoStack).toHaveLength(0)
  })

  it('Run on the unchanged text is a no-op: no dirty flag, no history wipe', async () => {
    renderPart()
    await screen.findByTitle('Feature mode')

    fireEvent.click(screen.getByTitle('Feature mode'))
    await act(async () => { fireEvent.click(screen.getByTitle('Add Extrude (E)')) })
    expect(usePartEditorStore.getState().undoStack).toHaveLength(1)

    // Run without editing the textarea: the text still says exactly what the
    // document says, so running it must not mark the doc dirty or drop the
    // tree edit's undo entry for nothing.
    const area = await enterCodeMode()
    expect(area.value).not.toBe('')
    const before = featureIds()
    useUnsavedChangesStore.getState().setDirty(false)
    await act(async () => { fireEvent.click(screen.getByTitle('Run')) })

    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    expect(usePartEditorStore.getState().undoStack).toHaveLength(0)
    expect(featureIds()).toEqual(before)
  })

  it('an undo taken while the code tab is open cannot leave the textarea stale', async () => {
    renderPart()
    await screen.findByTitle('Feature mode')

    fireEvent.click(screen.getByTitle('Feature mode'))
    await act(async () => { fireEvent.click(screen.getByTitle('Add Extrude (E)')) })

    const shown = (await enterCodeMode()).value
    const before = featureIds()

    await act(async () => { executeCommand('undo') })

    // codeText is re-serialized only on entry into the tab, so an undo that
    // swapped the doc underneath would leave the user editing text for a
    // document that no longer exists. Dropping the history on entry leaves
    // nothing to pop, so this ordering cannot desync at all. The textarea can
    // still drift from the document later (edit the tree twice, then undo), but
    // that drift is display-only now that untyped text is never written back --
    // see the feature-tree case below.
    expect(codeArea().value).toBe(shown)
    expect(featureIds()).toEqual(before)
  })

  it('applies typed YAML and marks the document dirty when leaving the tab without Run', async () => {
    renderPart()
    await screen.findByTitle('Feature mode')

    const area = await enterCodeMode()
    fireEvent.change(area, { target: { value: TYPED_DOC } })
    await act(async () => { fireEvent.click(screen.getByTitle('Feature mode')) })

    expect(featureIds()).toEqual(['typed1'])
    // Without the flag the unsaved-changes guard waves the user off the page and
    // the typed edits are gone with no warning.
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })

  it('leaving the tab with untouched text is not an edit', async () => {
    renderPart()
    await screen.findByTitle('Feature mode')

    await enterCodeMode()
    await act(async () => { fireEvent.click(screen.getByTitle('Feature mode')) })

    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    expect(featureIds()).toEqual(['sk1'])
  })

  it('holds the user on the code tab when the typed YAML does not parse', async () => {
    renderPart()
    await screen.findByTitle('Feature mode')

    const area = await enterCodeMode()
    fireEvent.change(area, { target: { value: 'features: [oops' } })
    await act(async () => { fireEvent.click(screen.getByTitle('Feature mode')) })

    expect(screen.getByTitle('Code mode').className).toContain('active')
    expect(codeArea().value).toBe('features: [oops')
    expect(screen.getByText(/Parse error/)).toBeInTheDocument()
    expect(featureIds()).toEqual(['sk1'])
  })

  it('keeps typed text when the code tab button is clicked while already on it', async () => {
    renderPart()
    await screen.findByTitle('Feature mode')

    const area = await enterCodeMode()
    fireEvent.change(area, { target: { value: TYPED_DOC } })
    await act(async () => { fireEvent.click(screen.getByTitle('Code mode')) })

    // Re-serializing from the doc on every entry used to wipe text that had been
    // typed but not run yet.
    expect(codeArea().value).toBe(TYPED_DOC)
  })

  it('re-serializes the document on re-entry, so applied text comes back normalized', async () => {
    renderPart()
    await screen.findByTitle('Feature mode')

    const area = await enterCodeMode()
    fireEvent.change(area, { target: { value: '{version: 1, kind: part, features: [{id: typed1, kind: sketch}]}' } })
    await act(async () => { fireEvent.click(screen.getByTitle('Feature mode')) })
    await enterCodeMode()

    // The raw typed string is not preserved (a solve write-back would normalize
    // it anyway); what must survive is its meaning.
    const text = codeArea().value
    expect(parseYaml(text)).toEqual({ version: 1, kind: 'part', features: [{ id: 'typed1', kind: 'sketch' }] })
    expect(text).not.toBe('{version: 1, kind: part, features: [{id: typed1, kind: sketch}]}')
  })

  it('marks the document dirty as soon as the user types, before leaving the tab', async () => {
    renderPart()
    await screen.findByTitle('Feature mode')

    const area = await enterCodeMode()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    fireEvent.change(area, { target: { value: TYPED_DOC } })

    // Saving or navigating away WITHOUT leaving the tab drops this text (saveDoc
    // serializes the document, never the textarea), so the warning has to be
    // armed by the typing itself.
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })

  it('keeps a feature-tree edit made while the code tab was open', async () => {
    renderPart()
    await screen.findByTitle('Feature mode')

    await enterCodeMode()
    // The tree stays live in code mode, so codeText (serialized on entry) is
    // already stale by the time the tab is left.
    await act(async () => { fireEvent.click(screen.getByTitle('Hide')) })
    expect(usePartEditorStore.getState().visibleFeatures.has('sk1')).toBe(false)
    expect(usePartEditorStore.getState().undoStack).toHaveLength(1)

    await act(async () => { fireEvent.click(screen.getByTitle('Feature mode')) })

    // Writing the untouched text back would revert the toggle and drop the undo
    // entry that went with it, with nothing left to recover either from.
    expect(usePartEditorStore.getState().visibleFeatures.has('sk1')).toBe(false)
    expect(usePartEditorStore.getState().undoStack).toHaveLength(1)
  })

  it('does not write typed text back over a tree edit made while the tab was open', async () => {
    renderPart()
    await screen.findByTitle('Feature mode')

    const area = await enterCodeMode()
    // Typing marks the text as user intent; a tree edit made after it must not
    // be silently reverted by that stale draft on the way out.
    fireEvent.change(area, { target: { value: TYPED_DOC } })
    await act(async () => { fireEvent.click(screen.getByTitle('Hide')) })
    expect(usePartEditorStore.getState().visibleFeatures.has('sk1')).toBe(false)
    expect(usePartEditorStore.getState().undoStack).toHaveLength(1)

    await act(async () => { fireEvent.click(screen.getByTitle('Feature mode')) })

    // The tree edit survives (its undo entry too), and the typed draft does NOT
    // replace the doc -- it was composed against the pre-edit state.
    expect(usePartEditorStore.getState().visibleFeatures.has('sk1')).toBe(false)
    expect(usePartEditorStore.getState().undoStack).toHaveLength(1)
    expect(featureIds()).toEqual(['sk1'])
  })

  it('does not Run stale text over a tree edit made while the tab was open', async () => {
    renderPart()
    await screen.findByTitle('Feature mode')

    const area = await enterCodeMode()
    // The textarea still holds the pre-edit serialization (no solve lands to
    // rewrite it under jsdom), so Run must refuse to apply it over the tree edit.
    fireEvent.change(area, { target: { value: TYPED_DOC } })
    await act(async () => { fireEvent.click(screen.getByTitle('Hide')) })
    expect(usePartEditorStore.getState().undoStack).toHaveLength(1)

    await act(async () => { fireEvent.click(screen.getByTitle('Run')) })

    // Running the stale text would revert the Hide and drop its undo entry,
    // with nothing left to recover either from.
    expect(usePartEditorStore.getState().visibleFeatures.has('sk1')).toBe(false)
    expect(usePartEditorStore.getState().undoStack).toHaveLength(1)
    expect(featureIds()).toEqual(['sk1'])
  })

  it('closes an open edit session when the code tab is opened', async () => {
    renderPart()
    await screen.findByTitle('Feature mode')

    fireEvent.click(screen.getByTitle('Feature mode'))
    await act(async () => { fireEvent.click(screen.getByTitle('Edit sketch')) })
    expect(usePartEditorStore.getState().editingFeatureId).toBe('sk1')

    await enterCodeMode()

    // The session's snapshot describes a document the code tab is about to
    // replace, and its parked undo stacks are already gone. Left open, a later
    // Cancel would rewind the document to that snapshot and restore nothing.
    expect(usePartEditorStore.getState().editingFeatureId).toBeNull()
    // The teardown falls back to the feature tab when it closes a sketch edit;
    // the tab the user actually asked for has to win that race.
    expect(screen.getByTitle('Code mode').className).toContain('active')
  })

  it('does not start a sketch edit that the code tab refuses to switch for', async () => {
    renderPart()
    await screen.findByTitle('Feature mode')

    const area = await enterCodeMode()
    fireEvent.change(area, { target: { value: 'features: [oops' } })
    await act(async () => { fireEvent.click(screen.getByTitle('Edit sketch')) })

    // Starting the session anyway strands a half-open edit behind the textarea:
    // no sketch toolbar, viewport hidden, and no way to commit or cancel it.
    expect(usePartEditorStore.getState().editingFeatureId).toBeNull()
    expect(screen.getByTitle('Code mode').className).toContain('active')
  })

  describe('YAML that parses but is not a document', () => {
    // yaml.parse returns these happily instead of throwing, and each one used to
    // become the document: features vanish, the history is dropped on the way in,
    // and a Save persists the wreckage.
    const NOT_A_DOCUMENT: [string, string][] = [
      ['empty text', ''],
      ['a scalar', '42'],
      ['a sequence', '- a\n- b'],
    ]

    for (const [label, text] of NOT_A_DOCUMENT) {
      it(`Run refuses ${label}`, async () => {
        renderPart()
        await screen.findByTitle('Feature mode')

        const area = await enterCodeMode()
        fireEvent.change(area, { target: { value: text } })
        await act(async () => { fireEvent.click(screen.getByTitle('Run')) })

        expect(featureIds()).toEqual(['sk1'])
        expect(screen.getByText(/Parse error/)).toBeInTheDocument()
      })

      it(`leaving the tab refuses ${label}`, async () => {
        renderPart()
        await screen.findByTitle('Feature mode')

        const area = await enterCodeMode()
        fireEvent.change(area, { target: { value: text } })
        await act(async () => { fireEvent.click(screen.getByTitle('Feature mode')) })

        expect(featureIds()).toEqual(['sk1'])
        expect(screen.getByTitle('Code mode').className).toContain('active')
        expect(codeArea().value).toBe(text)
      })
    }
  })

  it('parses the typed YAML once per switch under StrictMode', async () => {
    renderPart(true)
    await screen.findByTitle('Feature mode')

    const area = await enterCodeMode()
    fireEvent.change(area, { target: { value: TYPED_DOC } })
    vi.mocked(parseYaml).mockClear()
    await act(async () => { fireEvent.click(screen.getByTitle('Feature mode')) })

    // Parsing inside the setModeRaw updater ran twice per switch, because
    // StrictMode replays updaters. It belongs in the handler.
    expect(parseYaml).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(featureIds()).toEqual(['typed1']))
  })
})
