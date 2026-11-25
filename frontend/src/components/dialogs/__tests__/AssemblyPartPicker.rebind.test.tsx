// Rebind mode reuses the insert dialog's one list so the tiles and the
// set_part_doc guard cannot disagree about what may be bound. These cases shape
// `entries` the way the editor does, rather than fetching a second list.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { WorkspaceSession } from '@/workspace/session'
import type { EntryMeta } from '@/workspace/types'

vi.mock('@/hooks/usePreview', () => ({ usePreview: () => undefined }))

import AssemblyPartPicker from '@/components/dialogs/AssemblyPartPicker'

const entry = (id: string, name: string, rev: number, docKind = 'part'): EntryMeta => ({
  id, path: `documents/${name}.yaml`, kind: 'document', name, docKind, rev, updatedAt: 0,
})

function session(): WorkspaceSession {
  return {
    workspace: 'ws-1',
    readEntry: vi.fn(),
    writeEntry: vi.fn(),
    resolveFile: vi.fn(),
    referencesOf: vi.fn(),
  } as unknown as WorkspaceSession
}

function renderRebind(overrides: Partial<ComponentProps<typeof AssemblyPartPicker>> = {}) {
  const props: ComponentProps<typeof AssemblyPartPicker> = {
    isOpen: true,
    selfUuid: 'asm-1',
    session: session(),
    entries: [entry('part-1', 'Bracket', 5), entry('part-2', 'Bolt', 2)],
    refreshing: false,
    mode: { kind: 'rebind', handle: 'inst-1', currentDocId: 'part-1' },
    onRefresh: vi.fn(),
    onClose: vi.fn(),
    onPick: vi.fn(),
    ...overrides,
  }
  render(<AssemblyPartPicker {...props} />)
  return props
}

const tile = (name: string) => screen.getByText(name).closest('button') as HTMLButtonElement

describe('AssemblyPartPicker rebind mode', () => {
  it('titles itself Replace part, marks the current tile selected and keeps it pickable', async () => {
    renderRebind()
    expect(screen.getByRole('heading', { name: 'Replace part' })).toBeTruthy()
    await waitFor(() => expect(tile('Bracket')).toHaveClass('selected'))
    expect(tile('Bracket')).not.toBeDisabled()
    expect(tile('Bracket')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Replace' })).toBeEnabled()
  })

  it('confirms the picked doc with its rev and closes', async () => {
    const props = renderRebind()
    await waitFor(() => expect(tile('Bracket')).toHaveClass('selected'))
    fireEvent.click(tile('Bolt'))
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    expect(props.onPick).toHaveBeenCalledWith('part-2', 2)
    expect(props.onClose).toHaveBeenCalled()
  })

  it('leaves the current doc alone when the dialog is cancelled', () => {
    const props = renderRebind()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.onPick).not.toHaveBeenCalled()
    expect(props.onClose).toHaveBeenCalled()
  })

  it('keeps a cycle-forming assembly listed but disabled with its reason', () => {
    renderRebind({
      entries: [entry('part-1', 'Bracket', 5), entry('sub', 'Gripper', 1, 'assembly')],
      cycleReasonFor: id => id === 'sub' ? 'Adding Gripper would make a circular assembly: Gripper > this assembly' : undefined,
    })
    expect(screen.getByLabelText('Assemblies')).toBeTruthy()
    expect(tile('Gripper')).toBeDisabled()
    expect(tile('Gripper').title).toBe('Adding Gripper would make a circular assembly: Gripper > this assembly')
  })

  it('allows an assembly that set_part_doc accepts, so an instance can change kind', async () => {
    const props = renderRebind({
      entries: [entry('part-1', 'Bracket', 5), entry('free', 'Stand', 1, 'assembly')],
    })
    await waitFor(() => expect(tile('Bracket')).toHaveClass('selected'))
    fireEvent.click(tile('Stand'))
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    expect(props.onPick).toHaveBeenCalledWith('free', 1)
  })

  it('keeps the insert mode wording unchanged', () => {
    render(<AssemblyPartPicker
      isOpen
      selfUuid="asm-1"
      session={session()}
      entries={[entry('part-1', 'Bracket', 5)]}
      refreshing={false}
      onRefresh={vi.fn()}
      onClose={vi.fn()}
      onPick={vi.fn()}
    />)
    expect(screen.getByRole('heading', { name: 'Insert part' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Insert' })).toBeTruthy()
  })
})
