import { describe, it, expect, vi } from 'vitest'
import { createDimensionTool } from '../DimensionTool'
import type { DimensionToolContext } from '../DimensionTool'

function createMockContext(overrides: Partial<DimensionToolContext> = {}): DimensionToolContext {
  return {
    normalSelection: new Set<string>(),
    internalHoverSelection: null,
    dynamicSelection: new Set<string>(),
    isPointerDown: false,
    activeFeatureId: 'S1',
    hoveredVertexId: null,
    hoveredVertexPosition: null,
    hoveredSnapKind: null,
    onMutation: null,
    pendingDimTarget: null,
    pendingDimEntityKind: null,
    setPendingDim: vi.fn(),
    openDialog: vi.fn(),
    ...overrides,
  }
}

describe('DimensionTool', () => {
  describe('onClick', () => {
    it('sets pending target for first click', () => {
      const setPendingDim = vi.fn()
      const tool = createDimensionTool()
      const context = createMockContext({
        setPendingDim,
        activeFeatureId: 'S1',
        internalHoverSelection: 'entity:S1:L1',
      })

      tool.handlers.onClick!({ clientX: 100, clientY: 100 } as PointerEvent, [0, 0], context)

      expect(setPendingDim).toHaveBeenCalled()
    })

    it('sets pending target with entity kind for first click', () => {
      const setPendingDim = vi.fn()
      const tool = createDimensionTool()
      const context = createMockContext({
        setPendingDim,
        activeFeatureId: 'S1',
        internalHoverSelection: 'entity:S1:L1',
      })

      tool.handlers.onClick!({ clientX: 100, clientY: 100 } as PointerEvent, [0, 0], context)

      expect(setPendingDim).toHaveBeenCalledWith('entity:S1:L1', 'L1')
    })

    it('creates point_distance when clicking second vertex', () => {
      const openDialog = vi.fn()
      const tool = createDimensionTool()
      const context = createMockContext({
        openDialog,
        activeFeatureId: 'S1',
        pendingDimTarget: 'vertex:S1:L1:start',
        hoveredVertexId: 'vertex:S1:L2:start',
      })

      tool.handlers.onClick!({ clientX: 100, clientY: 100 } as PointerEvent, [0, 0], context)

      expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({
        label: 'Dimension value',
      }))
    })
  })

  describe('onPointerDown', () => {
    it('returns null', () => {
      const tool = createDimensionTool()
      const context = createMockContext()

      const result = tool.handlers.onPointerDown!({} as PointerEvent, [0, 0], context)

      expect(result).toBeNull()
    })
  })

  describe('tool properties', () => {
    it('has correct id', () => {
      const tool = createDimensionTool()
      expect(tool.id).toBe('dimension')
    })

    it('has correct category', () => {
      const tool = createDimensionTool()
      expect(tool.category).toBe('dimension')
    })

    it('shows in toolbar', () => {
      const tool = createDimensionTool()
      expect(tool.showInToolbar).toBe(true)
    })
  })
})