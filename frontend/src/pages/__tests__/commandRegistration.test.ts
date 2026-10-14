import { describe, it, expect, beforeAll } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { initializeTools } from '@/tools'
import { partContext } from './commandFixtures'
import { useCommandRegistration } from '@/pages/hooks/useCommandRegistration'
import { renderHook } from '@testing-library/react'
import { PART_COMMAND_SPECS } from '@/pages/commandEntries'
import { CommandRegistry } from '@/utils/core/commandSpec'

beforeAll(() => { initializeTools() })

// The structural contract (non-empty, unique ids) is pinned in
// commandEntries.test.ts, the file that owns the spec table. This file covers
// the registry leg the direct-call invoke suite does not: a real spec reaches
// its body through the registered registry.

describe('handler execution effect', () => {
  it('set_tool_rect arms the rectangle tool through the real spec table', () => {
    const registry = new CommandRegistry(() => partContext())
    renderHook(() => useCommandRegistration('part', registry, PART_COMMAND_SPECS))
    useSketchEditorStore.getState().setActiveTool(null)

    const result = registry.execute('set_tool_rect')

    expect(result.ok).toBe(true)
    expect(useSketchEditorStore.getState().activeTool).toBe('rect')
  })
})
