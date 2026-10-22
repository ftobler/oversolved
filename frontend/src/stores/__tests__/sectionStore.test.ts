// The section is viewer state: it may be toggled and moved freely, but it must
// never reach the document, the undo stacks or the preferences port. Defaults
// keep the scene exactly as it was before the feature existed.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { backendBundle } from '@/adapters/backend'
import { DEFAULT_PART_EDITOR_DATA, usePartEditorStore } from '@/stores/partEditorStore'
import { DEFAULT_SECTION_STATE, SECTION_SOURCE_GONE_REASON, useSectionStore } from '@/stores/sectionStore'

describe('section store', () => {
  beforeEach(() => {
    useSectionStore.setState({ ...DEFAULT_SECTION_STATE })
    usePartEditorStore.setState({ ...DEFAULT_PART_EDITOR_DATA })
    vi.restoreAllMocks()
  })

  it('starts off, on the front plane, unflipped and unoffset', () => {
    const state = useSectionStore.getState()
    expect(state.enabled).toBe(false)
    expect(state.plane).toEqual({ kind: 'builtin', id: 'front' })
    expect(state.offset).toBe(0)
    expect(state.flipped).toBe(false)
    expect(state.disabledReason).toBeNull()
    expect(state.picking).toBe(false)
  })

  it('toggles, flips and resets without touching the document', () => {
    const before = usePartEditorStore.getState()
    const save = vi.spyOn(backendBundle.preferences, 'save')

    useSectionStore.getState().setEnabled(true)
    useSectionStore.getState().setOffset(12.5)
    useSectionStore.getState().toggleFlipped()

    expect(useSectionStore.getState().enabled).toBe(true)
    expect(useSectionStore.getState().offset).toBe(12.5)
    expect(useSectionStore.getState().flipped).toBe(true)
    // No document write, no history entry and no preference write.
    expect(usePartEditorStore.getState().doc).toBe(before.doc)
    expect(usePartEditorStore.getState().features).toBe(before.features)
    expect(save).not.toHaveBeenCalled()

    useSectionStore.getState().reset()
    expect(useSectionStore.getState().enabled).toBe(false)
    expect(useSectionStore.getState().offset).toBe(0)
    expect(useSectionStore.getState().flipped).toBe(false)
  })

  it('refuses a non-finite offset instead of moving the plane to NaN', () => {
    useSectionStore.getState().setOffset(4)
    useSectionStore.getState().setOffset(Number.NaN)
    expect(useSectionStore.getState().offset).toBe(4)
    useSectionStore.getState().setOffset(Number.POSITIVE_INFINITY)
    expect(useSectionStore.getState().offset).toBe(4)
  })

  it('stores a picked plane or face and clears the pick arm', () => {
    useSectionStore.getState().setPicking(true)
    useSectionStore.getState().setPlane({ kind: 'query', query: '?04;abcd' })
    expect(useSectionStore.getState().plane).toEqual({ kind: 'query', query: '?04;abcd' })
    useSectionStore.getState().setPicking(false)
    expect(useSectionStore.getState().picking).toBe(false)
  })

  it('disables with a reason when the source stops resolving, and clears it on a manual toggle', () => {
    useSectionStore.getState().setEnabled(true)
    useSectionStore.getState().disable(SECTION_SOURCE_GONE_REASON)
    expect(useSectionStore.getState().enabled).toBe(false)
    expect(useSectionStore.getState().disabledReason).toBe(SECTION_SOURCE_GONE_REASON)

    useSectionStore.getState().setEnabled(true)
    expect(useSectionStore.getState().disabledReason).toBeNull()
  })
})
