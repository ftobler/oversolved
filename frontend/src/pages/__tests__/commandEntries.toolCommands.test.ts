import { describe, it, expect } from 'vitest'
import { buildCommandEntries } from '@/pages/commandEntries'
import { TOOLBAR_ENTITIES, ENTITIES } from '@/registry/entityRegistry'

// Regression: the ellipse toolbar button dispatched `set_tool_ellipse`, but the
// command list registered set_tool_* per tool by hand and had no ellipse entry,
// so the button was silently inert. EntityTools.tsx dispatches
// `set_tool_${def.activeTool}` for every TOOLBAR_ENTITIES def, so each must have
// a matching command. The entries are now derived from the registry; this test
// locks the contract for the next entity kind too.
function commandNames(): Set<string> {
  const noop = () => {}
  const entries = buildCommandEntries(noop, noop, noop, noop, noop, noop, noop, noop)
  return new Set(entries.map(e => e.name))
}

describe('set_tool commands for entity tools', () => {
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
