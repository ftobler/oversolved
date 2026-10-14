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

// The preview and session lifecycle at their boundary: a preview opened BEFORE
// a session is resolved at session start, and the session then owns the
// document until commit or cancel (startPreviewMode mid-session is refused).
// The escape hatch for edits that fall outside the preview's scope is covered
// too.
describe('usePartDoc undo preview and session boundary', () => {
  beforeEach(resetHarness)

  it('a colour change inside a suppressed feature session folds into the one edit_session aggregate', () => {
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
    // The colour popover cannot open mid-session, so its mutation lands as an
    // ordinary session edit and is swallowed with the rest.
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    expect(result.current.undoStack).toHaveLength(0)

    act(() => { result.current.commitEditSession() })
    // One aggregate: styleTouched is what forces the entry for the part_style
    // change the session diff cannot see.
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation.type).toBe('edit_session')

    // A single undo reverts the whole session, colour included.
    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('first')
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#ff0000')
  })

  // The session owns the doc until it commits or cancels: startPreviewMode is
  // refused mid-session (pinned in editSessionGuard), so a colour edit made
  // while the popover is "open" is a plain session edit. A session commit
  // therefore folds exactly one aggregate, and the popover's own Cancel has
  // nothing left to rewind.
  it('a suppressed session owns every mid-session edit and folds them into one aggregate at commit', () => {
    docRef.current = {
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000', transparency: 0 } },
      features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    // The session owns the doc until commit or cancel, so the popover cannot
    // open over it; its would-be baseline is never tracked.
    expect(() => {
      act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    }).toThrow(/startPreviewMode called while an edit session is active/)
    act(() => { result.current.handleMutation(renameTo('mid-session')) })
    act(() => { result.current.handleMutation({ type: 'set_part_transparency', bodyId: 'b1', transparency: 0.5 }) })
    expect(result.current.undoStack).toHaveLength(0)

    act(() => { result.current.commitEditSession() })
    // Exactly one aggregate for the whole session, no preview_commit beside it.
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation.type).toBe('edit_session')
    expect((docRef.current.part_style?.b1 as { transparency?: number }).transparency).toBe(0.5)

    // The popover's Cancel finds no preview to rewind and is inert.
    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toBeNull()
    expect((docRef.current.part_style?.b1 as { transparency?: number }).transparency).toBe(0.5)

    // One undo returns to the pre-session doc: rename and colour both reverted.
    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('first')
    expect((docRef.current.part_style?.b1 as { transparency?: number }).transparency).toBe(0)
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#ff0000')
  })

  it('a colour-only suppressed session still folds to one aggregate, not a preview_commit', () => {
    // The popover cannot open mid-session, so a bare colour mutation is
    // swallowed with styleTouched set; the session commit must resolve it as
    // the aggregate entry rather than manufacturing a preview_commit.
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
    expect(result.current.undoStack).toHaveLength(0)

    act(() => { result.current.commitEditSession() })

    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation.type).toBe('edit_session')
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#00ff00')

    // The popover's own Cancel afterward finds nothing left to resolve.
    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toBeNull()
  })

  it('a preview cannot open mid-session: startPreviewMode is refused and leaves the session baseline intact', () => {
    docRef.current = {
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    expect(() => {
      act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    }).toThrow(/startPreviewMode called while an edit session is active/)

    // The refused call did not track a preview or overwrite the session: a
    // commit with no changes leaves no entry, and Cancel has nothing to rewind.
    act(() => { result.current.commitEditSession() })
    expect(result.current.undoStack).toHaveLength(0)
    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toBeNull()
  })

  it('a non-preview edit swallowed by a suppressed session is discarded cleanly by session cancel', () => {
    // The cancel-leg repro: a feature-field edit landing inside a suppressed
    // session used to be swallowed with no entry, and a later Cancel rewinding
    // past the session baseline dropped it silently. Confirms it is discarded
    // together with the whole session, no dead entry left behind either way.
    docRef.current = {
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })

    act(() => { result.current.handleMutation(renameTo('mid-session')) })
    expect(labelOf()).toBe('mid-session')
    expect(result.current.undoStack).toHaveLength(0)

    act(() => { result.current.cancelEditSession() })

    expect(labelOf()).toBe('first')
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(0)

    // The session rewind dropped the swallowed edit; the popover's own Cancel
    // afterward finds no preview and is an inert no-op instead of a second,
    // stale rewind.
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

  it('a colour change in a suppressed session is one aggregate: a single undo returns to the pre-session doc', () => {
    // The popover cannot open mid-session, so the colour mutation is swallowed
    // by the session and folded in by styleTouched. No preview_commit sits on
    // top, and one undo -- not two -- returns to the pre-session doc.
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
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    act(() => { result.current.commitEditSession() })

    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation.type).toBe('edit_session')
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#00ff00')

    // One undo reverts the colour and the rename together, back to the
    // pre-session doc.
    act(() => { result.current.handleUndo() })
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#ff0000')
    expect((docRef.current.features?.[0] as { label?: string }).label).toBe('first')
  })
})
