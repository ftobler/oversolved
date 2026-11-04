// The owner fallback order and the no-overwrite rule, without OCC: a recorded
// owner wins, then the last modifier for a new element, then the body's
// creator. `recordElementOwners` must not rewrite an owner a name transfer
// already wrote, or the final modifier pass would swallow a pattern copy or a
// boolean tool body.

import { describe, it, expect } from 'vitest'
import { indexModifierDiffs, namedElementCreator } from '../modifierAttribution'
import { bareBody } from '../../features/shared/bodyResolution'
import type { OccHandle } from '../handleTable'
import type { OccModule } from '../occTypes'
import type { Body } from '../../types3d'

describe('modifier attribution owner fallback order', () => {
  it('prefers a recorded owner, then the last modifier for a new element, then the creator', () => {
    expect(namedElementCreator('u1', { u1: 'recorded' }, true, 'creator', ['m1', 'm2'])).toBe('recorded')
    expect(namedElementCreator('u2', { u1: 'recorded' }, true, 'creator', ['m1', 'm2'])).toBe('m2')
    expect(namedElementCreator('u2', { u1: 'recorded' }, false, 'creator', ['m1', 'm2'])).toBe('creator')
    expect(namedElementCreator(null, undefined, false, 'creator', [])).toBe('creator')
  })

  it('does not overwrite an owner the name transfer already recorded', () => {
    const handle = 1 as OccHandle
    const body: Body = {
      ...bareBody('body_ex1', 'ex1'),
      shape: handle,
      modified_by: ['m1', 'm2'],
      face_uuids: ['u1', 'u2', 'u3'],
      edge_uuids: ['e1', 'e2'],
      face_owner: { u1: 'transfer-owner' },
      edge_owner: { e1: 'transfer-owner' },
      // The last modifier names indices 1 only; index 0 carries the transfer's
      // owner and must keep it.
      brep_new: { shape: handle, faces: [0, 1], edges: [0, 1], vertices: [] },
      brep_diff: null,
    }
    indexModifierDiffs(
      null as unknown as OccModule,
      null as unknown as never,
      { body_ex1: body },
    )
    expect(body.face_owner).toEqual({ u1: 'transfer-owner', u2: 'm2' })
    expect(body.edge_owner).toEqual({ e1: 'transfer-owner', e2: 'm2' })
  })

  it('prunes owners whose UUID the current shape no longer carries', () => {
    const handle = 2 as OccHandle
    const body: Body = {
      ...bareBody('body_ex2', 'ex1'),
      shape: handle,
      modified_by: ['m1'],
      face_uuids: ['u1'],
      edge_uuids: [],
      face_owner: { u1: 'ex1', dead: 'gone' },
      edge_owner: { dead: 'gone' },
      brep_new: { shape: handle, faces: [], edges: [], vertices: [] },
      brep_diff: null,
    }
    indexModifierDiffs(null as unknown as OccModule, null as unknown as never, { body_ex2: body })
    expect(body.face_owner).toEqual({ u1: 'ex1' })
    expect(body.edge_owner).toEqual({})
  })
})
