import { describe, it, expect } from 'vitest'
import { validateSketchEditorState, DRAWING_TOOLS } from '@/stores/stateInvariants'
import type { SketchEditorInvariantState } from '@/stores/stateInvariants'

// The module uses import.meta.env which is mocked by vitest.
// We need to test both the invariant logic and the fail-loud mechanism.

function defaultState(): SketchEditorInvariantState {
  return {
    activeTool: null,
    pendingDimTarget: null,
    pendingDimEntityKind: null,
    planeSelectionFeatureId: null,
    drawPoints: [],
    drawHover: null,
    pendingDialog: null,
  }
}

describe('validateSketchEditorState', () => {
  it('passes with default (clean) state', () => {
    expect(() => validateSketchEditorState(defaultState())).not.toThrow()
  })

  describe('pendingDimTarget invariant', () => {
    it('throws when pendingDimTarget is set but activeTool is not dimension', () => {
      const state = { ...defaultState(), pendingDimTarget: 'entity:S1:L1', activeTool: 'line' }
      expect(() => validateSketchEditorState(state)).toThrow('[invariant] pendingDimTarget')
    })

    it('passes when pendingDimTarget is set with activeTool dimension', () => {
      const state = { ...defaultState(), pendingDimTarget: 'entity:S1:L1', activeTool: 'dimension' }
      expect(() => validateSketchEditorState(state)).not.toThrow()
    })

    it('passes when both are null/default', () => {
      const state = { ...defaultState(), pendingDimTarget: null, activeTool: null }
      expect(() => validateSketchEditorState(state)).not.toThrow()
    })
  })

  describe('pendingDimEntityKind invariant', () => {
    it('throws when pendingDimEntityKind set but pendingDimTarget is null', () => {
      const state = { ...defaultState(), pendingDimEntityKind: 'line', pendingDimTarget: null }
      expect(() => validateSketchEditorState(state)).toThrow('[invariant] pendingDimEntityKind')
    })

    it('passes when both are set consistently', () => {
      const state = { ...defaultState(), pendingDimEntityKind: 'line', pendingDimTarget: 'entity:S1:L1', activeTool: 'dimension' }
      expect(() => validateSketchEditorState(state)).not.toThrow()
    })
  })

  describe('planeSelectionFeatureId invariant', () => {
    it('throws when planeSelectionFeatureId is set but activeTool is not null', () => {
      const state = { ...defaultState(), planeSelectionFeatureId: 'Sketch1', activeTool: 'select' }
      expect(() => validateSketchEditorState(state)).toThrow('[invariant] planeSelectionFeatureId')
    })

    it('passes when planeSelectionFeatureId is set with activeTool null', () => {
      const state = { ...defaultState(), planeSelectionFeatureId: 'Sketch1', activeTool: null }
      expect(() => validateSketchEditorState(state)).not.toThrow()
    })
  })

  describe('draw state invariants', () => {
    it('throws when drawPoints has entries but activeTool is not a drawing tool', () => {
      const state = { ...defaultState(), drawPoints: [[1, 2]], activeTool: 'select' }
      expect(() => validateSketchEditorState(state)).toThrow('[invariant] drawPoints')
    })

    it('throws when drawHover is set but activeTool is not a drawing tool', () => {
      const state = { ...defaultState(), drawHover: [3, 4], activeTool: 'drag' }
      expect(() => validateSketchEditorState(state)).toThrow('[invariant] drawHover')
    })

    for (const tool of DRAWING_TOOLS) {
      it(`passes when drawing tool '${tool}' has draw state`, () => {
        const state = { ...defaultState(), drawPoints: [[1, 2]], drawHover: [3, 4], activeTool: tool }
        expect(() => validateSketchEditorState(state)).not.toThrow()
      })
    }

    it('passes when drawPoints is empty and activeTool is not a drawing tool', () => {
      const state = { ...defaultState(), drawPoints: [], drawHover: null, activeTool: 'select' }
      expect(() => validateSketchEditorState(state)).not.toThrow()
    })
  })

  describe('multiple violations', () => {
    it('reports the first violation (pendingDimTarget check)', () => {
      const state = {
        ...defaultState(),
        pendingDimTarget: 'entity:S1:L1',
        planeSelectionFeatureId: 'Sketch1',
        activeTool: 'select',
      }
      // pendingDimTarget check runs first
      expect(() => validateSketchEditorState(state)).toThrow('[invariant] pendingDimTarget')
    })
  })
})
