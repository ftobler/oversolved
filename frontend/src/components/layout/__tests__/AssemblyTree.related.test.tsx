// Cross-highlight between the two panes: selecting a part row marks the mate
// rows that reference it, and selecting a mate row marks the two part rows it
// mates, both in the .related class (the hover look), distinct from .selected.

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { AssemblyTree } from '@/components/layout/AssemblyTree'
import type { AssemblyDoc, PartInstance, MateFeature } from '@/types/cad'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'
import { appendMate, mateFeatures, removeMate } from '@/utils/assemblyMutations'

function instance(handle: string): PartInstance {
  return { handle, doc_id: `doc-${handle}`, doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, visible: true }
}

function mate(id: string, partA: string, partB: string): MateFeature {
  return { id, mate: { kind: 'fixed', label: `Fixed ${id.slice(1)}`, ref_a: { part: partA, anchor: 'a1' }, ref_b: { part: partB, anchor: 'b1' } } }
}

const instances = [instance('p1'), instance('p2'), instance('p3')]
const mates = [mate('m1', 'p1', 'p2'), mate('m2', 'p2', 'p3'), mate('m3', 'p1', 'p1')]

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
      renderInstanceEditor={() => null}
      onCommitMate={noop}
      onCancelMate={noop}
      onDeleteMate={noop}
      onRequestRenameMate={noop}
      renderMateEditor={() => null}
      {...props}
    />
  )
}

function rowByName(container: HTMLElement, name: string): HTMLElement {
  const span = [...container.querySelectorAll('.feature-name')].find(n => n.textContent === name)
  if (!span) throw new Error(`row not found: ${name}`)
  return span.closest('.feature-item') as HTMLElement
}

describe('AssemblyTree cross-highlight', () => {
  it('selecting a part marks the mates that reference it as related', () => {
    const { container } = renderTree({ subject: { kind: 'part', handle: 'p1' } })
    expect(rowByName(container, 'Fixed 1').className).toContain('related')  // m1: p1-p2
    expect(rowByName(container, 'Fixed 3').className).toContain('related')  // m3: self-mate on p1
    expect(rowByName(container, 'Fixed 2').className).not.toContain('related')  // m2: p2-p3
  })

  it('selecting a mate marks its two parts as related, not itself', () => {
    const { container } = renderTree({ subject: { kind: 'mate', id: 'm1' } })
    expect(rowByName(container, 'doc-p1').className).toContain('related')
    expect(rowByName(container, 'doc-p2').className).toContain('related')
    expect(rowByName(container, 'doc-p3').className).not.toContain('related')
    expect(rowByName(container, 'Fixed 1').className).not.toContain('related')
  })

  it('a self-mate highlights its one part row once', () => {
    const { container } = renderTree({ subject: { kind: 'mate', id: 'm3' } })
    const p1Row = rowByName(container, 'doc-p1')
    expect(p1Row.className).toContain('related')
    // querySelectorAll would only ever find the row once either way (handles
    // are unique per row); the assertion that matters is that the class is not
    // duplicated in the string, i.e. it was added exactly once.
    expect(p1Row.className.match(/related/g)?.length).toBe(1)
  })

  it('nothing is related when nothing is selected', () => {
    const { container } = renderTree()
    for (const el of container.querySelectorAll('.feature-item')) {
      expect(el.className).not.toContain('related')
    }
  })

  it('the selected row itself keeps .selected and never gains .related from its own selection', () => {
    const { container } = renderTree({ subject: { kind: 'part', handle: 'p1' } })
    const p1Row = rowByName(container, 'doc-p1')
    expect(p1Row.className).toContain('selected')
    expect(p1Row.className).not.toContain('related')
  })
})

describe('AssemblyTree default mate names', () => {
  function twoFixedMates(): AssemblyDoc {
    let doc: AssemblyDoc = { kind: 'assembly', features: [] }
    doc = appendMate(doc, 'fixed', 'm1')
    return appendMate(doc, 'fixed', 'm2')
  }

  // The stored label is what the row shows and what seeds the rename dialog, so
  // deleting an earlier mate of the same kind can no longer renumber it from
  // "Fixed 2" back to "Fixed 1".
  it('keeps the second mate named "Fixed 2" after the first is removed', () => {
    const before = renderTree({ mates: mateFeatures(twoFixedMates()) })
    expect(before.getByText('Fixed 2')).toBeInTheDocument()
    before.unmount()

    const after = renderTree({ mates: mateFeatures(removeMate(twoFixedMates(), 'm1')) })
    expect(after.getByText('Fixed 2')).toBeInTheDocument()
    expect(after.queryByText('Fixed 1')).not.toBeInTheDocument()
  })
})
