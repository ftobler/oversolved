import { describe, it, expect, vi } from 'vitest'
import { createSelectionTool } from '../SelectionTool'
import type { SelectionToolContext } from '../SelectionTool'

function createMockContext(overrides: Partial<SelectionToolContext> = {}): SelectionToolContext {
  return {
    selection: new Set<string>(),
    dynamicSelection: new Set<string>(),
    isPointerDown: false,
    activeFeatureId: 'S1',
    hoveredEntityId: null,
    hoveredVertexId: null,
    hoveredVertexPosition: null,
    hoveredSnapKind: null,
    onMutation: null,
    toggleSelect: vi.fn(),
    toggleDynamicSelection: vi.fn(),
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
    it('toggles dynamic selection when pointer is down', () => {
      const tool = createSelectionTool()
      const toggleDynamicSelection = vi.fn()
      const context = createMockContext({
        isPointerDown: true,
        hoveredEntityId: 'entity:S1:L1',
        toggleDynamicSelection,
      })

      tool.handlers.onPointerOver!({} as PointerEvent, [0, 0], context)

      expect(toggleDynamicSelection).toHaveBeenCalledWith('entity:S1:L1')
    })

    it('does not toggle dynamic selection when pointer is up', () => {
      const tool = createSelectionTool()
      const toggleDynamicSelection = vi.fn()
      const context = createMockContext({
        isPointerDown: false,
        hoveredEntityId: 'entity:S1:L1',
        toggleDynamicSelection,
      })

      tool.handlers.onPointerOver!({} as PointerEvent, [0, 0], context)

      expect(toggleDynamicSelection).not.toHaveBeenCalled()
    })
  })

  describe('onClick', () => {
    it('does nothing (handled by useToolClickDispatch)', () => {
      const tool = createSelectionTool()
      const context = createMockContext()

      tool.handlers.onClick!({} as PointerEvent, [0, 0], context)
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