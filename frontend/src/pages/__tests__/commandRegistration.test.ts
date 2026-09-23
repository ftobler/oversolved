import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import {
  registerCommand,
  executeCommand,
  clearAllHandlers,
} from '@/utils/core/commandRegistry'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { buildCommandEntries } from '@/pages/commandEntries'
import { initializeTools } from '@/tools'

beforeAll(() => { initializeTools() })

beforeEach(() => { clearAllHandlers() })

// The structural contract (non-empty, unique names) is pinned in
// commandEntries.test.ts, the file that owns buildCommandEntries. This file
// covers the registry leg the direct-call invoke suite does not: a real entry
// name reaches its handler through executeCommand.

describe('handler execution effect', () => {
  it('set_tool_rect arms the rectangle tool through the real command entry', () => {
    const config = buildCommandEntries(vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn())
    const entry = config.find(e => e.name === 'set_tool_rect')!
    useSketchEditorStore.getState().setActiveTool(null)

    registerCommand(entry.name, entry.fn)
    executeCommand(entry.name)

    expect(useSketchEditorStore.getState().activeTool).toBe('rect')
  })
})
