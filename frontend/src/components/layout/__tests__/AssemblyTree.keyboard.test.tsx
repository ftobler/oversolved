// The tree rows are reachable by keyboard, not only by a pointer click. Without
// this, the store selection `delete_selected` reads can only be established with
// a mouse, so [Delete] is unreachable without a pointer.

import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { AssemblyTree } from '@/components/layout/AssemblyTree'
import type { PartInstance, MateFeature } from '@/types/cad'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'

const instances: PartInstance[] = [
  { handle: 'p1', doc_id: 'doc-p1', doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, visible: true },
]
const mates: MateFeature[] = [
  {
    id: 'm1',
    mate: { kind: 'fixed', label: 'Fixed 1', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'b1' } },
  },
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
      renderInstanceEditor={() => <input />}
      onCommitMate={noop}
      onCancelMate={noop}
      onDeleteMate={noop}
      onRequestRenameMate={noop}
      renderMateEditor={() => null}
      {...props}
    />
  )
}

describe('AssemblyTree keyboard reachability', () => {
  it('exposes the two lists as listboxes and the rows as tabbable options', () => {
    const { container } = renderTree()
    expect(container.querySelectorAll('[role="listbox"]')).toHaveLength(2)
    const options = container.querySelectorAll('[role="option"]')
    expect(options).toHaveLength(2)
    for (const option of options) {
      expect(option.getAttribute('tabindex')).toBe('0')
    }
  })

  it('selects the part on Enter and reflects aria-selected', () => {
    const onSelectPart = vi.fn()
    const { container } = renderTree({ onSelectPart, subject: { kind: 'part', handle: 'p1' } })
    const partRow = container.querySelector('[role="option"]') as HTMLElement
    expect(partRow.getAttribute('aria-selected')).toBe('true')
    partRow.focus()
    fireEvent.keyDown(partRow, { key: 'Enter' })
    expect(onSelectPart).toHaveBeenCalledWith('p1')
  })

  it('selects the mate on Space', () => {
    const onSelectMate = vi.fn()
    const { container } = renderTree({ onSelectMate })
    const mateRow = container.querySelectorAll('[role="option"]')[1] as HTMLElement
    fireEvent.keyDown(mateRow, { key: ' ' })
    expect(onSelectMate).toHaveBeenCalledWith('m1')
  })

  // A key event that bubbles out of an inline editor control must not re-select
  // the subject being edited: only the row itself answers Enter/Space.
  it('ignores a key event bubbling from a control inside the row', () => {
    const onSelectPart = vi.fn()
    const { container } = renderTree({ onSelectPart, editingInstanceHandle: 'p1' })
    const input = container.querySelector('input') as HTMLElement
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelectPart).not.toHaveBeenCalled()
  })
})
