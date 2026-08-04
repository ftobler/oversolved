import { describe, it, expect, beforeAll } from 'vitest'
import { validateSketchEditorState, validateSelectionState, repairSelectionState, DRAWING_TOOLS, deriveSelectionDomain, DERIVE_SELECTION_DOMAIN_PREFIXES, KNOWN_SELECTION_PREFIXES } from '@/stores/stateInvariants'
import type { SketchEditorInvariantState, SelectionInvariantState } from '@/stores/stateInvariants'
import type { SelectionDomain } from '@/types/cad'
import { initializeTools } from '@/tools'
import { toolRegistry } from '@/registry/toolRegistry'

// The drawing-tool set is derived from the registry, so the invariant tests
// need the canonical tools registered before they enumerate drawing ids.
beforeAll(() => { initializeTools() })

function defaultSelectionState(): SelectionInvariantState {
  return {
    normalSelection: new Set(),
    selectedPicks: new Map<string, Set<string>>(),
    chipOwnedSelection: new Set<string>(),
    selectionDomain: 'sketch_2d' as const,
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
    modeStack: [],
  }
}

// An armed tool owns the top of the mode stack, so any fixture that sets
// activeTool must carry its entry to stay well-formed.
function withTool(tool: string): Pick<SketchEditorInvariantState, 'activeTool' | 'modeStack'> {
  return { activeTool: tool, modeStack: ['tool:' + tool] }
}

