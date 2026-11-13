// The delete command's freeze route: a face projection carries the last solve's
// member rows, and a projection whose face did not resolve deletes without
// materializing and says so.

import { describe, it, expect, beforeEach } from 'vitest'
import { editorState } from '@/stores/editorState'
import { setSketchCallback } from '@/stores/sketchEditorCallbacks'
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { Mutation, PartDoc, SketchData } from '@/types/cad'
import type { SketchMessage } from '@/stores/sketchEditorCallbacks'

const CID = 'proj_face'
const MEMBER = 'proj_face.e6ad6abc'

function doc(): PartDoc {
  return {
    version: 7, kind: 'part',
    features: [{
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [], initial: {},
      constraints: [{ id: CID, kind: 'projection', source: '?face', members: { 'u|e_aaaabbbb': MEMBER } }],
    }],
  } as unknown as PartDoc
}

function solveResults(entities: Array<{ id: string; kind: string; params: number[] }>): Record<string, SketchData> {
  return {
    sk1: {
      solved: {},
      projection_members: { [CID]: { members: { 'u|e_aaaabbbb': MEMBER }, entities, orphans: [] } },
    },
  }
}

describe('deleteSelected freeze route', () => {
  let mutations: Mutation[]
  let messages: SketchMessage[]

  beforeEach(() => {
    mutations = []
    messages = []
    usePartEditorStore.setState({ doc: doc(), solveResults: solveResults([]) })
    editorState.setState({
      activeFeatureId: 'sk1',
      normalSelection: new Set([`constraint:sk1:${CID}`]),
    })
    setSketchCallback('onMutation', (mutation: Mutation) => { mutations.push(mutation) })
    setSketchCallback('showMessage', (message: SketchMessage) => { messages.push(message) })
  })

  it('carries the solved member rows in the delete mutation', () => {
    usePartEditorStore.setState({ solveResults: solveResults([{ id: MEMBER, kind: 'line', params: [0, 0, 10, 0] }]) })
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
})
