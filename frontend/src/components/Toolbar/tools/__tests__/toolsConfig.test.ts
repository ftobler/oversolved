import { describe, it, expect } from 'vitest'
import type { ToolDef } from '../toolsConfig'

describe('TOOL_DEFS', () => {
  it('typecheck: activeTool rejects literals outside the ActiveTool union', () => {
    // A stale tool string (a dead ToolId like rectangle, a typo) must fail
    // tsc. If ToolDef.activeTool ever loosens back to string, this directive
    // becomes unused and the build fails.
    // @ts-expect-error 'rectangle' is not a member of ActiveTool
    const bad: ToolDef = { id: 'x', label: 'x', icon: 'x', command: 'x', activeTool: 'rectangle' }
    expect(bad.activeTool).toBe('rectangle')
  })
})