describe('validateSelectionState', () => {
  it('passes with clean selection state', () => {
    expect(() => validateSelectionState(defaultSelectionState())).not.toThrow()
  })

  it('throws when chipOwnedSelection has orphan not in normalSelection', () => {
    const state = {
      ...defaultSelectionState(),
      selectedPicks: new Map<string, Set<string>>(),
      chipOwnedSelection: new Set(['@edge_0']),
    }
    expect(() => validateSelectionState(state)).toThrow('[invariant] chipOwnedSelection has orphan')
  })

  it('passes when chipOwnedSelection entries are all in normalSelection', () => {
    const state = {
      normalSelection: new Set(['entity:S1:L1', '@edge_0']),
      selectedPicks: new Map<string, Set<string>>(),
      chipOwnedSelection: new Set(['@edge_0']),
      selectionDomain: 'mixed' as const,
    }
    expect(() => validateSelectionState(state)).not.toThrow()
  })

  it('throws when selectedPicks claims a query not in normalSelection', () => {
    const state = {
      ...defaultSelectionState(),
      selectedPicks: new Map([['Q', new Set(['ex1/b0#edge#0'])]]),
    }
    expect(() => validateSelectionState(state)).toThrow('[invariant] selectedPicks has orphan claim')
  })

  it('passes when every selectedPicks claim is in normalSelection', () => {
    const state = {
      ...defaultSelectionState(),
      normalSelection: new Set(['?2;@body_1@extrude1/edge/3']),
      selectedPicks: new Map([['?2;@body_1@extrude1/edge/3', new Set(['ex1/b0#edge#0'])]]),
      selectionDomain: 'body_3d' as const,
    }
    expect(() => validateSelectionState(state)).not.toThrow()
  })

  it('throws when selectedPicks has an empty claim set for a query', () => {
    const state = {
      ...defaultSelectionState(),
      normalSelection: new Set(['Q']),
      selectedPicks: new Map([['Q', new Set<string>()]]),
    }
    expect(() => validateSelectionState(state)).toThrow('[invariant] selectedPicks has empty claim set')
  })

  it('throws when selectionDomain does not match normalSelection', () => {
    const state = {
      normalSelection: new Set(['?2;@body_1@extrude1/face/3']),
      selectedPicks: new Map<string, Set<string>>(),
      chipOwnedSelection: new Set<string>(),
      selectionDomain: 'sketch_2d' as const,
    }
    expect(() => validateSelectionState(state)).toThrow('[invariant] selectionDomain')
  })

  it('throws when normalSelection contains unrecognized entry', () => {
    const state = {
      normalSelection: new Set(['bad-value']),
      selectedPicks: new Map<string, Set<string>>(),
      chipOwnedSelection: new Set<string>(),
      selectionDomain: 'mixed' as const,
    }
    expect(() => validateSelectionState(state)).toThrow('[invariant] normalSelection contains unrecognized entry')
  })

  it('passes with valid entity: prefix entries', () => {
    const state = {
      normalSelection: new Set(['entity:S1:L1', 'vertex:S1:L1:start', 'constraint:S1:c1']),
      selectedPicks: new Map<string, Set<string>>(),
      chipOwnedSelection: new Set<string>(),
      selectionDomain: 'sketch_2d' as const,
    }
    expect(() => validateSelectionState(state)).not.toThrow()
  })

  it('passes with valid @ prefix entries', () => {
    const state = {
      normalSelection: new Set(['@body_1', '@builtin_plane_front']),
      selectedPicks: new Map<string, Set<string>>(),
      chipOwnedSelection: new Set<string>(),
      // A whole-body id and a plane together are genuinely mixed, not plane.
      selectionDomain: 'mixed' as const,
    }
    expect(() => validateSelectionState(state)).not.toThrow()
  })

  it('passes with valid ? ancestry query entries', () => {
    const state = {
      normalSelection: new Set(['?2;@body_1@extrude1/face/3']),
      selectedPicks: new Map<string, Set<string>>(),
      chipOwnedSelection: new Set<string>(),
      selectionDomain: 'body_3d' as const,
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
      selectedPicks: new Map<string, Set<string>>(),
      chipOwnedSelection: new Set(['@edge_0', '@edge_1']),
      selectionDomain: 'sketch_2d' as const,
    }
    const patches = repairSelectionState(state)
    expect(patches).not.toBeNull()
    expect(patches!.chipOwnedSelection).toBeInstanceOf(Set)
    expect([...(patches!.chipOwnedSelection as Set<string>)]).toEqual([])
  })

  it('drops orphan claims from selectedPicks, keeping the valid ones', () => {
    const state = {
      ...defaultSelectionState(),
      normalSelection: new Set(['?2;@body_1@extrude1/edge/3']),
      selectedPicks: new Map([
        ['?2;@body_1@extrude1/edge/3', new Set(['ex1/b0#edge#0'])],  // valid claim
        ['Q-gone', new Set(['ex1/b0#edge#1'])],  // query left the selection
      ]),
      selectionDomain: 'body_3d' as const,
    }
    const patches = repairSelectionState(state)
    expect(patches).not.toBeNull()
    expect([...(patches!.selectedPicks as Map<string, Set<string>>).entries()])
      .toEqual([['?2;@body_1@extrude1/edge/3', new Set(['ex1/b0#edge#0'])]])
  })

  it('drops empty claim sets from selectedPicks', () => {
    const state = {
      ...defaultSelectionState(),
      normalSelection: new Set(['@body_1/edge/0', '@body_1/edge/1']),
      selectedPicks: new Map([
        ['@body_1/edge/0', new Set(['ex1/b0#edge#0'])],  // valid
        ['@body_1/edge/1', new Set<string>()],  // empty claim set
      ]),
      selectionDomain: 'body_3d' as const,
    }
    const patches = repairSelectionState(state)
    expect(patches).not.toBeNull()
    expect([...(patches!.selectedPicks as Map<string, Set<string>>).keys()]).toEqual(['@body_1/edge/0'])
  })

  it('fixes stale selectionDomain', () => {
    const state = {
      normalSelection: new Set(['?2;@body_1@extrude1/face/3']),
      selectedPicks: new Map<string, Set<string>>(),
      chipOwnedSelection: new Set<string>(),
      selectionDomain: 'sketch_2d' as const,
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
      selectedPicks: new Map<string, Set<string>>(),
      chipOwnedSelection: new Set<string>(),
      selectionDomain: 'sketch_2d' as const,
    }
    const patches = repairSelectionState(state)
    expect(patches).not.toBeNull()
    expect(patches!.normalSelection).toBeInstanceOf(Set)
    expect([...(patches!.normalSelection as Set<string>)]).toEqual([])
  })

  it('is a fixpoint: applying the patches yields a state that validates', () => {
    // Filtering an unrecognized entry is the one repair that shrinks
    // normalSelection, so every other repair has to be derived from the survivors
    // or the "repaired" state fails the very validation that requested it.
    const state: SelectionInvariantState = {
      normalSelection: new Set(['invalid!']),
      selectedPicks: new Map([['invalid!', new Set(['ex1/b0#edge#0'])]]),
      chipOwnedSelection: new Set(['invalid!']),
      selectionDomain: 'sketch_2d' as const,
    }
    const patches = repairSelectionState(state)
    expect(patches).not.toBeNull()
    expect(() => validateSelectionState({ ...state, ...patches })).not.toThrow()
  })
})

