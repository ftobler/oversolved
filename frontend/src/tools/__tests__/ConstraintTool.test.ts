import { describe, it, expect, vi } from 'vitest'
import { createConstraintTool } from '@/tools/ConstraintTool'
import type { ConstraintToolContext } from '@/tools/ConstraintTool'

function createMockContext(overrides: Partial<ConstraintToolContext> = {}): ConstraintToolContext {
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
    ...overrides,
  }
}

describe('ConstraintTool', () => {
  describe('onPointerUp', () => {
    it('does not emit when selection below threshold', () => {
      const onMutation = vi.fn()
      const tool = createConstraintTool({ constraintKind: 'coincident', requiresSelection: 2 })
      const context = createMockContext({
        onMutation,
        normalSelection: new Set(['entity:S1:L1']),
      })

      tool.handlers.onPointerUp!({} as PointerEvent, [0, 0], null, context)

      expect(onMutation).not.toHaveBeenCalled()
    })

    it('emits add_constraint with featureId defaulting to S1 when activeFeatureId is null', () => {
      const onMutation = vi.fn()
      const tool = createConstraintTool({ constraintKind: 'horizontal', requiresSelection: 1 })
      const context = createMockContext({
        onMutation,
        activeFeatureId: null,
        normalSelection: new Set(['entity:S1:L1']),
      })

      tool.handlers.onPointerUp!({} as PointerEvent, [0, 0], null, context)

      expect(onMutation).toHaveBeenCalledWith({
        type: 'add_constraint',
        featureId: 'S1',
        kind: 'horizontal',
        targets: ['entity:S1:L1'],
      })
    })

    it('emits add_constraint with activeFeatureId when set', () => {
      const onMutation = vi.fn()
      const tool = createConstraintTool({ constraintKind: 'horizontal', requiresSelection: 1 })
      const context = createMockContext({
        onMutation,
        activeFeatureId: 'customFeat',
        normalSelection: new Set(['entity:S1:L1']),
      })

      tool.handlers.onPointerUp!({} as PointerEvent, [0, 0], null, context)

      expect(onMutation).toHaveBeenCalledWith({
        type: 'add_constraint',
        featureId: 'customFeat',
        kind: 'horizontal',
        targets: ['entity:S1:L1'],
      })
    })

    describe('midpoint constraint', () => {
      it('emits for valid line+point selection', () => {
        const onMutation = vi.fn()
        const tool = createConstraintTool({ constraintKind: 'midpoint', requiresSelection: 2 })
        const context = createMockContext({
          onMutation,
          normalSelection: new Set(['entity:S1:L1', 'vertex:S1:L2:start']),
        })

        tool.handlers.onPointerUp!({} as PointerEvent, [0, 0], null, context)

        expect(onMutation).toHaveBeenCalledWith({
          type: 'add_constraint',
          featureId: 'S1',
          kind: 'midpoint',
          targets: ['entity:S1:L1', 'vertex:S1:L2:start'],
        })
      })

      it('emits for valid 3-vertex selection', () => {
        const onMutation = vi.fn()
        const tool = createConstraintTool({ constraintKind: 'midpoint', requiresSelection: 3 })
        const context = createMockContext({
          onMutation,
          normalSelection: new Set(['vertex:A:a:start', 'vertex:B:b:end', 'vertex:C:c:mid']),
        })

        tool.handlers.onPointerUp!({} as PointerEvent, [0, 0], null, context)

        expect(onMutation).toHaveBeenCalledWith({
          type: 'add_constraint',
          featureId: 'S1',
          kind: 'midpoint',
          targets: ['vertex:A:a:start', 'vertex:B:b:end', 'vertex:C:c:mid'],
        })
      })

      it('does not emit for two entities (invalid midpoint combo)', () => {
        const onMutation = vi.fn()
        const tool = createConstraintTool({ constraintKind: 'midpoint', requiresSelection: 2 })
        const context = createMockContext({
          onMutation,
          normalSelection: new Set(['entity:S1:L1', 'entity:S1:L2']),
        })

        tool.handlers.onPointerUp!({} as PointerEvent, [0, 0], null, context)

        expect(onMutation).not.toHaveBeenCalled()
      })

      it('does not emit for single vertex (below threshold)', () => {
        const onMutation = vi.fn()
        const tool = createConstraintTool({ constraintKind: 'midpoint', requiresSelection: 2 })
        const context = createMockContext({
          onMutation,
          normalSelection: new Set(['vertex:A:a:start']),
        })

        tool.handlers.onPointerUp!({} as PointerEvent, [0, 0], null, context)

        expect(onMutation).not.toHaveBeenCalled()
      })

      it('does not emit for 2 vertices 1 entity (invalid combo)', () => {
        const onMutation = vi.fn()
        const tool = createConstraintTool({ constraintKind: 'midpoint', requiresSelection: 3 })
        const context = createMockContext({
          onMutation,
          normalSelection: new Set(['entity:S1:L1', 'vertex:A:a:start', 'vertex:B:b:end']),
        })

        tool.handlers.onPointerUp!({} as PointerEvent, [0, 0], null, context)

        expect(onMutation).not.toHaveBeenCalled()
      })
    })
  })

  describe('tool properties', () => {
    it('has constraint category', () => {
      const tool = createConstraintTool({ constraintKind: 'coincident', requiresSelection: 2 })
      expect(tool.category).toBe('constraint')
    })

    it('has correct constraintKind', () => {
      const tool = createConstraintTool({ constraintKind: 'midpoint', requiresSelection: 2 })
      expect(tool.constraintKind).toBe('midpoint')
    })

    it('has correct requiresSelection', () => {
      const tool = createConstraintTool({ constraintKind: 'horizontal', requiresSelection: 1 })
      expect(tool.requiresSelection).toBe(1)
    })
  })
})
