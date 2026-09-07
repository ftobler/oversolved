import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildCommandEntries } from '@/pages/commandEntries'
import { TOOLBAR_ENTITIES, ENTITIES } from '@/registry/entityRegistry'
import { TOOLBAR_CONSTRAINTS } from '@/registry/constraintRegistry'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

// Regression: the ellipse toolbar button dispatched `set_tool_ellipse`, but the
// command list registered set_tool_* per tool by hand and had no ellipse entry,
// so the button was silently inert. EntityTools.tsx dispatches
// `set_tool_${def.activeTool}` for every TOOLBAR_ENTITIES def, so each must have
// a matching command. The entries are now derived from the registry; this test
// locks the contract for the next entity kind too.
function commandNames(): Set<string> {
  const noop = () => {}
  const entries = buildCommandEntries(noop, noop, noop, noop, noop, noop, noop, noop, noop)
  return new Set(entries.map(e => e.name))
}

describe('set_tool commands for entity tools', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('every toolbar entity has a registered set_tool_<activeTool> command', () => {
    const names = commandNames()
    for (const def of TOOLBAR_ENTITIES) {
      expect(
        names.has(`set_tool_${def.activeTool}`),
        `missing command set_tool_${def.activeTool} for toolbar entity '${def.kind}'`,
      ).toBe(true)
    }
  })

  it('every registry entity with an activeTool has a set_tool command', () => {
    const names = commandNames()
    for (const def of ENTITIES) {
      if (!def.activeTool) continue
      expect(names.has(`set_tool_${def.activeTool}`)).toBe(true)
    }
  })

  it('ellipse specifically is dispatchable', () => {
    expect(commandNames().has('set_tool_ellipse')).toBe(true)
  })
})

describe('apply commands for toolbar constraints', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('every showInToolbar constraint with implemented !== false routes to applyConstraint', () => {
    const noop = () => {}
    const store = useSketchEditorStore.getState()
    const applyConstraint = vi.spyOn(store, 'applyConstraint').mockReturnValue(null)
    const showMessage = vi.fn()
    const entries = buildCommandEntries(noop, noop, noop, noop, noop, noop, noop, noop, showMessage)

    const implemented = TOOLBAR_CONSTRAINTS.filter(c => c.implemented !== false)
    for (const def of implemented) {
      const e = entries.find(x => x.name === `apply_${def.kind}`)
      expect(e, `missing command apply_${def.kind} for toolbar constraint '${def.kind}'`).toBeDefined()
      e!.fn()
    }

    expect(applyConstraint).toHaveBeenCalledTimes(implemented.length)
    expect(showMessage).not.toHaveBeenCalled()
  })
})
