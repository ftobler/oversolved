import { describe, it, expect } from 'vitest'
import { validateSketchEditorState, DRAWING_TOOLS } from '@/stores/stateInvariants'
import type { SketchEditorInvariantState } from '@/stores/stateInvariants'

// The module uses import.meta.env which is mocked by vitest.
// We need to test both the invariant logic and the fail-loud mechanism.

function defaultState(): SketchEditorInvariantState {
  return {
    activeTool: null,
    dimensionPicks: [],
    activePickField: null,
    drawPoints: [],
    drawHover: null,
    pendingDialog: null,
  }
}

describe('validateSketchEditorState', () => {
  it('passes with default (clean) state', () => {
    expect(() => validateSketchEditorState(defaultState())).not.toThrow()
  })

  describe('dimensionPicks invariant', () => {
    it('throws when dimensionPicks is non-empty but activeTool is not dimension', () => {
      const state = { ...defaultState(), dimensionPicks: [{ target: 'entity:S1:L1' }], activeTool: 'line' }
      expect(() => validateSketchEditorState(state)).toThrow('[invariant] dimensionPicks')
    })

    it('passes when dimensionPicks is non-empty with activeTool dimension', () => {
      const state = { ...defaultState(), dimensionPicks: [{ target: 'entity:S1:L1' }], activeTool: 'dimension' }
      expect(() => validateSketchEditorState(state)).not.toThrow()
    })

    it('passes when picks are empty and tool is null', () => {
      const state = { ...defaultState(), dimensionPicks: [], activeTool: null }
      expect(() => validateSketchEditorState(state)).not.toThrow()
    })
  })

  describe('activePickField invariant', () => {
    it('throws when activePickField is set but activeTool is not null', () => {
      const state = { ...defaultState(), activePickField: { featureId: 'Sketch1', field: 'plane' }, activeTool: 'select' }
      expect(() => validateSketchEditorState(state)).toThrow('[invariant] activePickField')
    })

    it('passes when activePickField is set with activeTool null', () => {
      const state = { ...defaultState(), activePickField: { featureId: 'Sketch1', field: 'plane' }, activeTool: null }
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
    it('reports the first violation (dimensionPicks check)', () => {
      const state = {
        ...defaultState(),
        dimensionPicks: [{ target: 'entity:S1:L1' }],
        activePickField: { featureId: 'Sketch1', field: 'plane' },
        activeTool: 'select',
      }
      // dimensionPicks check runs first
      expect(() => validateSketchEditorState(state)).toThrow('[invariant] dimensionPicks')
    })
  })
})
