// @vitest-environment node
//
// A face projection is one live constraint: the solve derives its boundary
// members, reports them, and leaves the input document untouched. The
// write-back installs only the member id map; member geometry is never an
// `initial` row, so a settled solve installs nothing.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  solveSketch, setSketchSolver, resetSketchSolver, prepareDragContext,
} from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { applyGeometryToFeature } from '@/utils/yamlMutations/solveResult'
import { deriveMemberIds } from '../projectionMembers'
import type { Repository } from '../../query'
import type { Body } from '../../types3d'
import type { FaceBoundaryLookup } from '../faceBoundary'
import type { FaceBoundaryEdge } from '../projectionMembers'
import type { PartDoc, SketchFeature } from '@/types/cad'

type Dict = Record<string, unknown>

const solveBytes = loadSolver()

const FACE_TOKEN = 'u|e_ffffffffffffffffffffffffffffffff'
const EDGE_TOKENS = ['a', 'b', 'c', 'd'].map(letter => `u|e_${letter.repeat(32)}`)

function queryOf(token: string, type = 'straightedge'): string {
  const framed = `@${token}`
  return `?${framed.length.toString(16)};${framed}:${type}`
}

const FACE_QUERY = queryOf(FACE_TOKEN, 'flatface')

function edge(token: string): FaceBoundaryEdge {
  return { token, query: queryOf(token), kind: 'line' }
}

const EDGES = EDGE_TOKENS.map(edge)

/** The boundary of the fake face, as the injected lookup returns it. */
const boundary: FaceBoundaryLookup = (source) => source === FACE_QUERY ? { edges: EDGES } : null

/** A repository that resolves each member query to a distinct horizontal line. */
function memberRepo(): Repository {
  const payload: Dict = {}
  EDGES.forEach((entry, index) => {
    payload[entry.query] = {
      type: 'straightedge', kind: 'line',
      start: [index * 10, 0, 0], end: [index * 10 + 5, 0, 0],
    }
  })
  return {
    query: (source: string) => payload[source] ?? null,
    elements: new Map(),
  } as unknown as Repository
}

function faceFeature(): Dict {
  return {
    id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
    entities: [],
    initial: {},
    constraints: [{ id: 'proj_face', kind: 'projection', source: FACE_QUERY }],
  }
}

describe.skipIf(!solveBytes)('face projection lowering', () => {
  beforeEach(() => {
    resetSketchSolver()
    if (solveBytes) setSketchSolver(solveBytes)
  })

  it('derives every boundary edge as a member and leaves the input feature untouched', () => {
    const feature = faceFeature()
    const before = structuredClone(feature)
    const out = solveSketch(feature, memberRepo(), {} as Record<string, Body>, {}, boundary)
    expect(feature).toEqual(before)
    const report = out.projection_members?.proj_face
    expect(report).toBeDefined()
    expect(report!.entities).toHaveLength(4)
    const ids = deriveMemberIds('proj_face', EDGE_TOKENS)
    expect(Object.values(report!.members)).toEqual(EDGE_TOKENS.map(token => ids[token]))
    for (const row of report!.entities) {
      expect(out.geometry?.[row.id]).toEqual(row.params)
    }
    expect(out.projection_errors).toBeUndefined()
  })

  it('derives no members and reports the projection when the face does not resolve', () => {
    const out = solveSketch(faceFeature(), memberRepo(), {} as Record<string, Body>, {}, () => null)
    expect(out.projection_members?.proj_face.members).toEqual({})
    expect(out.projection_members?.proj_face.entities).toEqual([])
    expect(out.projection_errors).toContain('proj_face')
  })
})

