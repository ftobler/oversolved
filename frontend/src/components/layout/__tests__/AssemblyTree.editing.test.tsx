// Opening an editor keeps the subject on the row, so an edited row may carry
// both `.selected` and `.editing`. The look is pinned by the stylesheet test;
// this pins that both editor entry points reach the same editing state.
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { AssemblyTree } from '@/components/layout/AssemblyTree'
import type { MateFeature, PartInstance } from '@/types/cad'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'

function instance(handle: string, docId: string): PartInstance {
  return { handle, doc_id: docId, doc_rev: 0, transform: { ...IDENTITY_TRANSFORM }, visible: true }
}

const mates: MateFeature[] = [
  {
    id: 'm1',
    mate: {
      kind: 'fixed',
      label: 'Fix 1',
      ref_a: { part: 'p1', anchor: 'a1' },
      ref_b: { part: 'p2', anchor: 'b1' },
    },
  },
]

const noop = () => {}

function renderTree(props: Partial<React.ComponentProps<typeof AssemblyTree>> = {}) {
  return render(
    <AssemblyTree
      instances={[instance('p1', 'part-a'), instance('p2', 'part-b')]}
      builtins={[]}
      mates={mates}
      labelFor={handle => ({ p1: 'Alpha', p2: 'Beta' })[handle]}
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

function rowByName(container: HTMLElement, name: string): HTMLElement {
  const span = [...container.querySelectorAll('.feature-name')].find(node => node.textContent === name)
  if (!span) throw new Error(`row not found: ${name}`)
  return span.closest('.feature-item') as HTMLElement
}

describe('AssemblyTree editing rows', () => {
  it('marks an edited part as editing while it is also the selected subject', () => {
    const { container } = renderTree({
      subject: { kind: 'part', handle: 'p1' },
      editingInstanceHandle: 'p1',
    })
    const row = rowByName(container, 'Alpha')
    expect(row.classList.contains('editing')).toBe(true)
    expect(row.classList.contains('selected')).toBe(true)
  })

  it('marks an edited mate the same way', () => {
    const { container } = renderTree({
      subject: { kind: 'mate', id: 'm1' },
      editingMateId: 'm1',
    })
    const row = rowByName(container, 'Fix 1')
    expect(row.classList.contains('editing')).toBe(true)
    expect(row.classList.contains('selected')).toBe(true)
  })
})
