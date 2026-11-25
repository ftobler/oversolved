// The icon column is one shared row grammar: a part editor feature row, the
// assembly's built-in and mate rows, and its part rows all start their title
// with `.feature-icon`. A disclosure chevron must not buy its width by pushing
// the part icon to the right.
import { describe, it, expect } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { AssemblyTree } from '@/components/layout/AssemblyTree'
import type { AssemblyDoc, MateFeature, PartInstance } from '@/types/cad'
import type { AssemblyBuiltinListItem } from '@/utils/assemblyRender'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'

function instance(handle: string, docId: string): PartInstance {
  return { handle, doc_id: docId, doc_rev: 0, transform: { ...IDENTITY_TRANSFORM }, visible: true }
}

const builtins: AssemblyBuiltinListItem[] = [
  { id: 'AssemblyOrigin', kind: 'origin', label: 'Origin', visible: true },
  { id: 'AssemblyTop', kind: 'plane', label: 'Top', visible: true },
]

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
      builtins={builtins}
      mates={mates}
      labelFor={handle => ({ p1: 'Alpha', p2: 'Beta', sub: 'Gripper' })[handle]}
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

function titleOf(row: HTMLElement): HTMLElement {
  return row.querySelector('.feature-item-title') as HTMLElement
}

describe('AssemblyTree row icon column', () => {
  it('starts every plain part, builtin and mate title with the icon', () => {
    const { container } = renderTree()
    expect(container.querySelector('.subassembly-chevron-spacer')).toBeNull()
    for (const name of ['Origin', 'Top', 'Alpha', 'Beta', 'Fix 1']) {
      const first = titleOf(rowByName(container, name)).firstElementChild as HTMLElement
      expect(first.classList.contains('feature-icon'), `${name} title`).toBe(true)
    }
  })

  it('keeps a sub-assembly icon in the same column, its chevron after the name', () => {
    const childDoc: AssemblyDoc = {
      kind: 'assembly',
      features: [{ id: 'cf1', kind: 'part_instance', instance: instance('bolt', 'part-bolt') }],
    }
    const { container } = renderTree({
      instances: [instance('sub', 'asm-sub'), instance('p2', 'part-b')],
      subassemblies: { 'asm-sub': childDoc },
      docKindOf: docId => (docId === 'asm-sub' ? 'assembly' : 'part'),
      docNames: { 'part-bolt': 'Bolt' },
    })
    const subRow = rowByName(container, 'Gripper')
    const subTitle = titleOf(subRow)
    expect(subTitle.firstElementChild!.classList.contains('feature-icon')).toBe(true)
    const chevron = subTitle.querySelector('.subassembly-chevron') as HTMLButtonElement
    expect(chevron).not.toBeNull()
    const name = subTitle.querySelector('.feature-name')!
    expect(name.compareDocumentPosition(chevron) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    expect(subRow.querySelector('.subassembly-chevron-spacer')).toBeNull()
    expect(rowByName(container, 'Beta').querySelector('.subassembly-chevron-spacer')).toBeNull()

    fireEvent.click(container.querySelector('[aria-label="Expand Gripper"]')!)
    const boltTitle = titleOf(rowByName(container, 'Bolt'))
    expect(boltTitle.getAttribute('style')).toMatch(/padding-left/)
    expect(boltTitle.firstElementChild!.classList.contains('feature-icon')).toBe(true)

    fireEvent.click(container.querySelector('[aria-label="Collapse Gripper"]')!)
    expect(container.querySelector('.assembly-subtree')).toBeNull()
  })
})
