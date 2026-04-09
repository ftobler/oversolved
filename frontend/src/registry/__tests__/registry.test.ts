import { describe, it, expect } from 'vitest'
import type { ActiveTool } from '../../stores/sketchEditorStore'
import {
  CONSTRAINTS,
  CONSTRAINT_BY_KIND,
  RENDER_KIND_TO_ICON,
  TOOLBAR_CONSTRAINTS,
  CONSTRAINT_SHORTCUTS,
  DIMENSION_RULES,
  resolveSingleEntityDimension,
  resolveTwoTargetDimension,
} from '../constraintRegistry'
import {
  ENTITIES,
  ENTITY_BY_KIND,
  ENTITY_BY_ACTIVE_TOOL,
  ENTITY_SHORTCUTS,
  VERTEX_INDICES,
  ALL_COORD_INDICES,
  getDefaultParams,
} from '../entityRegistry'

// ── Constraint registry consistency ────

describe('constraintRegistry', () => {
  it('every constraint has a unique kind', () => {
    const kinds = CONSTRAINTS.map(c => c.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  it('CONSTRAINT_BY_KIND contains all constraints', () => {
    for (const c of CONSTRAINTS) {
      expect(CONSTRAINT_BY_KIND.get(c.kind)).toBe(c)
    }
  })

  it('every shortcut maps to exactly one constraint', () => {
    const shortcuts = CONSTRAINTS.filter(c => c.shortcut).map(c => c.shortcut!)
    expect(new Set(shortcuts).size).toBe(shortcuts.length)
  })

  it('CONSTRAINT_SHORTCUTS derives from registry shortcuts', () => {
    for (const c of CONSTRAINTS) {
      if (c.shortcut) {
        expect(CONSTRAINT_SHORTCUTS.get(c.shortcut)).toBe(`apply_${c.kind}`)
      }
    }
  })

  it('TOOLBAR_CONSTRAINTS includes only constraints with showInToolbar', () => {
    expect(TOOLBAR_CONSTRAINTS.every(c => c.showInToolbar)).toBe(true)
    expect(TOOLBAR_CONSTRAINTS.length).toBe(CONSTRAINTS.filter(c => c.showInToolbar).length)
  })

  it('every toolbar constraint has a toolbarIcon', () => {
    for (const c of TOOLBAR_CONSTRAINTS) {
      expect(c.toolbarIcon).toBeTruthy()
    }
  })

  it('RENDER_KIND_TO_ICON maps every constraint with a symbolIcon', () => {
    for (const c of CONSTRAINTS) {
      if (c.symbolIcon) {
        expect(RENDER_KIND_TO_ICON[c.renderKind]).toBe(c.symbolIcon)
      }
    }
  })

  it('dimensional constraints have hasValue=true', () => {
    for (const c of CONSTRAINTS) {
      if (c.category === 'dimensional') {
        expect(c.hasValue).toBe(true)
      }
    }
  })

  it('geometric constraints have hasValue=false', () => {
    for (const c of CONSTRAINTS) {
      if (c.category === 'geometric') {
        expect(c.hasValue).toBe(false)
      }
    }
  })
})

// ── Dimension tool rules ────

describe('dimension rules', () => {
  it('every rule references a valid constraint kind', () => {
    for (const r of DIMENSION_RULES) {
      expect(CONSTRAINT_BY_KIND.has(r.constraintKind)).toBe(true)
    }
  })

  it('resolveSingleEntityDimension maps known entity kinds', () => {
    expect(resolveSingleEntityDimension('line')).toBe('length')
    expect(resolveSingleEntityDimension('arc')).toBe('radius')
    expect(resolveSingleEntityDimension('circle')).toBe('diameter')
  })

  it('resolveSingleEntityDimension returns null for unknown kinds', () => {
    expect(resolveSingleEntityDimension('point')).toBeNull()
    expect(resolveSingleEntityDimension('unknown')).toBeNull()
  })

  it('resolveTwoTargetDimension resolves correctly', () => {
    expect(resolveTwoTargetDimension(true, true)).toBe('point_distance')
    expect(resolveTwoTargetDimension(false, false)).toBe('line_distance')
    expect(resolveTwoTargetDimension(true, false)).toBe('line_distance')
    expect(resolveTwoTargetDimension(false, true)).toBe('line_distance')
  })
})

// ── Entity registry consistency ────

describe('entityRegistry', () => {
  it('every entity has a unique kind', () => {
    const kinds = ENTITIES.map(e => e.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  it('ENTITY_BY_KIND contains all entities', () => {
    for (const e of ENTITIES) {
      expect(ENTITY_BY_KIND.get(e.kind)).toBe(e)
    }
  })

  it('defaultParams length matches paramCount', () => {
    for (const e of ENTITIES) {
      expect(e.defaultParams.length).toBe(e.paramCount)
    }
  })

  it('vertex indices are within param bounds', () => {
    for (const e of ENTITIES) {
      for (const v of e.vertices) {
        expect(v.indices[0]).toBeLessThan(e.paramCount)
        expect(v.indices[1]).toBeLessThan(e.paramCount)
      }
    }
  })

  it('coordPairs indices are within param bounds', () => {
    for (const e of ENTITIES) {
      for (const [xi, yi] of e.coordPairs) {
        expect(xi).toBeLessThan(e.paramCount)
        expect(yi).toBeLessThan(e.paramCount)
      }
    }
  })

  it('VERTEX_INDICES matches entity vertex definitions', () => {
    for (const e of ENTITIES) {
      const vi = VERTEX_INDICES[e.kind]
      expect(vi).toBeDefined()
      for (const v of e.vertices) {
        expect(vi[v.key]).toEqual(v.indices)
      }
    }
  })

  it('ALL_COORD_INDICES matches entity coordPairs', () => {
    for (const e of ENTITIES) {
      expect(ALL_COORD_INDICES[e.kind]).toEqual(e.coordPairs)
    }
  })

  it('getDefaultParams returns correct defaults', () => {
    expect(getDefaultParams('line')).toEqual([0, 0, 0, 0])
    expect(getDefaultParams('circle')).toEqual([0, 0, 0])
    expect(getDefaultParams('arc')).toEqual([0, 0, 0, 0, 0])
    expect(getDefaultParams('point')).toEqual([0, 0])
    expect(getDefaultParams('unknown')).toEqual([])
  })

  it('every toolbar entity has toolbarIcon and activeTool', () => {
    for (const e of ENTITIES.filter(e => e.showInToolbar)) {
      expect(e.toolbarIcon).toBeTruthy()
      expect(e.activeTool).toBeTruthy()
    }
  })

  it('ENTITY_BY_ACTIVE_TOOL maps every activeTool to its definition', () => {
    for (const e of ENTITIES) {
      if (e.activeTool) {
        expect(ENTITY_BY_ACTIVE_TOOL.get(e.activeTool)).toBe(e)
      }
    }
  })

  it('ENTITY_BY_ACTIVE_TOOL has no entries for entities without activeTool', () => {
    const toolValues = new Set(ENTITIES.filter(e => e.activeTool).map(e => e.activeTool!))
    for (const key of ENTITY_BY_ACTIVE_TOOL.keys()) {
      expect(toolValues.has(key as Exclude<ActiveTool, null>)).toBe(true)
    }
  })

  it('every ENTITY_SHORTCUTS command resolves to an entity via ENTITY_BY_ACTIVE_TOOL', () => {
    for (const [, command] of ENTITY_SHORTCUTS) {
      const activeTool = command.replace(/^set_tool_/, '')
      expect(
        ENTITY_BY_ACTIVE_TOOL.has(activeTool),
        `no entity found for activeTool "${activeTool}" (command "${command}")`
      ).toBe(true)
    }
  })
})

// ── Entity registry shortcuts ────

describe('entityRegistry shortcuts', () => {
  it('every shortcut maps to exactly one entity', () => {
    const shortcuts = ENTITIES.filter(e => e.shortcut).map(e => e.shortcut!)
    expect(new Set(shortcuts).size).toBe(shortcuts.length)
  })

  it('ENTITY_SHORTCUTS derives correct command names', () => {
    for (const e of ENTITIES) {
      if (e.shortcut) {
        expect(ENTITY_SHORTCUTS.get(e.shortcut)).toBe('set_tool_' + e.activeTool)
      }
    }
  })

  it('ENTITY_SHORTCUTS has an entry for each entity with a shortcut', () => {
    const entitiesWithShortcut = ENTITIES.filter(e => e.shortcut)
    expect(ENTITY_SHORTCUTS.size).toBe(entitiesWithShortcut.length)
  })

  it('entity shortcuts do not conflict with constraint shortcuts', () => {
    for (const key of ENTITY_SHORTCUTS.keys()) {
      expect(CONSTRAINT_SHORTCUTS.has(key)).toBe(false)
    }
  })
})
