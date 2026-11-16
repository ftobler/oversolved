import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AssemblyTree } from '@/components/layout/AssemblyTree'
import type { PartInstance, MateFeature } from '@/types/cad'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'

function instance(handle: string, visible = true): PartInstance {
  return { handle, doc_id: `doc-${handle}`, doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, visible }
}

const noop = () => {}

function renderTree(instances: PartInstance[], onToggleVisible = vi.fn()) {
  return render(
    <AssemblyTree
      instances={instances}
      builtins={[]}
      mates={[] as MateFeature[]}
      status={{ verdict: 'none', residualNorm: 0, rank: 0, dof: 0, iters: 0, mates: {}, parts: {} }}
      onOpenPartNewTab={noop}
      onDuplicateInstance={noop}
      onDeleteInstance={noop}
      onToggleVisible={onToggleVisible}
      onToggleFixed={noop}
      onToggleBuiltinVisible={noop}
      onEditInstance={noop}
      onCommitInstance={noop}
      onCancelInstance={noop}
      renderInstanceEditor={() => null}
      onCommitMate={noop}
      onCancelMate={noop}
      onDeleteMate={noop}
      onRequestRenameMate={noop}
      renderMateEditor={() => null}
    />
  )
}

describe('AssemblyTree part row tridot menu visibility', () => {
  it('shows Hide for a visible instance and calls onToggleVisible(handle, false)', () => {
    const onToggleVisible = vi.fn()
    const { container } = renderTree([instance('h1', true)], onToggleVisible)
    const btn = container.querySelector('button[aria-label="Part options"]') as HTMLButtonElement
    fireEvent.click(btn)
    const hide = screen.getByText('Hide')
    expect(hide).toBeTruthy()
    fireEvent.click(hide.closest('button') as HTMLButtonElement)
    expect(onToggleVisible).toHaveBeenCalledWith('h1', false)
  })

  it('shows Show for a hidden instance and calls onToggleVisible(handle, true)', () => {
    const onToggleVisible = vi.fn()
    const { container } = renderTree([instance('h1', false)], onToggleVisible)
    const btn = container.querySelector('button[aria-label="Part options"]') as HTMLButtonElement
    fireEvent.click(btn)
    const show = screen.getByText('Show')
    expect(show).toBeTruthy()
    fireEvent.click(show.closest('button') as HTMLButtonElement)
    expect(onToggleVisible).toHaveBeenCalledWith('h1', true)
  })
})
