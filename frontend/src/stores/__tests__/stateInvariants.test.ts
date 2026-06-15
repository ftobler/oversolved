import { describe, it, expect } from 'vitest'
import { validateSketchEditorState, validateSelectionState, repairSelectionState, DRAWING_TOOLS, deriveSelectionDomain } from '@/stores/stateInvariants'
import type { SketchEditorInvariantState, SelectionInvariantState } from '@/stores/stateInvariants'

function defaultSelectionState(): SelectionInvariantState {
  return {
    normalSelection: new Set(),
    chipOwnedSelection: new Set(),
    selectionDomain: 'sketch_2d',
  }
}

function defaultState(): SketchEditorInvariantState {
  return {
    ...defaultSelectionState(),
    activeTool: null,
    dimensionPicks: [],
    activePickField: null,
    drawPoints: [],
    drawHover: null,
    pendingDialog: null,
  }
}

describe('validateSelectionState', () => {
  it('passes with clean selection state', () => {
    expect(() => validateSelectionState(defaultSelectionState())).not.toThrow()
  })

  it('throws when chipOwnedSelection has orphan not in normalSelection', () => {
    const state = {
      ...defaultSelectionState(),
      chipOwnedSelection: new Set(['@edge_0']),
    }
    expect(() => validateSelectionState(state)).toThrow('[invariant] chipOwnedSelection has orphan')
  })

  it('passes when chipOwnedSelection entries are all in normalSelection', () => {
    const state = {
      normalSelection: new Set(['entity:S1:L1', '@edge_0']),
      chipOwnedSelection: new Set(['@edge_0']),
      selectionDomain: 'mixed',
    }
    expect(() => validateSelectionState(state)).not.toThrow()
  })

  it('throws when selectionDomain does not match normalSelection', () => {
    const state = {
      normalSelection: new Set(['?2;@body_1@extrude1/face/3']),
      chipOwnedSelection: new Set(),
      selectionDomain: 'sketch_2d',
    }
    expect(() => validateSelectionState(state)).toThrow('[invariant] selectionDomain')
  })

  it('throws when normalSelection contains unrecognized entry', () => {
    const state = {
      normalSelection: new Set(['bad-value']),
      chipOwnedSelection: new Set(),
      selectionDomain: 'mixed',
    }
    expect(() => validateSelectionState(state)).toThrow('[invariant] normalSelection contains unrecognized entry')
  })

  it('passes with valid entity: prefix entries', () => {
    const state = {
      normalSelection: new Set(['entity:S1:L1', 'vertex:S1:L1:start', 'face:S1:?3;...', 'constraint:S1:c1']),
      chipOwnedSelection: new Set(),
      selectionDomain: 'sketch_2d',
    }
    expect(() => validateSelectionState(state)).not.toThrow()
  })

  it('passes with valid @ prefix entries', () => {
    const state = {
      normalSelection: new Set(['@body_1', '@builtin_plane_front']),
      chipOwnedSelection: new Set(),
      selectionDomain: 'plane_3d',
    }
    expect(() => validateSelectionState(state)).not.toThrow()
  })

  it('passes with valid ? ancestry query entries', () => {
    const state = {
      normalSelection: new Set(['?2;@body_1@extrude1/face/3']),
      chipOwnedSelection: new Set(),
      selectionDomain: 'body_3d',
    }
    expect(() => validateSelectionState(state)).not.toThrow()
  })
})

describe('repairSelectionState', () => {
  it('returns null for clean state', () => {
    expect(repairSelectionState(defaultSelectionState())).toBeNull()
  })

  it('removes orphans from chipOwnedSelection', () => {
    const state = {
      normalSelection: new Set(['entity:S1:L1']),
      chipOwnedSelection: new Set(['@edge_0', '@edge_1']),
      selectionDomain: 'sketch_2d',
    }
    const patches = repairSelectionState(state)
    expect(patches).not.toBeNull()
    expect(patches!.chipOwnedSelection).toBeInstanceOf(Set)
    expect([...(patches!.chipOwnedSelection as Set<string>)]).toEqual([])
  })

  it('fixes stale selectionDomain', () => {
    const state = {
      normalSelection: new Set(['?2;@body_1@extrude1/face/3']),
      chipOwnedSelection: new Set(),
      selectionDomain: 'sketch_2d',
    }
    const patches = repairSelectionState(state)
    expect(patches).not.toBeNull()
    expect(patches!.selectionDomain).toBe('body_3d')
  })

  it('returns null when only repair is filter-invalid (not dev/test)', () => {
    // repairSelectionState filters invalid entries only in dev/test mode.
    // Since import.meta.env.MODE is 'test' in vitest, we expect filtering.
    const state = {
      normalSelection: new Set(['invalid!']),
      chipOwnedSelection: new Set(),
      selectionDomain: 'sketch_2d',
    }
    const patches = repairSelectionState(state)
    expect(patches).not.toBeNull()
    expect(patches!.normalSelection).toBeInstanceOf(Set)
    expect([...(patches!.normalSelection as Set<string>)]).toEqual([])
  })
})

describe('deriveSelectionDomain', () => {
  it('returns sketch_2d for empty set', () => {
    expect(deriveSelectionDomain(new Set())).toBe('sketch_2d')
  })

  it('returns sketch_2d for sketch entities', () => {
    expect(deriveSelectionDomain(new Set(['entity:S1:L1']))).toBe('sketch_2d')
    expect(deriveSelectionDomain(new Set(['vertex:S1:L1:start']))).toBe('sketch_2d')
    expect(deriveSelectionDomain(new Set(['face:S1:?3;...']))).toBe('sketch_2d')
    expect(deriveSelectionDomain(new Set(['constraint:S1:c1']))).toBe('sketch_2d')
    expect(deriveSelectionDomain(new Set(['dock:S1:pt1']))).toBe('sketch_2d')
    expect(deriveSelectionDomain(new Set(['isect:S1:i1']))).toBe('sketch_2d')
  })

  it('returns body_3d for 3D body queries', () => {
    expect(deriveSelectionDomain(new Set(['?2;@body_1@extrude1/face/3']))).toBe('body_3d')
  })

  it('returns plane_3d for bare @ queries', () => {
    expect(deriveSelectionDomain(new Set(['@body_1']))).toBe('plane_3d')
  })

  it('returns mixed for combination', () => {
    expect(deriveSelectionDomain(new Set(['entity:S1:L1', '?2;@body_1@extrude1/face/3']))).toBe('mixed')
  })
})

describe('validateSketchEditorState', () => {
  it('passes with default (clean) state', () => {
    expect(() => validateSketchEditorState(defaultState())).not.toThrow()
  })

  describe('selection invariants (run first)', () => {
    it('throws on chipOwnedSelection orphan before checking tool invariants', () => {
      const state = {
        ...defaultState(),
        chipOwnedSelection: new Set(['orphan']),
      }
      expect(() => validateSketchEditorState(state)).toThrow('[invariant] chipOwnedSelection has orphan')
    })
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
    it('reports the selection violation first (selection runs before dimensionPicks)', () => {
      const state = {
        ...defaultState(),
        normalSelection: new Set(['bad-value']),
        chipOwnedSelection: new Set(),
        selectionDomain: 'mixed',
        dimensionPicks: [{ target: 'entity:S1:L1' }],
        activeTool: 'select',
      }
      expect(() => validateSketchEditorState(state)).toThrow('[invariant] normalSelection contains unrecognized entry')
    })
  })
})
