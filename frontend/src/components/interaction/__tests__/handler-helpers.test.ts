import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { DragInit } from '../interaction-actions'
import type { FieldPickState } from '../../Sidebar'
import type { Point } from '../../../types/cad'
import {
  buildClickHandler,
  buildDragPointerDownHandler,
  buildDragPointerUpHandler,
} from '../handler-helpers'

const POS: Point = [0, 0]

// Mock store actions
const mockSetDrag = vi.fn()
const mockSetOrbitEnabled = vi.fn()
const mockToggleSelect = vi.fn()
const mockCommitFieldPick = vi.fn()
const mockHandleDimensionClick = vi.fn()
const mockOnMutation = vi.fn()

describe('handler-helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('buildClickHandler', () => {
    it('early returns when !isEditing', () => {
      const handler = buildClickHandler(
        mockHandleDimensionClick,
        mockToggleSelect,
        null,
        mockCommitFieldPick,
        false, // isEditing = false
      )
      handler({ stopPropagation: vi.fn(), clientX: 100, clientY: 100 })
      expect(mockToggleSelect).not.toHaveBeenCalled()
    })

    it('returns handler when isEditing=true', () => {
      const handler = buildClickHandler(
        mockHandleDimensionClick,
        mockToggleSelect,
        null,
        mockCommitFieldPick,
        true, // isEditing = true
      )
      expect(typeof handler).toBe('function')
    })

    it('commits field pick when fieldPickState.kind === "line"', () => {
      const fieldPickState: FieldPickState = { kind: 'line', featureId: 'S1', field: 'line1' }
      const handler = buildClickHandler(
        mockHandleDimensionClick,
        mockToggleSelect,
        fieldPickState,
        mockCommitFieldPick,
        true,
      )
      handler({ stopPropagation: vi.fn(), clientX: 100, clientY: 100 })
      expect(mockCommitFieldPick).toHaveBeenCalledOnce()
    })
  })

  describe('buildDragPointerDownHandler', () => {
    it('returns null and doesn\'t set drag when !isEditing', () => {
      const handler = buildDragPointerDownHandler(
        mockSetDrag,
        mockSetOrbitEnabled,
        false,
        'select',
      )
      const result = handler({} as PointerEvent, POS)
      expect(result).toBeNull()
      expect(mockSetDrag).not.toHaveBeenCalled()
    })

    it('returns drag state and sets drag when isEditing && activeTool === "select"', () => {
      const handler = buildDragPointerDownHandler(
        mockSetDrag,
        mockSetOrbitEnabled,
        true,
        'select',
      )
      const result = handler({} as PointerEvent, POS)
      expect(result).not.toBeNull()
      expect(mockSetDrag).toHaveBeenCalledOnce()
      expect(mockSetOrbitEnabled).toHaveBeenCalledWith(false)
    })

    it('returns null when activeTool !== "select"', () => {
      const handler = buildDragPointerDownHandler(
        mockSetDrag,
        mockSetOrbitEnabled,
        true,
        'line', // Not select tool
      )
      const result = handler({} as PointerEvent, POS)
      expect(result).toBeNull()
    })
  })

  describe('buildDragPointerUpHandler', () => {
    it('treats small deltas as clicks (clears drag state)', () => {
      const drag: DragInit = {
        type: 'edge',
        vertexId: 'entity:S1:L1',
        featureId: 'S1',
        entityId: 'L1',
        vertexKey: 'edge',
        startWorld: [0, 0],
        startClient: [100, 100],
      }

      const handler = buildDragPointerUpHandler(
        drag,
        mockSetDrag,
        mockSetOrbitEnabled,
        mockOnMutation,
      )

      // Small delta (< 4px) — should clear state
      handler({} as PointerEvent, [0.1, 0.1])
      expect(mockSetDrag).toHaveBeenCalledWith(null)
      expect(mockSetOrbitEnabled).toHaveBeenCalledWith(true)
    })

    it('treats large deltas as drags (clears state and calls mutation)', () => {
      const drag: DragInit = {
        type: 'edge',
        vertexId: 'entity:S1:L1',
        featureId: 'S1',
        entityId: 'L1',
        vertexKey: 'edge',
        startWorld: [0, 0],
        startClient: [100, 100],
      }

      const handler = buildDragPointerUpHandler(
        drag,
        mockSetDrag,
        mockSetOrbitEnabled,
        mockOnMutation,
      )

      // Large delta (>= 4px) — should clear state
      handler({} as PointerEvent, [10, 10])
      expect(mockSetDrag).toHaveBeenCalledWith(null)
    })

    it('clears drag state when no mutation handler', () => {
      const drag: DragInit = {
        type: 'edge',
        vertexId: 'entity:S1:L1',
        featureId: 'S1',
        entityId: 'L1',
        vertexKey: 'edge',
        startWorld: [0, 0],
        startClient: [100, 100],
      }

      const handler = buildDragPointerUpHandler(
        drag,
        mockSetDrag,
        mockSetOrbitEnabled,
        null,
      )

      handler({} as PointerEvent, [0, 0])
      expect(mockSetDrag).toHaveBeenCalledWith(null)
    })
  })

  describe('Integration patterns', () => {
    it('click to select: handler builds click behavior correctly', () => {
      const toggleSelect = vi.fn()
      const handler = buildClickHandler(
        mockHandleDimensionClick,
        toggleSelect,
        null,
        mockCommitFieldPick,
        true,
      )

      const event = { stopPropagation: vi.fn(), clientX: 100, clientY: 100 }
      handler(event)

      expect(event.stopPropagation).toHaveBeenCalledOnce()
      expect(toggleSelect).toHaveBeenCalledOnce()
    })
  })
})
