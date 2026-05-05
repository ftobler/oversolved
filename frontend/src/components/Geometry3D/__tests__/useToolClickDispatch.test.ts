import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useToolClickDispatch } from '../useToolClickDispatch'
import { useSketchEditorStore } from '../../../stores/sketchEditorStore'
import { toolRegistry } from '../../../registry/toolRegistry'

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
    onMutation: null,
    pendingPickField: null,
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

  describe('pendingPickField', () => {
    it('commits field pick for non-dimension tools', () => {
      mockGet.mockReturnValue({ handlers: { onClick: vi.fn() } })
      const commitFieldPick = vi.fn()
      const toggleNormalSelection = vi.fn()
      useSketchEditorStore.setState({
        activeTool: 'select',
        pendingPickField: { featureId: 'P1', field: 'sketch' },
      })
      useSketchEditorStore.getState().commitFieldPick = commitFieldPick
      useSketchEditorStore.getState().toggleNormalSelection = toggleNormalSelection

      const { result } = renderHook(() =>
        useToolClickDispatch({ id: 'entity:S1:L1', isEditing: true })
      )
      act(() => result.current(makeClickEvent()))

      expect(toggleNormalSelection).toHaveBeenCalled()
      expect(commitFieldPick).toHaveBeenCalled()
    })

    it('does not commit field pick when dimension tool is active', () => {
      const onClick = vi.fn()
      mockGet.mockReturnValue({ handlers: { onClick } })
      const commitFieldPick = vi.fn()
      useSketchEditorStore.setState({
        activeTool: 'dimension',
        pendingPickField: { featureId: 'P1', field: 'sketch' },
      })
      useSketchEditorStore.getState().commitFieldPick = commitFieldPick

      const { result } = renderHook(() =>
        useToolClickDispatch({ id: 'entity:S1:L1', isEditing: true })
      )
      act(() => result.current(makeClickEvent()))

      expect(commitFieldPick).not.toHaveBeenCalled()
      expect(onClick).toHaveBeenCalled()
    })
  })
})
