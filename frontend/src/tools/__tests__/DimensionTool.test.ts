import { describe, it, expect, vi } from 'vitest'
import { createDimensionTool } from '@/tools/DimensionTool'
import type { DimensionToolContext } from '@/tools/DimensionTool'

function createMockContext(overrides: Partial<DimensionToolContext> = {}): DimensionToolContext {
  return {
    normalSelection: new Set<string>(),
    internalHoverSelection: null,
    isPointerDown: false,
    activeFeatureId: 'S1',
    hoveredVertexId: null,
    hoveredVertexPosition: null,
    hoveredSnapKind: null,
    onMutation: null,
    pushMode: vi.fn(),
    popMode: vi.fn(),
    pendingDimTarget: null,
    pendingDimEntityKind: null,
    hoveredEntityKind: null,
    setPendingDim: vi.fn(),
    setActiveTool: vi.fn(),
    openDialog: vi.fn(),
    ...overrides,
  }
}

describe('DimensionTool', () => {
  describe('onClick', () => {
    it('sets pending target for first click on a line', () => {
      const setPendingDim = vi.fn()
      const tool = createDimensionTool()
      const context = createMockContext({
        setPendingDim,
        activeFeatureId: 'S1',
        internalHoverSelection: 'entity:S1:L1',
        hoveredEntityKind: 'line',
      })

      tool.handlers.onClick!({ clientX: 100, clientY: 100 } as PointerEvent, [0, 0], context)

      expect(setPendingDim).toHaveBeenCalledWith('entity:S1:L1', 'line')
    })

    it('sets pending target with null entityKind for vertex', () => {
      const setPendingDim = vi.fn()
      const tool = createDimensionTool()
      const context = createMockContext({
        setPendingDim,
        activeFeatureId: 'S1',
        hoveredVertexId: 'vertex:S1:L1:start',
        hoveredEntityKind: null,
      })

      tool.handlers.onClick!({ clientX: 100, clientY: 100 } as PointerEvent, [0, 0], context)

      expect(setPendingDim).toHaveBeenCalledWith('vertex:S1:L1:start', null)
    })

    it('opens dialog immediately for circle (single-entity dimension)', () => {
      const openDialog = vi.fn()
      const tool = createDimensionTool()
      const context = createMockContext({
        openDialog,
        activeFeatureId: 'S1',
        internalHoverSelection: 'entity:S1:C1',
        hoveredEntityKind: 'circle',
      })

      tool.handlers.onClick!({ clientX: 100, clientY: 100 } as PointerEvent, [0, 0], context)

      expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ label: 'Dimension value' }))
    })

    it('does not open dialog immediately for line (goes pending)', () => {
      const openDialog = vi.fn()
      const setPendingDim = vi.fn()
      const tool = createDimensionTool()
      const context = createMockContext({
        openDialog,
        setPendingDim,
        activeFeatureId: 'S1',
        internalHoverSelection: 'entity:S1:L1',
        hoveredEntityKind: 'line',
      })

      tool.handlers.onClick!({ clientX: 100, clientY: 100 } as PointerEvent, [0, 0], context)

      expect(openDialog).not.toHaveBeenCalled()
      expect(setPendingDim).toHaveBeenCalledWith('entity:S1:L1', 'line')
    })

    it('opens dialog on second click between two vertices', () => {
      const openDialog = vi.fn()
      const tool = createDimensionTool()
      const context = createMockContext({
        openDialog,
        activeFeatureId: 'S1',
        pendingDimTarget: 'vertex:S1:L1:start',
        pendingDimEntityKind: null,
        hoveredVertexId: 'vertex:S1:L2:start',
        hoveredEntityKind: null,
      })

      tool.handlers.onClick!({ clientX: 100, clientY: 100 } as PointerEvent, [0, 0], context)

      expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({
        label: 'Dimension value',
      }))
    })

    it('same entity clicked twice opens single-entity dimension dialog', () => {
      const openDialog = vi.fn()
      const tool = createDimensionTool()
      const context = createMockContext({
        openDialog,
        activeFeatureId: 'S1',
        pendingDimTarget: 'entity:S1:L1',
        pendingDimEntityKind: 'line',
        internalHoverSelection: 'entity:S1:L1',
        hoveredEntityKind: 'line',
      })

      tool.handlers.onClick!({ clientX: 100, clientY: 100 } as PointerEvent, [0, 0], context)

      expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ label: 'Dimension value' }))
    })

    it('line self-dim: null entityKind produces line_distance (bug guard)', () => {
      const openDialog = vi.fn()
      const setPendingDim = vi.fn()
      const tool = createDimensionTool()
      // When entityKind is null (the bug), second click on same line
      // falls through to resolveTwoTargetDimension instead of single-entity path.
      const context = createMockContext({
        openDialog,
        setPendingDim,
        activeFeatureId: 'S1',
        pendingDimTarget: 'entity:S1:L1',
        pendingDimEntityKind: null,
        internalHoverSelection: 'entity:S1:L1',
        hoveredEntityKind: null,
      })

      tool.handlers.onClick!({ clientX: 100, clientY: 100 } as PointerEvent, [0, 0], context)

      // Should still open a dialog (falls through to resolveTwoTargetDimension)
      expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ label: 'Dimension value' }))
    })

    it('emits add_constraint mutation on dialog confirm', () => {
      const onMutation = vi.fn()
      const setActiveTool = vi.fn()
      const tool = createDimensionTool()
      let confirmCb: ((v: string) => void) | undefined
      const context = createMockContext({
        onMutation,
        setActiveTool,
        activeFeatureId: 'S1',
        internalHoverSelection: 'entity:S1:C1',
        hoveredEntityKind: 'circle',
        openDialog: vi.fn((opts) => { confirmCb = opts.onConfirm }),
      })

      tool.handlers.onClick!({ clientX: 100, clientY: 100 } as PointerEvent, [0, 0], context)
      confirmCb!('10')

      expect(onMutation).toHaveBeenCalledWith(expect.objectContaining({
        type: 'add_constraint',
        featureId: 'S1',
      }))
      expect(setActiveTool).toHaveBeenCalledWith(null)
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
