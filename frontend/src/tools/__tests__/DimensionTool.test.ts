import { describe, it, expect, vi } from 'vitest'
import { createDimensionTool } from '@/tools/DimensionTool'
import type { DimensionToolContext } from '@/tools/DimensionTool'

function createMockContext(overrides: Partial<DimensionToolContext> = {}): DimensionToolContext {
  return {
    normalSelection: new Set<string>(),
    hoveredSelectionId: null,
    isPointerDown: false,
    activeFeatureId: 'S1',
    hoveredVertexId: null,
    hoveredVertexPosition: null,
    hoveredSnapKind: null,
    onMutation: null,
    pushMode: vi.fn(),
    popMode: vi.fn(),
    hoveredEntityKind: null,
    dimensionPicks: [],
    addDimensionPick: vi.fn(),
    ...overrides,
  }
}

describe('DimensionTool', () => {
  describe('onClick', () => {
    it('pushes a line entity click into dimensionPicks', () => {
      const addDimensionPick = vi.fn()
      const tool = createDimensionTool()
      const context = createMockContext({
        addDimensionPick,
        hoveredSelectionId: 'entity:S1:L1',
        hoveredEntityKind: 'line',
      })

      tool.handlers.onClick!({ clientX: 100, clientY: 100 } as PointerEvent, [0, 0], context)

      expect(addDimensionPick).toHaveBeenCalledWith({
        isVertex: false, target: 'entity:S1:L1', entityKind: 'line',
      })
    })

    it('pushes a vertex click with null entityKind', () => {
      const addDimensionPick = vi.fn()
      const tool = createDimensionTool()
      const context = createMockContext({
        addDimensionPick,
        hoveredVertexId: 'vertex:S1:L1:start',
        hoveredEntityKind: null,
      })

      tool.handlers.onClick!({ clientX: 100, clientY: 100 } as PointerEvent, [0, 0], context)

      expect(addDimensionPick).toHaveBeenCalledWith({
        isVertex: true, target: 'vertex:S1:L1:start', entityKind: null,
      })
    })

    it('pushes a circle entity click into dimensionPicks', () => {
      const addDimensionPick = vi.fn()
      const tool = createDimensionTool()
      const context = createMockContext({
        addDimensionPick,
        hoveredSelectionId: 'entity:S1:C1',
        hoveredEntityKind: 'circle',
      })

      tool.handlers.onClick!({ clientX: 100, clientY: 100 } as PointerEvent, [0, 0], context)

      expect(addDimensionPick).toHaveBeenCalledWith({
        isVertex: false, target: 'entity:S1:C1', entityKind: 'circle',
      })
    })

    it('does nothing when no target is hovered', () => {
      const addDimensionPick = vi.fn()
      const tool = createDimensionTool()
      const context = createMockContext({ addDimensionPick })

      tool.handlers.onClick!({ clientX: 0, clientY: 0 } as PointerEvent, [0, 0], context)

      expect(addDimensionPick).not.toHaveBeenCalled()
    })

    it('does nothing when no active feature', () => {
      const addDimensionPick = vi.fn()
      const tool = createDimensionTool()
      const context = createMockContext({
        addDimensionPick,
        activeFeatureId: null,
        hoveredSelectionId: 'entity:S1:L1',
        hoveredEntityKind: 'line',
      })

      tool.handlers.onClick!({ clientX: 0, clientY: 0 } as PointerEvent, [0, 0], context)

      expect(addDimensionPick).not.toHaveBeenCalled()
    })

    it('does not open a dialog directly (placement is store-owned)', () => {
      const addDimensionPick = vi.fn()
      const tool = createDimensionTool()
      const context = createMockContext({
        addDimensionPick,
        hoveredSelectionId: 'entity:S1:C1',
        hoveredEntityKind: 'circle',
      })

      tool.handlers.onClick!({ clientX: 100, clientY: 100 } as PointerEvent, [0, 0], context)

      // No openDialog on context anymore; the tool just accumulates picks.
      expect(addDimensionPick).toHaveBeenCalledTimes(1)
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
