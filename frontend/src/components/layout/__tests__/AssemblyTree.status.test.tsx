// The assembly tree's solve-status marks: a failed part or mate reddens its own
// row with the real cause, instead of the old hardcoded re-pick tooltip.

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { AssemblyTree } from '@/components/layout/AssemblyTree'
import type { PartInstance, MateFeature } from '@/types/cad'
import type { AssemblySolveStatus } from '@/kernel/solveAssembly'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'

function instance(handle: string): PartInstance {
  return { handle, doc_id: `doc-${handle}`, doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, visible: true }
}

const instances = [instance('hGood'), instance('hBad')]
const mates: MateFeature[] = [
  { id: 'm1', mate: { kind: 'fixed', ref_a: { part: 'hGood', anchor: 'a1' }, ref_b: { part: 'hBad', anchor: 'b1' } } },
]

const noop = () => {}

function status(overrides: Partial<AssemblySolveStatus> = {}): AssemblySolveStatus {
  return {
    verdict: 'none', residualNorm: 0, rank: 0, dof: 0, iters: 0,
    mates: {}, parts: {},
    ...overrides,
  }
}

function renderTree(statusProp: AssemblySolveStatus) {
  return render(
    <AssemblyTree
      instances={instances}
      builtins={[]}
      mates={mates}
      status={statusProp}
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
    />
  )
}

function rowByName(container: HTMLElement, name: string): HTMLElement {
  const span = [...container.querySelectorAll('.feature-name')].find(n => n.textContent === name)
  if (!span) throw new Error(`row not found: ${name}`)
  return span.closest('.feature-item') as HTMLElement
}

function nameByName(container: HTMLElement, name: string): HTMLElement {
  const span = [...container.querySelectorAll('.feature-name')].find(n => n.textContent === name)
  if (!span) throw new Error(`name not found: ${name}`)
  return span as HTMLElement
}

describe('AssemblyTree solve-status marks', () => {
  it('reddens only the failed part row and puts its message on the row', () => {
    const { container } = renderTree(status({
      parts: { hBad: { failed: true, error: 'part doc not found: hBad' } },
    }))

    const badRow = rowByName(container, 'doc-hBad')
    expect(nameByName(container, 'doc-hBad').className).toContain('feature-name-error')
    expect(badRow.getAttribute('title')).toBe('part doc not found: hBad')

    const goodRow = rowByName(container, 'doc-hGood')
    expect(goodRow.className).not.toContain('feature-name-error')
    expect(nameByName(container, 'doc-hGood').className).not.toContain('feature-name-error')
    expect(goodRow.getAttribute('title')).toBeNull()
  })

  it('names an unsupported mate kind instead of the re-pick text', () => {
    const { container } = renderTree(status({
      mates: { m1: { stale: true, error: "unsupported mate kind 'worm_gear'" } },
    }))

    const row = rowByName(container, 'Fixed 1')
    const title = row.getAttribute('title') ?? ''
    expect(title).toContain('unsupported mate kind')
    expect(title).not.toContain('re-pick')
    expect(nameByName(container, 'Fixed 1').className).toContain('feature-name-error')
    // A real cause does not carry the bare-stale class.
    expect(row.className).not.toContain('stale')
  })

  it('keeps the legacy stale look for a bare unresolved reference', () => {
    const { container } = renderTree(status({
      mates: { m1: { stale: true, staleRefs: ['ref_b'] } },
    }))

    const row = rowByName(container, 'Fixed 1')
    expect(row.className).toContain('stale')
    expect(row.getAttribute('title')).toContain('re-pick')
    // The legacy `.stale .feature-name` rule reddens the name; the real-cause
    // class is not added on top.
    expect(nameByName(container, 'Fixed 1').className).not.toContain('feature-name-error')
  })

  it('names a failed referenced part rather than telling the user to re-pick', () => {
    const { container } = renderTree(status({
      mates: { m1: { stale: true, staleRefs: ['ref_b'] } },
      parts: { hBad: { failed: true, error: 'part doc not found: hBad' } },
    }))

    const row = rowByName(container, 'Fixed 1')
    expect(row.getAttribute('title')).toBe('The referenced part failed to load.')
  })

  it('badges the assembly root row for overconstrained and underconstrained', () => {
    const over = renderTree(status({ verdict: 'overconstrained', mates: { m1: { stale: false } } }))
    const overRow = over.container.querySelector('.assembly-verdict')
    expect(overRow).not.toBeNull()
    expect(overRow!.className).toContain('assembly-verdict-error')
    expect(overRow!.getAttribute('data-verdict')).toBe('overconstrained')
    expect(overRow!.textContent).toContain('m1')
    over.unmount()

    const under = renderTree(status({ verdict: 'underconstrained', dof: 3 }))
    const underRow = under.container.querySelector('.assembly-verdict')
    expect(underRow).not.toBeNull()
    expect(underRow!.className).toContain('assembly-verdict-warning')
    expect(underRow!.getAttribute('data-verdict')).toBe('underconstrained')
    // Informational: the row says how much freedom is left.
    expect(underRow!.textContent).toContain('3')
  })

  it('shows no assembly root row for a fully constrained or trivial verdict', () => {
    expect(renderTree(status()).container.querySelector('.assembly-verdict')).toBeNull()
    expect(renderTree(status({ verdict: 'fully_constrained' })).container.querySelector('.assembly-verdict')).toBeNull()
  })
})
