import { describe, it, expect, vi, afterEach } from 'vitest'
import { PART_COMMAND_SPECS } from '@/pages/commandEntries'
import { TOOLBAR_ENTITIES, ENTITIES } from '@/registry/entityRegistry'
import { TOOLBAR_CONSTRAINTS } from '@/registry/constraintRegistry'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { narrowCommandName } from '@/utils/core/commandNames'
import { partContext, partRegistry } from './commandFixtures'

// Regression: the ellipse toolbar button dispatched `set_tool_ellipse`, but the
// command list registered set_tool_* per tool by hand and had no ellipse entry,
// so the button was silently inert. EntityTools.tsx dispatches
// `set_tool_${def.activeTool}` for every TOOLBAR_ENTITIES def, so each must have
// a matching command. The specs are now derived from the registry; this test
// locks the contract for the next entity kind too.
function commandIds(): Set<string> {
  return new Set(PART_COMMAND_SPECS.map(s => s.id))
}

describe('set_tool commands for entity tools', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('every toolbar entity has a registered set_tool_<activeTool> command', () => {
    const ids = commandIds()
    for (const def of TOOLBAR_ENTITIES) {
      expect(
        ids.has(`set_tool_${def.activeTool}`),
        `missing command set_tool_${def.activeTool} for toolbar entity '${def.kind}'`,
      ).toBe(true)
    }
  })

  it('every registry entity with an activeTool has a set_tool command', () => {
    const ids = commandIds()
    for (const def of ENTITIES) {
      if (!def.activeTool) continue
      expect(ids.has(`set_tool_${def.activeTool}`)).toBe(true)
    }
  })

  it('ellipse specifically is dispatchable', () => {
    expect(commandIds().has('set_tool_ellipse')).toBe(true)
  })
})

describe('apply commands for toolbar constraints', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('every showInToolbar constraint with implemented !== false routes to applyConstraint', () => {
    const store = useSketchEditorStore.getState()
    const applyConstraint = vi.spyOn(store, 'applyConstraint').mockReturnValue(null)
    const showMessage = vi.fn()
    const registry = partRegistry(partContext({ showMessage }))

    const implemented = TOOLBAR_CONSTRAINTS.filter(c => c.implemented !== false)
    for (const def of implemented) {
      // Each spec must forward its OWN kind, not just call the action: a
      // total-call-count check passes even if two commands are swapped.
      applyConstraint.mockClear()
      const result = registry.execute(narrowCommandName(`apply_${def.kind}`))
      expect(result.ok, `apply_${def.kind} did not run`).toBe(true)
      expect(applyConstraint).toHaveBeenCalledWith(def.kind)
    }

    expect(showMessage).not.toHaveBeenCalled()
  })
})
