// @vitest-environment node
//
// The command catalog is pure data built from a spec table: the metadata, the
// machine-readable param fields and the caller's enabled verdict, sorted for a
// stable serialization. The real table's shape is pinned by the CLI e2e
// snapshot; this suite pins the mapping with hand-made specs.

import { describe, it, expect } from 'vitest'
import { commandCatalog } from '../commandCatalog'
import { Field, noParams, objectParams, type ErasedCommandSpec, type CommandContext } from '@/utils/core/commandSpec'
import type { CommandName } from '@/utils/core/commandNames'
import { PART_COMMAND_SPECS } from '@/pages/commandEntries'

function spec(id: string, patch: Partial<ErasedCommandSpec<CommandContext>> = {}): ErasedCommandSpec<CommandContext> {
  return {
    id: id as CommandName,
    label: `label ${id}`,
    params: noParams(),
    enabled: () => true,
    run: () => ({ ok: true, createdIds: [] }),
    undoable: false,
    ...patch,
  } as ErasedCommandSpec<CommandContext>
}

describe('commandCatalog', () => {
  it('maps id, label, undoable and the param fields, sorted by id', () => {
    const specs = [
      spec('undo', { label: 'Undo', shortcut: 'ctrl+z', undoable: false }),
      spec('add_extrude', {
        undoable: true,
        params: objectParams({ sketchQuery: Field.string(), distance: Field.number() }),
      }),
    ]
    expect(commandCatalog(specs, () => true)).toEqual([
      {
        id: 'add_extrude',
        label: 'label add_extrude',
        undoable: true,
        params: [
          { name: 'sketchQuery', type: 'string' },
          { name: 'distance', type: 'number' },
        ],
        enabled: true,
      },
      { id: 'undo', label: 'Undo', shortcut: 'ctrl+z', undoable: false, params: [], enabled: true },
    ])
  })

  it('carries the caller\'s enabled verdict per command', () => {
    const catalog = commandCatalog([spec('undo'), spec('redo')], id => (id === 'undo' ? 'nothing to undo' : true))
    expect(catalog.find(e => e.id === 'undo')?.enabled).toBe('nothing to undo')
    expect(catalog.find(e => e.id === 'redo')?.enabled).toBe(true)
  })

  it('never invokes a spec body while reading', () => {
    let ran = false
    const catalog = commandCatalog([spec('undo', { run: () => { ran = true; return { ok: true, createdIds: [] } } })], () => true)
    expect(catalog).toHaveLength(1)
    expect(ran).toBe(false)
  })

  it('builds the real part table with params on every entry', () => {
    // The catalog is what the CLI and MCP advertise; importing the real table
    // keeps this honest without spawning a process.
    const catalog = commandCatalog(PART_COMMAND_SPECS, () => true)
    expect(catalog.length).toBe(PART_COMMAND_SPECS.length)
    // apply_offset is the table's parametric command: its distance arrives as
    // data, which is what a headless caller needs to see in the catalog.
    expect(catalog.find(e => e.id === 'apply_offset')?.params).toEqual([{ name: 'distance', type: 'number' }])
    expect(catalog.map(e => e.id)).toEqual([...catalog.map(e => e.id)].sort())
  })
})