describe('deriveSelectionDomain', () => {
  it('returns sketch_2d for empty set', () => {
    expect(deriveSelectionDomain(new Set())).toBe('sketch_2d')
  })

  it('classifies every id format actually produced in the app', () => {
    // One row per format written into normalSelection in production code. A
    // bare set of any single id must land in exactly one domain: `mixed` alone
    // would mean a real selection the classifier cannot read.
    const rows: Array<[string, SelectionDomain]> = [
      ['entity:S1:L1', 'sketch_2d'],
      ['vertex:S1:L1:start', 'sketch_2d'],
      ['constraint:Sketch1:C1', 'sketch_2d'],
      ['dock:S1:tan1', 'sketch_2d'],
      ['isect:S1:1:2:curA:curB', 'sketch_2d'],
      ['edge:ex1:?c;@a', 'body_3d'],
      ['face:ex1:?8,8;@ex1f0:face', 'body_3d'],
      ['?9;@ex1face0:face', 'body_3d'],
      ['@ex1/edge/0', 'body_3d'],
      ['@body_1', 'body_3d'],
      ['@builtin_origin', 'sketch_2d'],
      ['@builtin_plane_front', 'plane_3d'],
      ['@sketch1', 'plane_3d'],
    ]
    for (const [id, domain] of rows) {
      expect(deriveSelectionDomain(new Set([id]))).toBe(domain)
    }
  })

  it('guard: classifier families and isValidSelectionId families are set-equal', () => {
    // isValidSelectionId accepts every id family in KNOWN_SELECTION_PREFIXES.
    // If deriveSelectionDomain stops recognizing one, its ids fall through to
    // mixed instead of their real bucket. Both lists must be extended together.
    expect(new Set(DERIVE_SELECTION_DOMAIN_PREFIXES)).toEqual(new Set(KNOWN_SELECTION_PREFIXES))
  })

  it('guard: every accepted id derives a concrete bucket, never mixed alone', () => {
    for (const prefix of DERIVE_SELECTION_DOMAIN_PREFIXES) {
      expect(deriveSelectionDomain(new Set([`${prefix}x`]))).not.toBe('mixed')
    }
    // `?` ancestry queries are first-class but are not a prefix.
    expect(deriveSelectionDomain(new Set(['?2;@body_1@extrude1/face/3']))).toBe('body_3d')
  })

  it('wrapped and bare forms of one face share a bucket (no spurious mixed)', () => {
    // face:ex1:?8,8;@ex1f0:face is the same face as the bare ?8,8;@ex1f0:face;
    // the prefix is owner attribution only, so the pair must read as one
    // domain rather than a sketch-plus-3d mix.
    expect(deriveSelectionDomain(new Set(['face:ex1:?8,8;@ex1f0:face', '?8,8;@ex1f0:face']))).toBe('body_3d')
    expect(deriveSelectionDomain(new Set(['face:ex1:?8,8;@ex1f0:face', '@ex1/face/0']))).toBe('body_3d')
  })

  it('returns body_3d for 3D body queries', () => {
    expect(deriveSelectionDomain(new Set(['?2;@body_1@extrude1/face/3']))).toBe('body_3d')
  })

  it('returns mixed for combination of sketch and body', () => {
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
        selectedPicks: new Map<string, Set<string>>(),
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
      const state = { ...defaultState(), dimensionPicks: [{ target: 'entity:S1:L1' }], ...withTool('dimension') }
      expect(() => validateSketchEditorState(state)).not.toThrow()
    })

    it('passes when picks are empty and tool is null', () => {
      const state = { ...defaultState(), dimensionPicks: [], activeTool: null }
      expect(() => validateSketchEditorState(state)).not.toThrow()
    })
  })

  describe('activePickField invariant', () => {
    it('throws when activePickField is set but activeTool is not null', () => {
      const state = { ...defaultState(), activePickField: { featureId: 'Sketch1', field: 'plane' }, activeTool: 'drag' }
      expect(() => validateSketchEditorState(state)).toThrow('[invariant] activePickField')
    })

    it('passes when activePickField is set with activeTool null', () => {
      const state = { ...defaultState(), activePickField: { featureId: 'Sketch1', field: 'plane' }, activeTool: null, modeStack: ['pick'] }
      expect(() => validateSketchEditorState(state)).not.toThrow()
    })
  })

  describe('modeStack invariant', () => {
    it('throws when a tool entry outlives its tool', () => {
      const state = { ...defaultState(), activeTool: null, modeStack: ['tool:line'] }
      expect(() => validateSketchEditorState(state)).toThrow('[invariant] modeStack is [tool:line]')
    })

    it('throws when a pick entry outlives its field', () => {
      const state = { ...defaultState(), modeStack: ['pick'] }
      expect(() => validateSketchEditorState(state)).toThrow('[invariant] modeStack is [pick]')
    })

    it('throws when the armed tool does not own the top', () => {
      const state = { ...defaultState(), activeTool: 'line', modeStack: ['tool:select'] }
      expect(() => validateSketchEditorState(state)).toThrow("[invariant] activeTool is 'line' but modeStack top is 'tool:select'")
    })

    it('throws when a pick sits on top while a tool is armed', () => {
      const state = { ...defaultState(), activeTool: 'line', modeStack: ['tool:line', 'pick'] }
      expect(() => validateSketchEditorState(state)).toThrow("[invariant] activeTool is 'line' but modeStack top is 'pick'")
    })

    it('throws when the armed tool has no entry at all', () => {
      const state = { ...defaultState(), activeTool: 'line', modeStack: [] }
      expect(() => validateSketchEditorState(state)).toThrow("[invariant] activeTool is 'line' but modeStack top is 'null'")
    })

    it('throws when a pick field is armed without its entry on top', () => {
      const state = { ...defaultState(), activePickField: { featureId: 'Sketch1', field: 'plane' }, modeStack: ['tool:line'] }
      expect(() => validateSketchEditorState(state)).toThrow("[invariant] activePickField set ('Sketch1:plane') but modeStack top is 'tool:line'")
    })

    it('couples only the top entry, deeper ones are not attributed', () => {
      const state = { ...defaultState(), activeTool: 'line', modeStack: ['outer', 'tool:line'] }
      expect(() => validateSketchEditorState(state)).not.toThrow()
    })

    it('passes for an armed tool that owns the top', () => {
      expect(() => validateSketchEditorState({ ...defaultState(), ...withTool('line') })).not.toThrow()
    })

    it('passes for the all-clear state', () => {
      expect(() => validateSketchEditorState(defaultState())).not.toThrow()
    })
  })

  describe('draw state invariants', () => {
    it('throws when drawPoints has entries but activeTool is not a drawing tool', () => {
      const state = { ...defaultState(), drawPoints: [[1, 2]], activeTool: 'dimension' }
      expect(() => validateSketchEditorState(state)).toThrow('[invariant] drawPoints')
    })

    it('throws when drawHover is set but activeTool is not a drawing tool', () => {
      const state = { ...defaultState(), drawHover: [3, 4], activeTool: 'drag' }
      expect(() => validateSketchEditorState(state)).toThrow('[invariant] drawHover')
    })

    for (const tool of DRAWING_TOOLS()) {
      it(`passes when drawing tool '${tool}' has draw state`, () => {
        const state = { ...defaultState(), drawPoints: [[1, 2]], drawHover: [3, 4], ...withTool(tool) }
        expect(() => validateSketchEditorState(state)).not.toThrow()
      })
    }

    it('passes when drawPoints is empty and activeTool is not a drawing tool', () => {
      const state = { ...defaultState(), drawPoints: [], drawHover: null, ...withTool('drag') }
      expect(() => validateSketchEditorState(state)).not.toThrow()
    })
  })

  describe('drawing-tool set vs registry', () => {
    it('DRAWING_TOOLS matches the registered drawing tools', () => {
      expect(DRAWING_TOOLS()).toEqual(new Set(Array.from(toolRegistry.drawingIds())))
    })
  })

  describe('multiple violations', () => {
    it('reports the selection violation first (selection runs before dimensionPicks)', () => {
      const state = {
        ...defaultState(),
        normalSelection: new Set(['bad-value']),
        selectedPicks: new Map<string, Set<string>>(),
      chipOwnedSelection: new Set<string>(),
        selectionDomain: 'mixed' as const,
        dimensionPicks: [{ target: 'entity:S1:L1' }],
        activeTool: 'dimension',
      }
      expect(() => validateSketchEditorState(state)).toThrow('[invariant] normalSelection contains unrecognized entry')
    })
  })
})
