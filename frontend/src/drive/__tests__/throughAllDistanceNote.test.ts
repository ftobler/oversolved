// @vitest-environment node
//
// The drive's note channel is how a script author learns that a through_all add
// dropped a distance the geometry never reads. This is the note itself and the
// two surfaces that carry it: the browser bridge and the headless runner the
// MCP server uses.

import { describe, it, expect } from 'vitest'
import type { Mutation, PartDoc } from '@/types/cad'
import { okResult } from '@/session/result'
import { createDriveSurface, type DriveSurfaceDeps } from '../driveSurface'
import type { ScriptStep } from '../scriptRunner'
import { throughAllDistanceNote, THROUGH_ALL_DISTANCE_NOTE } from '../throughAllNote'

type AddExtrudeMutation = Extract<Mutation, { type: 'add_extrude' }>

const addThroughAll: AddExtrudeMutation = {
  type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1',
  distance: 5, termination: 'through_all', operation: 'cut',
}

describe('the through_all distance note', () => {
  it('names the drop on an add that carried a distance', () => {
    expect(throughAllDistanceNote(addThroughAll, null)).toBe(THROUGH_ALL_DISTANCE_NOTE)
    expect(throughAllDistanceNote({ ...addThroughAll, distance: 0 }, null)).toBe(THROUGH_ALL_DISTANCE_NOTE)
  })

  it('stays quiet when there was nothing to drop', () => {
    const { distance: _distance, ...bare } = addThroughAll
    expect(throughAllDistanceNote(bare as Mutation, null)).toBeNull()
    expect(throughAllDistanceNote({ ...addThroughAll, termination: 'blind' }, null)).toBeNull()
    expect(throughAllDistanceNote({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_top' }, null)).toBeNull()
  })

  it('names a setter write on a feature that is already through_all', () => {
    const doc = {
      features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', termination: 'through_all', operation: 'cut' } }],
    } as PartDoc
    const set = { type: 'set_extrude_field', featureId: 'ex1', field: 'distance', value: 5 } as Mutation
    expect(throughAllDistanceNote(set, doc)).toBe(THROUGH_ALL_DISTANCE_NOTE)
    expect(throughAllDistanceNote(set, null)).toBeNull()
    const blind = {
      features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', termination: 'blind', distance: 5 } }],
    } as PartDoc
    expect(throughAllDistanceNote(set, blind)).toBeNull()
  })
})

describe('the browser bridge note', () => {
  const deps = (doc: PartDoc | null): DriveSurfaceDeps => ({
    registry: { enabled: () => true, execute: () => okResult() },
    specs: [],
    inspectSession: () => ({
      docId: 'doc', dirty: false, featureCount: 0, rollback: null, editingFeatureId: null,
      history: { undo: [], redo: [] }, transactions: [],
      solve: { generation: 0, pending: false, running: false, lastError: null },
    }),
    editorState: () => ({
      normalSelection: new Set<string>(), hoveredSelectionId: null, hoveredVertexId: null, activeTool: null,
      activeFeatureId: null, editingFeatureId: null, rollbackPosition: null,
      drawPoints: [], dimensionPicks: [], activePickField: null,
    }),
    idle: () => Promise.resolve(),
    executeMutation: () => okResult(['ex1']),
    doc: () => doc,
  })

  it('attaches the note to a successful add step', async () => {
    const outcome = await createDriveSurface(deps(null)).script([{ mutation: addThroughAll } as ScriptStep])
    expect(outcome.ok).toBe(true)
    expect(outcome.steps[0]).toMatchObject({ note: THROUGH_ALL_DISTANCE_NOTE, noteIds: ['ex1'] })
  })

  it('leaves a clean add without a note', async () => {
    const { distance: _distance, ...bare } = addThroughAll
    const outcome = await createDriveSurface(deps(null)).script([{ mutation: bare } as ScriptStep])
    expect(outcome.steps[0].note).toBeUndefined()
  })
})
