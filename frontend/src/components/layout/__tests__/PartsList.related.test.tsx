// The Parts card's side of the relation hint: selecting a face marks the part
// row it belongs to, from the same rules the Features card reads.

import { describe, it, expect, beforeEach } from 'vitest'
import { act, fireEvent } from '@testing-library/react'
import type { PartResult, PartFeature } from '@/types/cad'
import { makeAncestryQuery } from '@/kernel/query'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import { makeCallbacks, renderSidebar, resetStores } from './sidebarTestHarness'

const faceQuery = (creator: string) =>
  makeAncestryQuery(['@u|uuid-' + creator, `@${creator}`, `@body_${creator}`], 'flatface')

const extrude = (id: string): PartFeature =>
  ({ id, kind: 'extrude', extrude: { sketch: '@sk1', distance: 10 } })

function part(id: string, createdBy: string, faceQueries: string[] = []): PartResult {
  return {
    id,
    created_by: createdBy,
    modified_by: [],
    mesh: {
      vertices: [],
      faces: [],
      face_queries: faceQueries,
      face_created_by: faceQueries.map(() => createdBy),
    },
  }
}

const labels = { body_ex1: 'Ex One', body_ex2: 'Ex Two' }

function seed(features: PartFeature[], parts: Record<string, PartResult>) {
  usePartEditorStore.setState({
    features,
    parts,
    visibleFeatures: new Set(features.map(f => f.id)),
    partLabels: labels,
    visibleParts: new Set(Object.keys(parts)),
    doc: null,
    solveResults: {},
    isRebuilding: false,
    featureTimings: {},
    pickParts: {},
  })
}

function select(ids: string[]) {
  act(() => {
    useEditorState.setState({ normalSelection: new Set(ids) })
  })
}

function partRow(container: HTMLElement, label: string): HTMLElement {
  const span = [...container.querySelectorAll('.part-name')].find(n => n.textContent === label)
  if (!span) throw new Error(`part row not found: ${label}`)
  return span.closest('.part-item') as HTMLElement
}

function featureRow(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector(`[data-oversolved-handle="tree:feature:${id}"]`)
  if (!el) throw new Error(`feature row not found: ${id}`)
  return el as HTMLElement
}

function seedTwoParts() {
  seed([extrude('ex1'), extrude('ex2')], {
    body_ex1: part('body_ex1', 'ex1', [faceQuery('ex1')]),
    body_ex2: part('body_ex2', 'ex2', [faceQuery('ex2')]),
  })
}

beforeEach(() => {
  resetStores()
})

describe('PartsList relation hint', () => {
  it('a selected face marks the part it belongs to and its feature row', () => {
    seedTwoParts()
    const { container } = renderSidebar()

    select([faceQuery('ex2')])

    expect(partRow(container, 'Ex Two').className).toContain('related')
    expect(partRow(container, 'Ex One').className).not.toContain('related')
    expect(featureRow(container, 'ex2').className).toContain('related')
  })

  it('an empty selection marks no part row', () => {
    seedTwoParts()
    const { container } = renderSidebar()

    expect(container.querySelectorAll('.part-item.related').length).toBe(0)
  })

  it('a selected part row that is also related keeps both classes', () => {
    seedTwoParts()
    const { container } = renderSidebar()

    select([faceQuery('ex1'), '@body_ex1'])

    const row = partRow(container, 'Ex One')
    expect(row.className).toContain('selected')
    expect(row.className).toContain('related')
  })

  it('the hint never adds the part id to the selection', () => {
    seedTwoParts()
    const callbacks = makeCallbacks()
    const { container } = renderSidebar(callbacks)

    select([faceQuery('ex1')])
    // A related row still toggles through the one pick route; being related is
    // not a selection of the part.
    fireEvent.click(partRow(container, 'Ex One'))

    expect(callbacks.onToggleSelect).toHaveBeenCalledWith('@body_ex1')
    expect(useEditorState.getState().normalSelection).toEqual(new Set([faceQuery('ex1')]))
  })
})
