// The section's debt to the ID buffer and to the frame loop: moving, flipping
// or toggling it dirties the pick buffer with the 'section' reason, drops any
// hover resolved against the old cut, and turns the section off with a reason
// when a picked plane or face stops resolving.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import type { IdPipeline } from '@/picking/IdPipeline'
import { setLivePipeline } from '@/picking/IdPipelineContext'
import { DEFAULT_PART_EDITOR_DATA, usePartEditorStore } from '@/stores/partEditorStore'
import { DEFAULT_SECTION_STATE, SECTION_SOURCE_GONE_REASON, useSectionStore } from '@/stores/sectionStore'
import { notifySectionChange, useSectionActive, useSectionPipelineEffects } from '@/viewport/useSection'

function fakePipeline(): IdPipeline {
  return {
    isDisposed: () => false,
    markDirty: vi.fn(),
    setSectionActive: vi.fn(),
  } as unknown as IdPipeline
}

const publish = (p: IdPipeline | null) => act(() => setLivePipeline(p))

beforeEach(() => {
  useSectionStore.setState({ ...DEFAULT_SECTION_STATE })
  usePartEditorStore.setState({ ...DEFAULT_PART_EDITOR_DATA })
  publish(null)
})

afterEach(() => {
  cleanup()
  publish(null)
})

describe('notifySectionChange', () => {
  it('dirties the pick buffer before tearing the hover down', () => {
    const order: string[] = []
    notifySectionChange({
      markDirty: reason => order.push(`dirty:${reason}`),
      clearHover: () => order.push('hover'),
    })
    expect(order).toEqual(['dirty:section', 'hover'])
  })
})

describe('useSectionPipelineEffects', () => {
  it('drops the hover and marks the buffer on a toggle, a move and a flip', () => {
    const pipeline = fakePipeline()
    publish(pipeline)
    const clearHover = vi.fn()
    renderHook(() => useSectionPipelineEffects(clearHover))
    clearHover.mockClear()

    act(() => useSectionStore.getState().setEnabled(true))
    act(() => useSectionStore.getState().setOffset(4))
    act(() => useSectionStore.getState().toggleFlipped())

    expect((pipeline.markDirty as ReturnType<typeof vi.fn>).mock.calls.filter(c => c[0] === 'section').length).toBeGreaterThanOrEqual(3)
    expect(clearHover.mock.calls.length).toBeGreaterThanOrEqual(3)
    // The pipeline learns the new state so its ID layers clip and cap.
    expect((pipeline.setSectionActive as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual([true])
  })

  it('does not dirty the buffer on the initial mount', () => {
    const pipeline = fakePipeline()
    publish(pipeline)
    const clearHover = vi.fn()
    renderHook(() => useSectionPipelineEffects(clearHover))
    expect(pipeline.markDirty).not.toHaveBeenCalled()
    expect(clearHover).not.toHaveBeenCalled()
  })

  it('disables an enabled section with a reason when its picked plane is gone', () => {
    publish(fakePipeline())
    act(() => useSectionStore.setState({ enabled: true, plane: { kind: 'query', query: 'deleted-plane' } }))
    renderHook(() => useSectionPipelineEffects(() => {}))

    expect(useSectionStore.getState().enabled).toBe(false)
    expect(useSectionStore.getState().disabledReason).toBe(SECTION_SOURCE_GONE_REASON)
  })

  it('leaves a builtin section enabled', () => {
    publish(fakePipeline())
    act(() => useSectionStore.getState().setEnabled(true))
    renderHook(() => useSectionPipelineEffects(() => {}))
    expect(useSectionStore.getState().enabled).toBe(true)
    expect(useSectionStore.getState().disabledReason).toBeNull()
  })

  it('publishes one active boolean for the render path', () => {
    publish(fakePipeline())
    const { result } = renderHook(() => useSectionActive())
    expect(result.current).toBe(false)

    act(() => useSectionStore.getState().setEnabled(true))
    renderHook(() => useSectionPipelineEffects(() => {}))
    expect(useSectionStore.getState().resolved).toBe(true)

    act(() => useSectionStore.getState().setEnabled(false))
    expect(useSectionStore.getState().resolved).toBe(false)
  })

  it('does not dirty the buffer for a solve that leaves a builtin frame unchanged', () => {
    const pipeline = fakePipeline()
    publish(pipeline)
    const clearHover = () => {}
    act(() => useSectionStore.getState().setEnabled(true))
    renderHook(() => useSectionPipelineEffects(clearHover))
    ;(pipeline.markDirty as ReturnType<typeof vi.fn>).mockClear()

    act(() => usePartEditorStore.setState({ solveResults: {} } as never))
    expect(pipeline.markDirty).not.toHaveBeenCalled()
  })
})
