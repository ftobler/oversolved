import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { useAssemblyCommands } from '@/pages/AssemblyKeyboardShortcuts'
import {
  ASSEMBLY_COMMAND_NAMES,
  ASSEMBLY_OPERATION_BY_COMMAND,
  buildAssemblyCommandEntries,
  buildAssemblyHandlers,
  type AssemblyCommandHandlers,
  type AssemblyCommandName,
  type AssemblyHandlerDeps,
} from '@/pages/assemblyCommandEntries'
import { ASSEMBLY_OPERATIONS, type AssemblyOperationId } from '@/utils/assemblyOperations'
import { executeCommand, clearAllHandlers } from '@/utils/core/commandRegistry'

function spyHandlers(): AssemblyCommandHandlers {
  return Object.fromEntries(ASSEMBLY_COMMAND_NAMES.map(n => [n, vi.fn()])) as AssemblyCommandHandlers
}

// The page's inputs, with spies for everything but the id mint. Building the
// handlers through the same function the page uses is what lets the coverage
// test observe the real command-to-operation wiring.
function handlerDeps(): AssemblyHandlerDeps & { runOperation: ReturnType<typeof vi.fn> } {
  return {
    runOperation: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    deleteSelected: vi.fn(),
    cancelEdit: vi.fn(),
    openInsertPart: vi.fn(),
    openExport: vi.fn(),
    mintMateId: () => 'mate-new',
    closeOpenEditor: vi.fn(),
    onMateInserted: vi.fn(),
    afterDeletePart: vi.fn(),
    afterDeleteMate: vi.fn(),
  }
}

describe('buildAssemblyCommandEntries', () => {
  it('has one entry per canonical name, all unique, stable across builds', () => {
    const handlers = spyHandlers()
    const first = buildAssemblyCommandEntries(handlers)
    const second = buildAssemblyCommandEntries(handlers)
    expect(first.map(e => e.name)).toEqual([...ASSEMBLY_COMMAND_NAMES])
    expect(new Set(first.map(e => e.name)).size).toBe(first.length)
    expect(second.map(e => e.name)).toEqual(first.map(e => e.name))
  })
})

describe('useAssemblyCommands', () => {
  beforeEach(() => clearAllHandlers())

  it('registers a handler for every command with no executeCommand warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    renderHookStrict(() => useAssemblyCommands(spyHandlers()))
    for (const name of ASSEMBLY_COMMAND_NAMES) executeCommand(name)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('assembly operation coverage', () => {
  // Every operation must be reachable from the handlers the page actually
  // registers, not merely present in the documentation map.
  it('executing the built handlers reaches every operation', () => {
    const deps = handlerDeps()
    const handlers = buildAssemblyHandlers(deps)
    for (const name of ASSEMBLY_COMMAND_NAMES) handlers[name]()
    const invoked = new Set(deps.runOperation.mock.calls.map(call => call[0] as AssemblyOperationId))
    for (const id of Object.keys(ASSEMBLY_OPERATIONS) as AssemblyOperationId[]) {
      expect(invoked.has(id), `operation "${id}" is not wired to any command`).toBe(true)
    }
  })

  it('each mutating command runs the operation the map names', () => {
    for (const [command, operation] of Object.entries(ASSEMBLY_OPERATION_BY_COMMAND)) {
      const deps = handlerDeps()
      buildAssemblyHandlers(deps)[command as AssemblyCommandName]()
      const invoked = deps.runOperation.mock.calls.map(call => call[0])
      expect(invoked, `command "${command}"`).toContain(operation)
    }
  })
})
