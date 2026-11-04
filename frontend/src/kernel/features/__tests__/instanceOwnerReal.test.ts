// @vitest-environment node
//
// Per-UUID ownership across repeated applications and boolean tools. The
// attribution bug was last-application-wins: only the surviving `brep_diff`
// was stamped, so every earlier copy of a pattern fell back to the body's
// creator. These pin the two paths the fix records owners on: `applyBodyOperation`
// called twice with the same feature id, and `transferBooleanNames` carrying a
// target and a tool owner through one boolean.
//
// Skips when opencascade.js is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { makeBoxAt, makeCylinderWithFaces } from '../../occ/primitives'
import { booleanWithDiff } from '../../occ/booleans'
import { canonicalFaces } from '../../occ/bodyNames'
import { SubShapeMap } from '../../occ/subshapeIdentity'
import { transferBooleanNames } from '../booleanLineage'
import { applyBodyOperation } from '../bodyOps'
import { bareBody } from '../shared/bodyResolution'
import type { Body } from '../../types3d'
import type { OccShape, OccSubShape } from '../../occ/occTypes'

const loadedOcc = await loadOcc()
const oc = loadedOcc!

describe.skipIf(!loadedOcc)('per-UUID owner recording (real OCC)', () => {
  it('keeps both applications of the same feature as their owner', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const body = bareBody('body_base', 'ex1')
      body.shape = table.register(makeBoxAt(oc, scope, [-5, -5, -5], 10, 10, 10), 'ex1')
      const store: Record<string, Body> = { body_base: body }

      const firstOwners = new Set<string>()
      for (let copy = 0; copy < 2; copy++) {
        const tool = makeCylinderWithFaces(oc, scope, [copy * 4 - 2, 0, -8], [0, 0, 1], 1, 16)
        const faceNames = new SubShapeMap<string>()
        const faceOwner: Record<string, string> = {}
        const faces = [tool.faces.lateral, tool.faces.bottom, tool.faces.top]
        faces.forEach((face, i) => {
          const uuid = `copy${copy}-face${i}`
          faceNames.set(face as unknown as OccSubShape, uuid)
          faceOwner[uuid] = 'pt1'
        })
        applyBodyOperation(oc, scope, table, {
          toolShape: tool.shape,
          bodyStore: store,
          operation: 'cut',
          mergeTarget: 'body_base',
          bodyId: 'body_pt1',
          featureId: 'pt1',
          sketchId: '',
          faceNames,
          edgeNames: new SubShapeMap<string>(),
          faceOwner,
          edgeOwner: {},
          opName: 'pattern',
        })
        // Both applications' surviving face UUIDs answer to this feature after
        // each step, not just the last one's.
        for (const [uuid, owner] of Object.entries(body.face_owner ?? {})) {
          if (uuid.startsWith('copy')) expect(owner, uuid).toBe('pt1')
        }
        if (copy === 0) {
          for (const uuid of Object.keys(body.face_owner ?? {})) {
            if (uuid.startsWith('copy0-')) firstOwners.add(uuid)
          }
        }
      }
      expect(firstOwners.size).toBeGreaterThan(0)
      expect([...firstOwners].every((uuid) => body.face_owner?.[uuid] === 'pt1')).toBe(true)
      expect(Object.keys(body.face_owner ?? {}).some((uuid) => uuid.startsWith('copy1-'))).toBe(true)
      // Edges the tool minted are owned too, so a copy's boundary edge does not
      // fall back to the body's creator.
      expect(Object.values(body.edge_owner ?? {})).toContain('pt1')

      const faces = canonicalFaces(oc, scope, table.get<OccShape>(body.shape!))
      const toolFaces = (body.face_uuids ?? []).filter((uuid) => uuid !== null && uuid.startsWith('copy'))
      expect(toolFaces.length).toBeGreaterThan(0)
      expect(faces.length).toBeGreaterThanOrEqual(toolFaces.length)
    } finally {
      scope.dispose()
      table.disposeAll()
    }
  })

  it('carries a target owner and a tool owner, and falls back to the tool body creator', () => {
    const scope = new DisposeScope()
    try {
      const target = makeBoxAt(oc, scope, [0, 0, 0], 10, 10, 10)
      const tool = makeBoxAt(oc, scope, [8, 8, 8], 4, 4, 4)
      const targetFaceNames = new SubShapeMap<string>()
      const toolFaceNames = new SubShapeMap<string>()
      canonicalFaces(oc, scope, target).forEach((face, i) => targetFaceNames.set(face, `target-${i}`))
      canonicalFaces(oc, scope, tool).forEach((face, i) => toolFaceNames.set(face, `tool-${i}`))
      const { shape, faceOrigin } = booleanWithDiff(oc, scope, target, tool, 'cut')
      const names = transferBooleanNames(oc, scope, {
        bodyShape: shape,
        faceOrigin,
        targetFaceNames,
        targetFaceAncestry: {},
        targetFaceOwner: { 'target-0': 'ex1' },
        targetEdgeOwner: {},
        toolFaceNames,
        toolFaceAncestry: {},
        toolFaceOwner: { 'tool-0': 'pat' },
        toolEdgeOwner: {},
        toolCreatedBy: 'fallback',
        toolUuidScope: null,
      })
      const owners = Object.values(names.faceOwner ?? {})
      expect(owners).toContain('ex1')
      expect(owners).toContain('pat')
      expect(owners).toContain('fallback')
      // Edge owners come from the faces an edge lies between.
      expect(Object.values(names.edgeOwner ?? {}).every((owner) => ['ex1', 'pat', 'fallback'].includes(owner))).toBe(true)
    } finally {
      scope.dispose()
    }
  })
})
