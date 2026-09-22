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

// ─── Config array structure ───

describe('command config array structure', () => {
  const config = buildCommandEntries(vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn())

  it('every entry has a non-empty name string', () => {
    for (const entry of config) {
      expect(typeof entry.name).toBe('string')
      expect(entry.name.length).toBeGreaterThan(0)
    }
  })

  it('no duplicate names', () => {
    const names = config.map(e => e.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('every entry has a function handler', () => {
    for (const entry of config) {
      expect(typeof entry.fn).toBe('function')
    }
  })
})

// ─── Handler execution effect ───

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
