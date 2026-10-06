import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { PartDoc, Mutation } from '@/types/cad'
import {
  docRef, renameTo, labelOf, sketchEntitiesOf, sketchConstraintsOf, resetHarness,
} from './usePartDoc.undoHarness'

vi.mock('@/hooks/useDocumentState', async () => {
  const { documentStateMock } = await import('./usePartDoc.undoHarness')
  return documentStateMock()
})

vi.mock('@/hooks/useSolver', async () => {
  const { solverMock } = await import('./usePartDoc.undoHarness')
  return solverMock()
})

// The preview lifecycle at the session boundary: opening or applying a preview
// while an edit session is live, committing a session with a preview still open,
// and the escape hatch for edits that fall outside the preview's scope.
describe('usePartDoc undo preview and session boundary', () => {
  beforeEach(resetHarness)

  it('a preview inside a suppressed feature session keeps suppression on and commits beside the aggregate', () => {
    docRef.current = {
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('session-edit')) })
    expect(result.current.undoStack).toHaveLength(0)

    // A color preview opened and applied mid-session.
    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    act(() => { result.current.commitPreview({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })

    // Apply must NOT have reset suppression: the session is still the undo
    // owner, so a later session edit stays swallowed.
    act(() => { result.current.handleMutation(renameTo('still-swallowed')) })
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation.type).toBe('preview_commit')

    act(() => { result.current.commitEditSession() })
    // The session aggregate lands on top of the preview_commit: two real
    // steps, and the session's own edits were never double-recorded.
    expect(result.current.undoStack).toHaveLength(2)
    expect(result.current.undoStack[1].mutation.type).toBe('edit_session')
  })

  // The only ordering the tests above cover is Apply-before-commit (the
  // popover resolves itself, then the session closes). The other ordering --
  // the session commits FIRST, with the popover still open and never Applied
  // -- used to leave previewOriginalDoc pointing at a doc the session had
  // already moved past, so a later Cancel rewound to it and desynced the live
  // doc from the undo stack (undo-preview-session-exit.md repro).
  it('a preview left open when the session commits is resolved at the boundary, not orphaned', () => {
    docRef.current = {
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000', transparency: 0 } },
      features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    // A real, non-style session edit lands while the popover is open. It is
    // not a preview-scope mutation, but the session's own 'all' scope still
    // swallows it whole (the escape gate requires the session itself to not
    // be active), so it earns no entry of its own here either.
    act(() => { result.current.handleMutation(renameTo('mid-session')) })
    act(() => { result.current.handleMutation({ type: 'set_part_transparency', bodyId: 'b1', transparency: 0.5 }) })
    expect(result.current.undoStack).toHaveLength(0)

    // OK on the feature edit fires with the color popover still open (no
    // Apply was ever clicked): the session boundary must resolve the preview
    // itself. The aggregate edit_session is pushed first so the preview_commit
    // sits on top -- the preview was the last interaction, so its undo must
    // come first and not resurrect the swallowed edits on the second undo.
    act(() => { result.current.commitEditSession() })
    expect(result.current.undoStack).toHaveLength(2)
    expect(result.current.undoStack[0].mutation.type).toBe('edit_session')
    expect(result.current.undoStack[1].mutation.type).toBe('preview_commit')
    const afterCommit = structuredClone(docRef.current)

    // The popover is still visually open; dragging it again is now a plain
    // live edit (no preview is tracking it anymore), pushed as its own entry.
    act(() => { result.current.handleMutation({ type: 'set_part_transparency', bodyId: 'b1', transparency: 0.9 }) })
    expect(result.current.undoStack).toHaveLength(3)

    // Cancel finds no active preview -- it was already resolved at the
    // session boundary -- so it must not silently rewind to some other, stale
    // doc. That desync (live doc pointing past what the stack's top entry
    // expects) is exactly what let a cancelled colour resurrect on undo.
    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toBeNull()
    expect((docRef.current.part_style?.b1 as { transparency?: number }).transparency).toBe(0.9)

    // Undo walks back cleanly through all three real entries; the swallowed
    // 0.5 frame never resurfaces as an out-of-band state.
    act(() => { result.current.handleUndo() })
    expect(docRef.current).toEqual(afterCommit)
    act(() => { result.current.handleUndo() })
    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('first')
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#ff0000')
    expect((docRef.current.part_style?.b1 as { transparency?: number }).transparency).toBe(0)
  })

  it('a preview left open when the session commits collapses to the single preview_commit when nothing else in the session changed', () => {
    // Closes the previously-documented gap in the "part_style-only" test
    // below: that test never opens
    // a preview, so a bare set_part_color mutation is swallowed with no
    // resolver at all. Here a preview WAS opened, so the session boundary
    // must resolve it into exactly one preview_commit, not an empty
    // edit_session (part_style is excluded from the aggregate's own diff).
    docRef.current = {
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    expect(result.current.undoStack).toHaveLength(0)

    act(() => { result.current.commitEditSession() })

    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation.type).toBe('preview_commit')
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#00ff00')

    // The popover's own Cancel afterward finds nothing left to resolve.
    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toBeNull()
  })

  it('a preview opened but never touched leaves nothing behind when the session commits', () => {
    docRef.current = {
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.commitEditSession() })

    expect(result.current.undoStack).toHaveLength(0)
    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toBeNull()
  })

  it('a non-preview edit swallowed while the popover stays open is discarded cleanly by session cancel', () => {
    // The cancel-leg repro: a feature-field edit landing inside a suppressed
    // session while the popover is open used to be swallowed with no entry
    // (the escape gate required the session itself to not be active), and a
    // later Cancel rewinding past the session snapshot dropped it silently.
    // Confirms it is discarded together with the whole session, no dead entry
    // left behind either way.
    docRef.current = {
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })

    act(() => { result.current.handleMutation(renameTo('mid-popover')) })
    expect(labelOf()).toBe('mid-popover')
    expect(result.current.undoStack).toHaveLength(0)

    act(() => { result.current.cancelEditSession() })

    expect(labelOf()).toBe('first')
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(0)

    // previewOriginalDoc was dropped WITH the session rather than rewound
    // through, so the popover's own Cancel afterward is an inert no-op instead
    // of a second, stale rewind.
    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toBeNull()
  })

  it('a nested startPreviewMode fails loud and leaves the first preview baseline intact', () => {
    docRef.current = {
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
    const baseline = structuredClone(docRef.current)

    act(() => { result.current.startPreviewMode(baseline) })
    expect(() => {
      act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    }).toThrow(/nested preview/)

    // The nested call returned before touching the baseline: a slider move
    // still swallows and the commit restores the FIRST preview's pre-preview
    // doc, proving the baseline was not overwritten.
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    act(() => { result.current.commitPreview({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    expect(result.current.undoStack).toHaveLength(1)
    expect((result.current.undoStack[0].doc.part_style?.b1 as { color?: string }).color).toBe('#ff0000')
  })

  it('a solve-fabricated part_style entry does not manufacture a phantom preview_commit', () => {
    docRef.current = {
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    // No slider was touched. A solve reconciles part_style and fabricates an
    // entry for a body that had none; nothing else changed.
    docRef.current.part_style = { ...(docRef.current.part_style ?? {}), b2: { name: 'part 2', color: '#00ff00' } }
    act(() => { result.current.commitPreview({ type: 'set_part_color', bodyId: 'b1', color: '#ff0000' }) })

    expect(result.current.undoStack).toHaveLength(0)
  })

  it('an end-snapped line mid-preview escapes: color folds into preview_commit and the group keeps its own entry', () => {
    docRef.current = {
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'sk1', kind: 'sketch' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    // A snapped line routes through commitMutationGroup while the popover is
    // open; it is not a preview-scope mutation, so it escapes the same way a
    // single sketch edit does.
    act(() => {
      result.current.commitMutationGroup([
        { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 5, 5], entityId: 'l2' },
        { type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['vertex:sk1:l2:start', 'entity:sk1:l1'] },
      ] as Mutation[])
    })

    expect(result.current.undoStack).toHaveLength(2)
    expect(result.current.undoStack[0].mutation.type).toBe('preview_commit')
    expect(result.current.undoStack[1].mutation.type).toBe('add_entity')
    expect(sketchEntitiesOf().some(e => e.id === 'l2')).toBe(true)
    expect(sketchConstraintsOf()).toHaveLength(1)
  })

  it('a suppressed session whose only change is part_style still leaves an undo entry', () => {
    // part_style is excluded from the session diff because the solver
    // fabricates it during a solve, but a genuine user color change swallowed
    // by the session is a real edit that must stay undoable -- otherwise the
    // change lands in the doc (and dirties it) yet can never be reverted.
    docRef.current = {
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    act(() => { result.current.commitEditSession() })

    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation.type).toBe('edit_session')
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#00ff00')

    // Undo reverts the swallowed color back to what the session started with.
    act(() => { result.current.handleUndo() })
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#ff0000')
  })

  it('a preview opened mid suppressed session commits preview_commit on top so two undos return to the pre-session doc', () => {
    // The popover is opened AFTER the session already has edits (so its baseline
    // is the edited doc, not the pre-session one). The color is the last thing
    // the user touched, so undo must revert the color first and the edits
    // second -- never resurrect the swallowed edits on the second undo.
    docRef.current = {
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('edited')) })
    // Open the color preview now, while the session already holds the rename.
    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    act(() => { result.current.commitEditSession() })

    // Top entry is the preview_commit (last interaction); beneath it the
    // aggregate edit_session that restores the pre-session doc.
    expect(result.current.undoStack).toHaveLength(2)
    expect(result.current.undoStack[0].mutation.type).toBe('edit_session')
    expect(result.current.undoStack[1].mutation.type).toBe('preview_commit')
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#00ff00')

    // Undo 1: revert the color only, the rename stays.
    act(() => { result.current.handleUndo() })
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#ff0000')
    expect((docRef.current.features?.[0] as { label?: string }).label).toBe('edited')

    // Undo 2: revert the edits, back to the pre-session doc.
    act(() => { result.current.handleUndo() })
    expect((docRef.current.features?.[0] as { label?: string }).label).toBe('first')
  })
})