describe('face projection write-back', () => {
  it('installs the member map once and never bakes member geometry into initial', () => {
    const ids = deriveMemberIds('proj_face', EDGE_TOKENS)
    const feature = faceFeature() as unknown as SketchFeature
    const doc = { version: 7, kind: 'part', features: [feature] } as unknown as PartDoc
    const geometry: Record<string, number[]> = {}
    for (const token of EDGE_TOKENS) geometry[ids[token]] = [0, 0, 1, 1]
    const edits = {
      projectionMembers: {
        proj_face: { members: Object.fromEntries(EDGE_TOKENS.map(token => [token, ids[token]])) },
      },
    }
    expect(applyGeometryToFeature(doc, 'sk1', geometry, undefined, edits)).toBe(true)
    expect(feature.initial).toEqual({})
    expect(feature.constraints?.[0].members).toEqual(edits.projectionMembers.proj_face.members)
    // A settled re-solve: same members, same (empty) shape, nothing to install.
    expect(applyGeometryToFeature(doc, 'sk1', geometry, undefined, edits)).toBe(false)
  })

  it('adopts a single-edge resolved kind through the write-back, not the lowering', () => {
    const phi = Math.PI / 3
    const payload = {
      type: 'edge', kind: 'circle', center: [0, 0, 0], radius: 5,
      axis: [0, -Math.sin(phi), Math.cos(phi)], x_axis: [1, 0, 0],
    }
    const repo = { query: () => payload, elements: new Map() } as unknown as Repository
    const feature = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'c0', kind: 'circle' }],
      initial: {},
      constraints: [{ id: 'proj_c0', kind: 'projection', target: '$c0', source: '?edge;circle' }],
    }
    const before = structuredClone(feature)
    const out = solveSketch(feature, repo, {} as Record<string, Body>, {}, () => null)
    expect(feature).toEqual(before)
    expect(out.resolved_kinds).toEqual({ c0: 'ellipse' })
    const doc = { version: 7, kind: 'part', features: [feature] } as unknown as PartDoc
    expect(applyGeometryToFeature(doc, 'sk1', out.geometry ?? {}, undefined, {
      resolvedKinds: out.resolved_kinds,
    })).toBe(true)
    expect((feature.entities[0] as { kind: string }).kind).toBe('ellipse')
    expect(applyGeometryToFeature(doc, 'sk1', out.geometry ?? {}, undefined, {
      resolvedKinds: out.resolved_kinds,
    })).toBe(false)
  })
})

describe.skipIf(!solveBytes)('face projection drag context', () => {
  beforeEach(() => {
    resetSketchSolver()
    if (solveBytes) setSketchSolver(solveBytes)
  })

  const ids = deriveMemberIds('proj_face', EDGE_TOKENS)
  const member = ids[EDGE_TOKENS[0]]

  function dragFeature(): SketchFeature {
    return {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'u1', kind: 'point' }],
      initial: { u1: [5, 5] },
      constraints: [
        { id: 'proj_face', kind: 'projection', source: FACE_QUERY, members: ids },
        {
          id: 'c1', kind: 'coincident',
          a: { entity: 'u1', point: 'xy' },
          b: { entity: member, point: 'start' },
        },
      ],
    } as unknown as SketchFeature
  }

  const derived = [{ id: member, kind: 'line', params: [0, 0, 10, 0] }]

  it('lowers a derived member and keeps the row that names it', () => {
    const ctx = prepareDragContext(dragFeature(), 'u1', 'xy', [0, 0], undefined, derived)
    expect(ctx).not.toBeNull()
    expect(ctx!.layout.some(layout => layout.id === member)).toBe(true)
    // The projection row itself is skipped; the coincident against the member
    // survives instead of dropping as a stale reference.
    const memberIndex = ctx!.layout.findIndex(layout => layout.id === member)
    expect(ctx!.input.constraints.some(constraint =>
      constraint.refs.some(ref => ref.ref.kind === 'entity' && ref.ref.index === memberIndex))).toBe(true)
  })

  it('returns a context when the dragged entity is the member itself', () => {
    const ctx = prepareDragContext(dragFeature(), member, null, [0, 0], undefined, derived)
    expect(ctx).not.toBeNull()
    expect(ctx!.layout.some(layout => layout.id === member)).toBe(true)
  })
})
