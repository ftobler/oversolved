import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { AssemblyTree } from '@/components/layout/AssemblyTree'
import type { AssemblyDoc, PartInstance } from '@/types/cad'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'
import { instanceLabel } from '@/utils/instanceLabel'

function instance(handle: string, docId: string): PartInstance {
  return { handle, doc_id: docId, doc_rev: 0, transform: { ...IDENTITY_TRANSFORM }, visible: true }
}

const childDoc: AssemblyDoc = {
  kind: 'assembly',
  features: [
    { id: 'cf1', kind: 'part_instance', instance: instance('bolt', 'part-bolt') },
    { id: 'cf2', kind: 'part_instance', instance: instance('nut', 'part-nut') },
  ],
}

const instances = [instance('sub', 'asm-sub'), instance('bracket', 'part-b')]
const docNames = {
  'asm-sub': 'Gripper', 'part-bolt': 'Bolt', 'part-nut': 'Nut', 'part-b': 'Bracket',
}

const noop = () => {}

function renderTree(props: Partial<React.ComponentProps<typeof AssemblyTree>> = {}) {
  const shown = props.instances ?? instances
  return render(
    <AssemblyTree
      instances={shown}
      builtins={[]}
      mates={[]}
      labelFor={handle => instanceLabel(shown, docNames, handle)}
      subassemblies={{ 'asm-sub': childDoc }}
      docKindOf={docId => (docId === 'asm-sub' ? 'assembly' : 'part')}
      docNames={docNames}
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
    />
  )
}

function rowByName(container: HTMLElement, name: string): HTMLElement {
  const span = [...container.querySelectorAll('.feature-name')].find(node => node.textContent === name)
  if (!span) throw new Error(`row not found: ${name}`)
  return span.closest('.feature-item') as HTMLElement
}

describe('AssemblyTree sub-assemblies', () => {
  it('shows authored ordinals when two rows share one part document', () => {
    const twins = [instance('one', 'part-b'), instance('two', 'part-b')]
    const { container } = renderTree({ instances: twins })
    expect([...container.querySelectorAll('.feature-name')].map(node => node.textContent))
      .toEqual(['Bracket', 'Bracket (2)'])
  })

  it('starts folded, then a chevron reveals indented child rows', () => {
    const { container } = renderTree()
    expect(rowByName(container, 'Gripper')).toBeTruthy()
    expect(container.querySelector('.assembly-subtree')).toBeNull()

    const chevron = rowByName(container, 'Gripper').querySelector('.subassembly-chevron')!
    fireEvent.click(chevron)

    const subtree = container.querySelector('.assembly-subtree')!
    expect(subtree).toBeTruthy()
    expect([...subtree.querySelectorAll('.feature-name')].map(node => node.textContent)).toEqual(['Bolt', 'Nut'])
    // Child rows are read-only here: no edit or delete action at all.
    const bolt = rowByName(container, 'Bolt')
    expect(bolt.querySelector('.feature-edit-btn')).toBeNull()
    expect(bolt.querySelectorAll('.feature-item-actions button')).toHaveLength(2)  // eye + options
    const menu = bolt.querySelector('[aria-label="Bolt options"]')!
    fireEvent.click(menu)
    expect(document.body.textContent).not.toContain('Delete')
    expect(document.body.textContent).toContain('Open in new tab')
  })

  it('selecting a child selects the top-level instance plus its leaf path', () => {
    const onSelectPart = vi.fn()
    const { container } = renderTree({ onSelectPart })
    fireEvent.click(rowByName(container, 'Gripper').querySelector('.subassembly-chevron')!)
    fireEvent.click(rowByName(container, 'Bolt'))
    expect(onSelectPart).toHaveBeenCalledWith('sub', 'bolt')
  })

  it('the child eye is a view filter callback, not a document write', () => {
    const onSetLeafVisible = vi.fn()
    const { container } = renderTree({ onSetLeafVisible })
    fireEvent.click(rowByName(container, 'Gripper').querySelector('.subassembly-chevron')!)
    const hide = rowByName(container, 'Bolt').querySelector('[aria-label="Hide Bolt"]')!
    fireEvent.click(hide)
    expect(onSetLeafVisible).toHaveBeenCalledWith('sub/bolt', false)
  })

  it('a drop onto a sub-assembly row is a no-op', () => {
    const onReorderInstance = vi.fn()
    const { container } = renderTree({ onReorderInstance })
    const bracket = rowByName(container, 'Bracket')
    const subRow = rowByName(container, 'Gripper')

    fireEvent.dragStart(bracket, { dataTransfer: { effectAllowed: '' } })
    fireEvent.dragOver(subRow, { dataTransfer: { dropEffect: '' } })
    expect(subRow.className).not.toContain('drag-over')
    fireEvent.drop(subRow, { dataTransfer: { dropEffect: '' } })
    expect(onReorderInstance).not.toHaveBeenCalled()
  })
})
