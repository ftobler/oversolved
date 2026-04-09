import { describe, it, expect, vi } from 'vitest'
import { createSelectionTool } from '../SelectionTool'
import type { SelectionToolContext } from '../SelectionTool'

function createMockContext(overrides: Partial<SelectionToolContext> = {}): SelectionToolContext {
  return {
    normalSelection: new Set<string>(),
    internalHoverSelection: null,
    selection: new Set<string>(),
    hoveredEntityId: null,
    dynamicSelection: new Set<string>(),
    isPointerDown: false,
    activeFeatureId: 'S1',
    hoveredVertexId: null,
    hoveredVertexPosition: null,
    hoveredSnapKind: null,
    onMutation: null,
    setInternalHoverSelection: vi.fn(),
    clearNormalSelection: vi.fn(),
    clearDynamicSelection: vi.fn(),
    toggleNormalSelection: vi.fn(),
    updateDynamicSelection: vi.fn(),
    ...overrides,
  }
}

describe('SelectionTool', () => {
  describe('onPointerDown', () => {
    it('returns null (selection does not initiate drag)', () => {
      const tool = createSelectionTool()
      const context = createMockContext()

      const result = tool.handlers.onPointerDown!({} as PointerEvent, [0, 0], context)

      expect(result).toBeNull()
    })
  })

  describe('onPointerOver', () => {
    it('updates dynamic selection when pointer is down', () => {
      const tool = createSelectionTool()
      const updateDynamicSelection = vi.fn()
      const context = createMockContext({
        isPointerDown: true,
        internalHoverSelection: 'entity:S1:L1',
        updateDynamicSelection,
      })

      tool.handlers.onPointerOver!({} as PointerEvent, [0, 0], context)

      expect(updateDynamicSelection).toHaveBeenCalledWith('entity:S1:L1')
    })

    it('does not update dynamic selection when pointer is up', () => {
      const tool = createSelectionTool()
      const updateDynamicSelection = vi.fn()
      const context = createMockContext({
        isPointerDown: false,
        internalHoverSelection: 'entity:S1:L1',
        updateDynamicSelection,
      })

      tool.handlers.onPointerOver!({} as PointerEvent, [0, 0], context)

      expect(updateDynamicSelection).not.toHaveBeenCalled()
    })
  })

  describe('onClick', () => {
    it('toggles element in normal selection when clicked', () => {
      const tool = createSelectionTool()
      const toggleNormalSelection = vi.fn()
      const context = createMockContext({
        internalHoverSelection: 'entity:S1:L1',
        toggleNormalSelection,
      })

      tool.handlers.onClick!({} as PointerEvent, [0, 0], context)

      expect(toggleNormalSelection).toHaveBeenCalledWith('entity:S1:L1')
    })

    it('clears normal selection when clicking nothing', () => {
      const tool = createSelectionTool()
      const clearNormalSelection = vi.fn()
      const context = createMockContext({
        internalHoverSelection: null,
        clearNormalSelection,
      })

      tool.handlers.onClick!({} as PointerEvent, [0, 0], context)

      expect(clearNormalSelection).toHaveBeenCalled()
    })
  })

  describe('tool properties', () => {
    it('has correct id', () => {
      const tool = createSelectionTool()
      expect(tool.id).toBe('select')
    })

    it('has correct category', () => {
      const tool = createSelectionTool()
      expect(tool.category).toBe('selection')
    })

    it('supports multi-select', () => {
      const tool = createSelectionTool()
      expect(tool.supportsMulti).toBe(true)
    })

    it('supports dynamic selection', () => {
      const tool = createSelectionTool()
      expect(tool.supportsDynamic).toBe(true)
    })

    it('shows in toolbar', () => {
      const tool = createSelectionTool()
      expect(tool.showInToolbar).toBe(true)
    })
  })

  describe('activate/deactivate', () => {
    it('calls activate and deactivate', () => {
      const tool = createSelectionTool()
      const context = createMockContext()

      tool.activate(context)
      tool.deactivate(context)
    })
  })
})
