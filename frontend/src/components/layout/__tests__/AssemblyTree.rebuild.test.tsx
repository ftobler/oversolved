// The assembly Parts header carries the part editor's Rebuild button. A rebuild
// is the user's escape hatch when a solve looks stuck, so it must be reachable
// from the tree and must show that the solve it asked for is running.

import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, within } from '@testing-library/react'
import { AssemblyTree } from '@/components/layout/AssemblyTree'
import type { PartInstance, MateFeature } from '@/types/cad'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'

const instances: PartInstance[] = [
  { handle: 'p1', doc_id: 'doc-p1', doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, visible: true },
]
const mates: MateFeature[] = [
  { id: 'm1', mate: { kind: 'fixed', label: 'Fixed 1', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'b1' } } },
]

const noop = () => {}

function renderTree(props: Partial<React.ComponentProps<typeof AssemblyTree>> = {}) {
  return render(
    <AssemblyTree
      instances={instances}
      builtins={[]}
      mates={mates}
      onOpenPartNewTab={noop}
      onDuplicateInstance={noop}
      onDeleteInstance={noop}
      onToggleVisible={noop}
      onToggleFixed={noop}
      onToggleBuiltinVisible={noop}
      onEditInstance={noop}
      onCommitInstance={noop}
      onCancelInstance={noop}
      onCommitMate={noop}
      onCancelMate={noop}
      onDeleteMate={noop}
      onRequestRenameMate={noop}
      {...props}
    />,
  )
}

describe('AssemblyTree rebuild action', () => {
  it('renders a rebuild button in the Parts header when onRebuild is given', () => {
    const { container } = renderTree({ onRebuild: noop })
    const header = container.querySelector('.sidebar-top .sidebar-header') as HTMLElement
    expect(header).not.toBeNull()
    const button = within(header).getByRole('button', { name: /Rebuild geometry/i })
    // The assembly tooltip says what the assembly rebuild does, which is more
    // than the part editor's shared default.
    expect(button.getAttribute('title')).toBe('Rebuild assembly (rebuilds every part, clears cache)')
    // The heading is still the header's text: the button contributes no label.
    expect(header.textContent).toBe('Parts')
  })

  it('renders no rebuild button without an onRebuild callback', () => {
    const { container } = renderTree()
    const header = container.querySelector('.sidebar-top .sidebar-header') as HTMLElement
    expect(within(header).queryByRole('button', { name: /Rebuild geometry/i })).toBeNull()
  })

  it('calls onRebuild on click', () => {
    const onRebuild = vi.fn()
    const { container } = renderTree({ onRebuild })
    const header = container.querySelector('.sidebar-top .sidebar-header') as HTMLElement
    fireEvent.click(within(header).getByRole('button', { name: /Rebuild geometry/i }))
    expect(onRebuild).toHaveBeenCalledTimes(1)
  })

  it('shows the spinner and is disabled while the solve is running', () => {
    const { container } = renderTree({ onRebuild: noop, isRebuilding: true })
    const header = container.querySelector('.sidebar-top .sidebar-header') as HTMLElement
    const button = within(header).getByRole('button', { name: /Rebuild geometry/i })
    expect(button).toBeDisabled()
    expect(button.querySelector('.rebuild-spinner')).not.toBeNull()
  })

  it('shows the icon and stays enabled when no solve is running', () => {
    const { container } = renderTree({ onRebuild: noop, isRebuilding: false })
    const header = container.querySelector('.sidebar-top .sidebar-header') as HTMLElement
    const button = within(header).getByRole('button', { name: /Rebuild geometry/i })
    expect(button).not.toBeDisabled()
    expect(button.querySelector('.rebuild-spinner')).toBeNull()
    expect(button.querySelector('img')).not.toBeNull()
  })
})
