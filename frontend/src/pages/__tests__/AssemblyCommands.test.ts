import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { useAssemblyCommands } from '@/pages/AssemblyKeyboardShortcuts'
import {
  ASSEMBLY_COMMAND_NAMES,
  ASSEMBLY_OPERATION_BY_COMMAND,
  buildAssemblyCommandEntries,
  type AssemblyCommandHandlers,
} from '@/pages/assemblyCommandEntries'
import { ASSEMBLY_OPERATIONS, type AssemblyOperationId } from '@/utils/assemblyOperations'
import { executeCommand, clearAllHandlers } from '@/utils/core/commandRegistry'

function spyHandlers(): AssemblyCommandHandlers {
  return Object.fromEntries(ASSEMBLY_COMMAND_NAMES.map(n => [n, vi.fn()])) as AssemblyCommandHandlers
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
  it('each mutating command resolves to a real operation', () => {
    for (const [command, operation] of Object.entries(ASSEMBLY_OPERATION_BY_COMMAND)) {
      expect(ASSEMBLY_COMMAND_NAMES, `unknown command "${command}"`).toContain(command)
      expect(ASSEMBLY_OPERATIONS[operation], `unknown operation "${operation}"`).toBeTruthy()
    }
  })

  it('every operation is reachable from at least one command', () => {
    const reachable = new Set<AssemblyOperationId>(Object.values(ASSEMBLY_OPERATION_BY_COMMAND))
    for (const id of Object.keys(ASSEMBLY_OPERATIONS) as AssemblyOperationId[]) {
      expect(reachable.has(id), `operation "${id}" has no command`).toBe(true)
    }
  })
})
