import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { okResult } from '@/session/result'
import { COMMAND_NAMES } from '@/utils/core/commandNames'
import { PART_COMMAND_SPECS } from '@/pages/commandEntries'
import { useSketchEditorStore, useSketchUiStore } from '@/stores/sketchEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import { initializeTools } from '@/tools'
import {
  assemblyRegistry, minimalAssemblyParams, minimalPartParams, partContext, partRegistry,
} from './commandFixtures'

// The completeness proof, headless: every COMMAND_NAMES entry is a spec in
// exactly one editor (the three shared names in both), its enabled predicate
// answers with true or a reason, and its run body executes with minimal valid
// params and comes back as a Result. Programmatic execution must never open a
// dialog, so the value-dialog port is spied across the whole enumeration.

const partIds = new Set(PART_COMMAND_SPECS.map(s => s.id))

function registryFor(name: (typeof COMMAND_NAMES)[number]) {
  return partIds.has(name) ? partRegistry() : assemblyRegistry()
}

function paramsFor(name: (typeof COMMAND_NAMES)[number]): unknown {
  return partIds.has(name) ? minimalPartParams(name) : minimalAssemblyParams(name)
}

describe('command completeness', () => {
  beforeEach(() => {
    initializeTools()
    useEditorState.setState({
      activeTool: null,
      activeFeatureId: null,
      activePickField: null,
      modeStack: [],
      drawPoints: [],
      dimensionPicks: [],
      normalSelection: new Set(),
      selectedPicks: new Map(),
    })
    useSketchUiStore.setState({ pendingDialog: null })
  })

  it('every name has a spec, an enabled verdict and an ok Result with minimal params', () => {
    for (const name of COMMAND_NAMES) {
      const registry = registryFor(name)
      const verdict = registry.enabled(name)
      expect(verdict === true || typeof verdict === 'string', `enabled("${name}")`).toBe(true)

      const result = registry.execute(name, paramsFor(name))
      expect(result.ok, `run("${name}") failed: ${result.ok ? '' : result.message}`).toBe(true)
      if (result.ok) expect(Array.isArray(result.createdIds), `run("${name}") createdIds`).toBe(true)
    }
  })

  // Only the sketch value dialog is pinned here, and only for the part table:
  // `openDialog` is the sketch UI store's prompt (the one `apply_offset`'s
  // front end would raise), so a part run that took its value as params must
  // never touch it. This is not a claim about every command: the assembly
  // specs legitimately open UI through their context callbacks
  // (`insert_part_instance` opens the part picker, `export_assembly` opens the
  // export dialog, `insert_mate_*` opens the fresh mate's editor), which are
  // page side effects a registry-level run does not exercise.
  it('part commands take their values as params instead of opening the sketch value dialog', () => {
    const openDialog = vi.spyOn(useSketchUiStore.getState(), 'openDialog').mockImplementation(() => {})
    for (const name of COMMAND_NAMES) {
      if (!partIds.has(name)) continue
      partRegistry().execute(name, paramsFor(name))
    }
    expect(openDialog).not.toHaveBeenCalled()
    openDialog.mockRestore()
  })

  it('a data command reports the ids its mutation created', () => {
    const registry = partRegistry(partContext({ addFeature: () => okResult(['feat-1']) }))
    expect(registry.execute('add_extrude')).toEqual({ ok: true, createdIds: ['feat-1'] })
  })

  it('an unknown id is an error Result, not a throw', () => {
    const registry = partRegistry()
    const unknown = 'not_a_command' as (typeof COMMAND_NAMES)[number]
    expect(registry.execute(unknown)).toEqual({
      ok: false,
      code: 'unknown-command',
      message: 'unknown command "not_a_command"',
    })
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  useSketchEditorStore.getState().setActiveTool(null)
})
