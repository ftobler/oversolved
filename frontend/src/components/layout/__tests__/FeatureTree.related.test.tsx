// The part tree's side of the relation hint: the selection marks the rows it
// relates to with `.related`, derived from the same rules the viewport reads.

import { describe, it, expect, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import type { BodyResult, PartFeature } from '@/types/cad'
import { makeAncestryQuery } from '@/kernel/query'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import { renderSidebar, resetStores } from './sidebarTestHarness'

const area = (sk: string) => makeAncestryQuery([`@${sk}/c1`, 'surface:0', `@${sk}`], 'flatface')
const faceQuery = (creator: string) =>
  makeAncestryQuery(['@u|uuid-' + creator, `@${creator}`, `@body_${creator}`], 'flatface')

const sketch = (id: string): PartFeature => ({ id, kind: 'sketch' })
const extrude = (id: string, profiles: string[]): PartFeature =>
  ({ id, kind: 'extrude', extrude: { sketch: profiles, distance: 10 } })

function body(id: string, createdBy: string, faceQueries: string[] = []): BodyResult {
  return {
    id,
    created_by: createdBy,
    modified_by: [],
    mesh: {
      vertices: [],
      faces: [],
      face_queries: faceQueries,
      face_created_by: faceQueries.map(q => {
        const match = /@ex\d+|@cut\d+/.exec(q)
        return match ? match[0].slice(1) : createdBy
      }),
    },
  }
}

function seed(features: PartFeature[], bodies: Record<string, BodyResult> = {}) {
  usePartEditorStore.setState({
    features,
    bodies,
    visibleFeatures: new Set(features.map(f => f.id)),
    doc: null,
    visibleBodies: new Set(),
    partLabels: {},
    solveResults: {},
    isRebuilding: false,
    featureTimings: {},
    pickBodies: {},
  })
  useEditorState.setState({
    rollbackPosition: null,
    editingFeatureId: null,
    normalSelection: new Set(),
    hoveredSelectionId: null,
    hoveredPickKey: null,
    activePickField: null,
    modeStack: [],
  })
}

function select(ids: string[]) {
  act(() => {
    useEditorState.setState({ normalSelection: new Set(ids) })
  })
}

function row(container: HTMLElement, id: string): HTMLElement {
  const span = [...container.querySelectorAll('.feature-name')].find(n => n.textContent === id)
  if (!span) throw new Error(`row not found: ${id}`)
  return span.closest('.feature-item') as HTMLElement
}

beforeEach(() => {
  resetStores()
})

describe('FeatureTree relation hint', () => {
  it('a selected face marks the row of the feature that created it', () => {
    const features = [sketch('sk1'), extrude('ex1', [area('sk1')])]
    seed(features, { body_ex1: body('body_ex1', 'ex1', [faceQuery('ex1')]) })
    const { container } = renderSidebar()

    select([faceQuery('ex1')])

    expect(row(container, 'ex1').className).toContain('related')
    expect(row(container, 'sk1').className).not.toContain('related')
  })

  it('two selected faces of two features mark both rows', () => {
    const features = [extrude('ex1', []), extrude('cut1', [])]
    seed(features, { body_cut1: body('body_cut1', 'cut1', [faceQuery('ex1'), faceQuery('cut1')]) })
    const { container } = renderSidebar()

    select([faceQuery('ex1'), faceQuery('cut1')])

    expect(row(container, 'ex1').className).toContain('related')
    expect(row(container, 'cut1').className).toContain('related')
  })

  it('a hovered face marks nothing', () => {
    const features = [extrude('ex1', [])]
    seed(features, { body_ex1: body('body_ex1', 'ex1', [faceQuery('ex1')]) })
    const { container } = renderSidebar()

    act(() => {
      useEditorState.setState({
        normalSelection: new Set(),
        hoveredSelectionId: faceQuery('ex1'),
        hoveredPickKey: 'body_ex1#face#0',
      })
    })

    expect(row(container, 'ex1').className).not.toContain('related')
  })

  it('a selected extrude row marks the sketch it consumes', () => {
    seed([sketch('sk1'), extrude('ex1', [area('sk1')])])
    const { container } = renderSidebar()

    select(['@ex1'])

    expect(row(container, 'sk1').className).toContain('related')
  })

  it('a selected sketch row marks the features that consume it', () => {
    seed([sketch('sk1'), extrude('ex1', [area('sk1')]), extrude('ex2', [area('sk1')])])
    const { container } = renderSidebar()

    select(['@sk1'])

    expect(row(container, 'ex1').className).toContain('related')
    expect(row(container, 'ex2').className).toContain('related')
  })

  it('a selected row another selection relates to carries both classes', () => {
    seed([sketch('sk1'), extrude('ex1', [area('sk1')])])
    const { container } = renderSidebar()

    select(['@sk1', '@ex1'])

    const sketchRow = row(container, 'sk1')
    expect(sketchRow.className).toContain('selected')
    expect(sketchRow.className).toContain('related')
  })

  it('clearing the selection clears every related row', () => {
    seed([sketch('sk1'), extrude('ex1', [area('sk1')])])
    const { container } = renderSidebar()

    select(['@ex1'])
    expect(row(container, 'sk1').className).toContain('related')

    select([])
    for (const element of container.querySelectorAll('.feature-item')) {
      expect(element.className).not.toContain('related')
    }
  })
})
