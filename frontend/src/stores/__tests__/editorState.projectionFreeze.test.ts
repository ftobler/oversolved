// The delete command's freeze route: a face projection carries the last solve's
// member rows, and a projection whose face did not resolve deletes without
// materializing and says so.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { editorState } from '@/stores/editorState'
import { setSketchCallback } from '@/stores/sketchEditorCallbacks'
import type { Mutation, PartDoc } from '@/types/cad'
import type { ProjectionMemberReportData } from '@/types/cad'
import type { SketchMessage } from '@/stores/sketchEditorCallbacks'

const CID = 'proj_face'
const MEMBER = 'proj_face.e6ad6abc'
const TOKEN = 'u|e_aaaabbbb'

function doc(): PartDoc {
  return {
    version: 7, kind: 'part',
    features: [{
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [], initial: {},
      constraints: [{ id: CID, kind: 'projection', source: '?face', members: { [TOKEN]: MEMBER } }],
    }],
  } as unknown as PartDoc
}

function reports(entities: Array<{ id: string; kind: string; params: number[] }>): Record<string, ProjectionMemberReportData> {
  return { [CID]: { members: { [TOKEN]: MEMBER }, entities, orphans: [] } }
}

describe('deleteSelected freeze route', () => {
  let mutations: Mutation[]
  let messages: SketchMessage[]
  let members: Record<string, ProjectionMemberReportData> | null

  beforeEach(() => {
    mutations = []
    messages = []
    members = reports([])
    editorState.setState({
      activeFeatureId: 'sk1',
      normalSelection: new Set([`constraint:sk1:${CID}`]),
    })
    setSketchCallback('getDoc', () => doc())
    setSketchCallback('onMutation', (mutation: Mutation) => { mutations.push(mutation) })
    setSketchCallback('showMessage', (message: SketchMessage) => { messages.push(message) })
    setSketchCallback('getProjectionMembers', () => members)
  })

  afterEach(() => {
    setSketchCallback('onMutation', null)
    setSketchCallback('showMessage', null)
    setSketchCallback('getDoc', null)
    setSketchCallback('getProjectionMembers', null)
  })

  it('carries the solved member rows in the delete mutation', () => {
    members = reports([{ id: MEMBER, kind: 'line', params: [0, 0, 10, 0] }])
    editorState.getState().deleteSelected()
    expect(mutations).toHaveLength(1)
    expect(mutations[0]).toMatchObject({
      type: 'delete',
      targets: [`constraint:sk1:${CID}`],
      materialize: [{ id: MEMBER, kind: 'line', params: [0, 0, 10, 0] }],
    })
    expect(messages).toEqual([])
  })

  it('deletes without rows and says so when the face did not resolve', () => {
    editorState.getState().deleteSelected()
    expect(mutations).toHaveLength(1)
    expect(mutations[0].type).toBe('delete')
    expect((mutations[0] as { materialize?: unknown }).materialize).toBeUndefined()
    expect(messages).toHaveLength(1)
    expect(messages[0].title).toBe('Projection not frozen')
  })

  it('stays silent for an all-excluded face: intentionally empty, not unresolved', () => {
    const allExcluded = doc()
    const sketch = allExcluded.features![0]
    if (sketch.kind !== 'sketch') throw new Error('not a sketch')
    sketch.constraints![0].excluded = [TOKEN]
    setSketchCallback('getDoc', () => allExcluded)
    editorState.getState().deleteSelected()
    expect(mutations).toHaveLength(1)
    expect((mutations[0] as { materialize?: unknown }).materialize).toBeUndefined()
    expect(messages).toEqual([])
  })

  it('stays silent when the surviving members are all orphans', () => {
    members = { [CID]: { members: { [TOKEN]: MEMBER }, entities: [], orphans: [TOKEN] } }
    editorState.getState().deleteSelected()
    expect(mutations).toHaveLength(1)
    expect(messages).toEqual([])
  })

  it('notes a mixed selection where only one face projection has rows to freeze', () => {
    const second = 'proj_face2'
    const mixed = doc()
    const sketch = mixed.features![0]
    if (sketch.kind !== 'sketch') throw new Error('not a sketch')
    sketch.constraints!.push({
      id: second, kind: 'projection', source: '?face2',
      members: { 'u|e_bbbb': 'proj_face2.bbbbbbbb' },
    })
    setSketchCallback('getDoc', () => mixed)
    editorState.setState({
      activeFeatureId: 'sk1',
      normalSelection: new Set([`constraint:sk1:${CID}`, `constraint:sk1:${second}`]),
    })
    members = reports([{ id: MEMBER, kind: 'line', params: [0, 0, 10, 0] }])
    editorState.getState().deleteSelected()
    expect(mutations).toHaveLength(1)
    expect((mutations[0] as { materialize?: unknown }).materialize).toEqual([
      { id: MEMBER, kind: 'line', params: [0, 0, 10, 0] },
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0].message).toContain(second)
  })
})
