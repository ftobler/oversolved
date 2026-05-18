import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useToolClickDispatch } from '@/components/Geometry3D/useToolClickDispatch'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { toolRegistry } from '@/registry/toolRegistry'

vi.mock('../../../registry/toolRegistry', () => ({
  toolRegistry: { get: vi.fn() },
}))

const mockGet = toolRegistry.get as ReturnType<typeof vi.fn>

function makeClickEvent(x = 100, y = 100) {
  return { stopPropagation: vi.fn(), clientX: x, clientY: y }
}

beforeEach(() => {
  vi.clearAllMocks()
  useSketchEditorStore.setState({
    activeTool: null,
    activeFeatureId: 'S1',
    normalSelection: new Set(),
    dynamicSelection: new Set(),
    internalHoverSelection: 'entity:S1:L1',
    hoveredVertexId: null,
    hoveredVertexPosition: null,
    hoveredSnapKind: null,
    isPointerDown: false,
    pendingDimTarget: null,
    pendingDimEntityKind: null,
  })
})

describe('useToolClickDispatch', () => {
  describe('registry routing', () => {
    it('routes select tool click through registry onClick', () => {
      const onClick = vi.fn()
      mockGet.mockReturnValue({ handlers: { onClick } })
      useSketchEditorStore.setState({ activeTool: 'select' })

      const { result } = renderHook(() =>
        useToolClickDispatch({ id: 'entity:S1:L1', isEditing: true })
      )
      act(() => result.current(makeClickEvent()))

      expect(onClick).toHaveBeenCalled()
    })

    it('routes dimension tool click through registry onClick', () => {
      const onClick = vi.fn()
      mockGet.mockReturnValue({ handlers: { onClick } })
      useSketchEditorStore.setState({ activeTool: 'dimension' })

      const { result } = renderHook(() =>
        useToolClickDispatch({ id: 'entity:S1:L1', isEditing: true, entityKind: 'line' })
      )
      act(() => result.current(makeClickEvent()))

      expect(onClick).toHaveBeenCalled()
    })

    it('does not route dimension click when not editing', () => {
      const onClick = vi.fn()
      mockGet.mockReturnValue({ handlers: { onClick } })
      useSketchEditorStore.setState({ activeTool: 'dimension' })

      const { result } = renderHook(() =>
        useToolClickDispatch({ id: 'entity:S1:L1', isEditing: false })
      )
      act(() => result.current(makeClickEvent()))

      expect(onClick).not.toHaveBeenCalled()
    })

    it('passes hoveredEntityKind to context for dimension tool', () => {
      const onClick = vi.fn()
      mockGet.mockReturnValue({ handlers: { onClick } })
      useSketchEditorStore.setState({ activeTool: 'dimension' })

      const { result } = renderHook(() =>
        useToolClickDispatch({ id: 'entity:S1:C1', isEditing: true, entityKind: 'circle' })
      )
      act(() => result.current(makeClickEvent()))

      const context = onClick.mock.calls[0][2]
      expect(context.hoveredEntityKind).toBe('circle')
    })

    it('falls back to toggleNormalSelection when tool has no onClick', () => {
      mockGet.mockReturnValue({ handlers: {} })
      const toggleNormalSelection = vi.fn()
      useSketchEditorStore.setState({ activeTool: 'select' })
      useSketchEditorStore.getState().toggleNormalSelection = toggleNormalSelection

      const { result } = renderHook(() =>
        useToolClickDispatch({ id: 'entity:S1:L1', isEditing: true })
      )
      act(() => result.current(makeClickEvent()))

      expect(toggleNormalSelection).toHaveBeenCalledWith('entity:S1:L1')
    })
  })


})
