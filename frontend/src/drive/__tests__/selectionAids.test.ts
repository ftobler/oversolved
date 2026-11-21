// @vitest-environment node
//
// The pure half of selector picks on the covered pick fields (drive/selectionAids
// holds the table): resolveSelectionAids and usesSelectionAid against synthetic
// solve results. The real half proves the one-step drive path, the chained run's
// first-step solve, and the refusals (selectionAidsReal.test.ts).

import { describe, it, expect } from 'vitest'
import type { PartResult, FaceData, EdgeData, PartDoc } from '@/types/cad'
import { makeAncestryQuery } from '@/kernel/query'
import { resolveSelectionAids, usesSelectionAid } from '../selectionAids'
import { mutationHandlers } from '@/hooks/mutationDispatch'
import { seedBuiltins } from '../headlessOps'

type V3 = [number, number, number]
function q(partId: string, tokens: string[], type: string): string {
  return makeAncestryQuery([`@${partId}`, ...tokens], type)
}
function face(centroid: V3, normal: V3): FaceData {
  return { centroid, normal, surface_type: 'flatface' }
}
function lineEdge(start: V3, end: V3): EdgeData {
  return { kind: 'line', start, end }
}
// Two Z-parallel edges and one X-parallel edge on body_a, so an edge selector
// can expand to several picks and a string entry can sit beside it.
function partsWithEdges(): Record<string, PartResult> {
  const parts = twoParts()
  parts.body_a.edges = [
    lineEdge([0, 0, 0], [0, 0, 10]),
    lineEdge([10, 0, 0], [10, 0, 10]),
    lineEdge([0, 0, 0], [10, 0, 0]),
  ]
  parts.body_a.edge_queries = [
    q('body_a', ['@u|e_0'], 'straightedge'),
    q('body_a', ['@u|e_1'], 'straightedge'),
    q('body_a', ['@u|e_2'], 'straightedge'),
  ]
  return parts
}
const zEdgeSelector = { selector: { kind: 'edge', where: { parallel: [0, 0, 1] } } }
// The middle of body_a's two Z-parallel edges sits at x=10, so this narrows the
// pair to one: a projection source is exactly one element.
const oneEdgeSelector = {
  selector: { kind: 'edge', where: { and: [{ parallel: [0, 0, 1] }, { center: { axis: 'x', at: 10 } }] } },
}
// One circle edge and one corner vertex on body_a, for the projection source:
// an edge selector's own kind picks the curve kind, a vertex's the point kind.
function partsWithSourceShapes(): Record<string, PartResult> {
  const parts = twoParts()
  parts.body_a.edges = [{
    kind: 'circle', center: [5, 5, 0], radius: 4, axis: [0, 0, 1],
    x_axis: [1, 0, 0], angle_start: 0, angle_end: 360,
  }]
  parts.body_a.edge_queries = [q('body_a', ['@u|e_c'], 'circleedge')]
  parts.body_a.vertices = [[0, 0, 10]]
  parts.body_a.vertex_queries = [q('body_a', ['@u|v_0'], 'vertex')]
  return parts
}
const circleEdgeSelector = { selector: { kind: 'edge', where: { type: 'circle' } } }
const cornerVertexSelector = { selector: { kind: 'vertex' } }
function twoParts(): Record<string, PartResult> {
  const part = (id: string, faces: FaceData[]): PartResult => ({
    id,
    created_by: 'ex1',
    modified_by: [],
    edges: [] as EdgeData[],
    edge_queries: [],
    mesh: {
      vertices: [], faces: [], face_data: faces,
      face_queries: faces.map((f, i) => q(id, [`@u|f_${i}`], f.surface_type!)),
      face_edge_queries: faces.map(() => []),
    },
  })
  return {
    body_a: part('body_a', [face([5, 5, 10], [0, 0, 1]), face([5, 5, 0], [0, 0, -1])]),
    body_b: part('body_b', [face([15, 5, 10], [0, 0, 1])]),
  }
}
const planeSelector = { selector: { kind: 'face', where: { parallel: [0, 0, 1] } } }
describe('resolveSelectionAids', () => {
  it('leaves a step without a selector untouched', () => {
    const step = { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_top' }
    const resolved = resolveSelectionAids(step, twoParts())
    expect(resolved.ok).toBe(true)
    expect(resolved.ok && resolved.mutation).toBe(step)
  })

  it('rewrites a sketch plane selector into the one face query it matched', () => {
    const parts = { body_b: twoParts().body_b }
    const resolved = resolveSelectionAids({ type: 'add_sketch', featureId: 'sk1', plane: planeSelector }, parts)
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.mutation).toEqual({
      type: 'add_sketch', featureId: 'sk1', plane: q('body_b', ['@u|f_0'], 'flatface'),
    })
  })

  it('refuses a plane selector that matches several faces', () => {
    const resolved = resolveSelectionAids({ type: 'add_sketch', featureId: 'sk1', plane: planeSelector }, twoParts())
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.code).toBe('unresolved-ref')
    expect(resolved.message).toContain('exactly one face')
  })

  it('refuses a selector that matched an edge where faces are required', () => {
    const parts = twoParts()
    parts.body_a.edges = [{ kind: 'line', start: [0, 0, 0], end: [0, 0, 10] }]
    parts.body_a.edge_queries = [q('body_a', ['@u|e_0'], 'straightedge')]
    const resolved = resolveSelectionAids(
      { type: 'add_shell', featureId: 'sh1', faces: [{ selector: { kind: 'edge' } }] },
      parts,
    )
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.code).toBe('unresolved-ref')
    expect(resolved.message).toContain('non-face')
  })

  it('refuses a selector that matches nothing as unresolved, not invalid', () => {
    const resolved = resolveSelectionAids(
      { type: 'add_sketch', featureId: 'sk1', plane: { selector: { kind: 'face', where: { parallel: [1, 1, 1] } } } },
      twoParts(),
    )
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.code).toBe('unresolved-ref')
    expect(resolved.message).toMatch(/no face|matches nothing/i)
  })

  it('refuses a selector naming a body that is not in the solve', () => {
    const resolved = resolveSelectionAids(
      { type: 'add_sketch', featureId: 'sk1', plane: { selector: { kind: 'face', from: 'body_gone' } } },
      twoParts(),
    )
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.code).toBe('unresolved-ref')
    expect(resolved.message).toContain('body_gone')
  })

  it('refuses a selector with no solved parts, naming the alternative', () => {
    const resolved = resolveSelectionAids({ type: 'add_sketch', featureId: 'sk1', plane: planeSelector }, null)
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.code).toBe('unresolved-ref')
    expect(resolved.message).toContain('no solved parts')
    expect(resolved.message).toContain('query string')
  })

  it('refuses a malformed selector as invalid-ref, not a failed match', () => {
    const resolved = resolveSelectionAids(
      { type: 'add_sketch', featureId: 'sk1', plane: { selector: { kind: 'edge', where: { bogus: 1 } } } },
      twoParts(),
    )
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.code).toBe('invalid-ref')
  })

  it('names the selector shape when a predicate sits where the selector belongs', () => {
    const resolved = resolveSelectionAids(
      { type: 'add_shell', featureId: 'sh1', faces: [{ selector: { type: 'flatface' } }] },
      twoParts(),
    )
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.code).toBe('invalid-ref')
    expect(resolved.message).toContain('add_shell faces[0]: selector has unknown key "type"')
    expect(resolved.message).toContain('a selector is {from?, kind, where}')
    expect(resolved.message).toContain('"type" is a predicate')
    expect(resolved.message).toContain('{selector: {kind: "face", where: {type: "flatface"}}}')
  })

  it('keeps the plain unknown-key message for a key that is not a predicate', () => {
    const resolved = resolveSelectionAids(
      { type: 'add_shell', featureId: 'sh1', faces: [{ selector: { kind: 'face', bogus: 1 } }] },
      twoParts(),
    )
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.code).toBe('invalid-ref')
    expect(resolved.message).toBe('add_shell faces[0]: selector has unknown key "bogus"')
  })

  it('keeps the plain message for a nested key that happens to be a predicate', () => {
    // The key is predicate-shaped but sits inside `within`, not at the selector
    // root, so the shape hint would send the author to the wrong level.
    const resolved = resolveSelectionAids(
      {
        type: 'add_shell', featureId: 'sh1',
        faces: [{
          selector: { kind: 'face', where: { within: { axis: 'z', min: 0, type: 'x' } } },
        }],
      },
      twoParts(),
    )
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.code).toBe('invalid-ref')
    expect(resolved.message).toContain('selector.where.within has unknown key "type"')
    expect(resolved.message).not.toContain('a selector is {from?, kind, where}')
  })

  it('names the selector shape for a predicate key in a fillet or chamfer edge list', () => {
    for (const type of ['add_fillet', 'add_chamfer'] as const) {
      const resolved = resolveSelectionAids(
        { type, featureId: 'f1', edges: [{ selector: { seam: false } }] },
        partsWithEdges(),
      )
      expect(resolved.ok, type).toBe(false)
      if (resolved.ok) continue
      expect(resolved.code).toBe('invalid-ref')
      expect(resolved.message).toContain(`${type} edges[0]: selector has unknown key "seam"`)
      expect(resolved.message).toContain('"seam" is a predicate')
      expect(resolved.message).toContain('kind: "edge"')
    }
  })

  it('expands every shell face selector and keeps the string entries', () => {
    const parts = twoParts()
    const existing = q('body_a', ['@u|f_1'], 'flatface')
    const resolved = resolveSelectionAids(
      {
        type: 'add_shell', featureId: 'sh1',
        faces: [existing, { selector: { kind: 'face', where: { parallel: [0, 0, 1] } } }],
      },
      parts,
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect((resolved.mutation as { faces: string[] }).faces).toEqual([
      existing,
      q('body_a', ['@u|f_0'], 'flatface'),
      q('body_b', ['@u|f_0'], 'flatface'),
    ])
  })

  it('expands an edge selector in a fillet list, keeping string entries in place', () => {
    const parts = partsWithEdges()
    const existing = q('body_a', ['@u|e_2'], 'straightedge')
    const resolved = resolveSelectionAids(
      {
        type: 'add_fillet', featureId: 'fi1',
        edges: [existing, zEdgeSelector, '?body_a:edge:2'],
        radius: 1,
      },
      parts,
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect((resolved.mutation as { edges: string[] }).edges).toEqual([
      existing,
      q('body_a', ['@u|e_0'], 'straightedge'),
      q('body_a', ['@u|e_1'], 'straightedge'),
      '?body_a:edge:2',
    ])
  })

  it('dedupes an edge a second selector names again', () => {
    const resolved = resolveSelectionAids(
      { type: 'add_fillet', featureId: 'fi1', edges: [zEdgeSelector, zEdgeSelector], radius: 1 },
      partsWithEdges(),
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect((resolved.mutation as { edges: string[] }).edges).toEqual([
      q('body_a', ['@u|e_0'], 'straightedge'),
      q('body_a', ['@u|e_1'], 'straightedge'),
    ])
  })

  it('refuses a face selector in a fillet or chamfer edge list, naming the kinds', () => {
    for (const type of ['add_fillet', 'add_chamfer']) {
      const resolved = resolveSelectionAids(
        { type, featureId: 'f1', edges: [{ selector: { kind: 'face', where: { parallel: [0, 0, 1] } } }] },
        partsWithEdges(),
      )
      expect(resolved.ok, type).toBe(false)
      if (resolved.ok) continue
      expect(resolved.code).toBe('unresolved-ref')
      expect(resolved.message).toContain('only edges are picks here')
      expect(resolved.message).toContain('face')
    }
  })

  it('refuses an edge selector with no solved parts, naming the alternative', () => {
    const resolved = resolveSelectionAids(
      { type: 'add_fillet', featureId: 'fi1', edges: [zEdgeSelector], radius: 1 },
      null,
    )
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.code).toBe('unresolved-ref')
    expect(resolved.message).toContain('no solved parts')
    expect(resolved.message).toContain('query string')
  })

  it('keeps the select engine nearest-miss text for an empty edge match', () => {
    const resolved = resolveSelectionAids(
      { type: 'add_chamfer', featureId: 'ch1', edges: [{ selector: { kind: 'edge', where: { parallel: [1, 1, 1] } } }] },
      partsWithEdges(),
    )
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.code).toBe('unresolved-ref')
    expect(resolved.message).toContain('matched no edges')
    expect(resolved.message).toContain('parallel')
  })

  it('rewrites a projection source selector into the one edge query it matched', () => {
    const resolved = resolveSelectionAids(
      { type: 'add_projected_entity', featureId: 'sk2', kind: 'line', source: oneEdgeSelector },
      partsWithEdges(),
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.mutation).toEqual({
      type: 'add_projected_entity', featureId: 'sk2', kind: 'line',
      source: q('body_a', ['@u|e_1'], 'straightedge'),
    })
  })

  it('refuses a projection source matching two edges with its own one-element rule', () => {
    const resolved = resolveSelectionAids(
      { type: 'add_projected_entity', featureId: 'sk2', kind: 'line', source: zEdgeSelector },
      partsWithEdges(),
    )
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.code).toBe('unresolved-ref')
    expect(resolved.message).toContain('a projection source is exactly one edge, vertex or face')
    expect(resolved.message).toContain('matched 2 items')
  })

  it('keeps the select engine nearest-miss text for a source that matches nothing', () => {
    const resolved = resolveSelectionAids(
      {
        type: 'add_projected_entity', featureId: 'sk2', kind: 'line',
        source: { selector: { kind: 'edge', where: { parallel: [1, 1, 1] } } },
      },
      partsWithEdges(),
    )
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.code).toBe('unresolved-ref')
    expect(resolved.message).toContain('add_projected_entity source')
    expect(resolved.message).toContain('matched no edges')
  })

  it('names the selector shape for a malformed projection source', () => {
    const resolved = resolveSelectionAids(
      { type: 'add_projected_entity', featureId: 'sk2', kind: 'line', source: { selector: { type: 'line' } } },
      partsWithEdges(),
    )
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.code).toBe('invalid-ref')
    expect(resolved.message).toContain('add_projected_entity source: selector has unknown key "type"')
    expect(resolved.message).toContain('{selector: {kind: "edge", where: {type: "line"}}}')
  })

  it('takes the example kind from a malformed face selector itself', () => {
    // A projection source accepts any element kind, so the hint cannot assume
    // edge: this selector says face, and a face's type predicate is a surface.
    const resolved = resolveSelectionAids(
      {
        type: 'add_projected_entity', featureId: 'sk2', kind: 'point',
        source: { selector: { kind: 'face', type: 'flatface' } },
      },
      twoParts(),
    )
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.code).toBe('invalid-ref')
    expect(resolved.message).toContain('{selector: {kind: "face", where: {type: "flatface"}}}')
  })

  it('leaves a present non-string kind for the value rules to refuse', () => {
    const resolved = resolveSelectionAids(
      { type: 'add_projected_entity', featureId: 'sk2', kind: 5, source: oneEdgeSelector },
      partsWithEdges(),
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const mutation = resolved.mutation as { kind: unknown; source: string }
    expect(mutation.kind).toBe(5)
    expect(mutation.source).toBe(q('body_a', ['@u|e_1'], 'straightedge'))
  })

  it('passes a string projection source through untouched', () => {
    // `select` walks bodies only, so the origin and another sketch's geometry
    // are already the stored form and have no selector spelling.
    for (const source of ['@builtin_origin', '@sk2/l1', '?body_a:edge:1']) {
      const step = { type: 'add_projected_entity', featureId: 'sk2', kind: 'point', source }
      const resolved = resolveSelectionAids(step, partsWithEdges())
      expect(resolved.ok, source).toBe(true)
      expect(resolved.ok && resolved.mutation, source).toBe(step)
    }
  })

  it('infers the projection entity kind from the element the selector matched', () => {
    // The same mapping the UI's projection path uses: an edge keeps its curve
    // kind, a vertex or face projects as its own point.
    const cases: Array<[Record<string, PartResult>, Record<string, unknown>, string, string]> = [
      [partsWithEdges(), oneEdgeSelector, 'line', q('body_a', ['@u|e_1'], 'straightedge')],
      [partsWithSourceShapes(), circleEdgeSelector, 'circle', q('body_a', ['@u|e_c'], 'circleedge')],
      [partsWithSourceShapes(), cornerVertexSelector, 'point', q('body_a', ['@u|v_0'], 'vertex')],
      [twoParts(), { selector: { kind: 'face', from: 'body_b' } }, 'point', q('body_b', ['@u|f_0'], 'flatface')],
    ]
    for (const [bodies, source, kind, query] of cases) {
      const resolved = resolveSelectionAids(
        { type: 'add_projected_entity', featureId: 'sk2', source },
        bodies,
      )
      expect(resolved.ok, JSON.stringify(source)).toBe(true)
      if (!resolved.ok) continue
      expect(resolved.mutation, JSON.stringify(source)).toEqual({
        type: 'add_projected_entity', featureId: 'sk2', kind, source: query,
      })
    }
  })

  it('keeps a declared kind instead of inferring one', () => {
    const resolved = resolveSelectionAids(
      { type: 'add_projected_entity', featureId: 'sk2', kind: 'point', source: circleEdgeSelector },
      partsWithSourceShapes(),
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect((resolved.mutation as { kind: string }).kind).toBe('point')
  })

  it('reports whether a step needs a solve for its selector', () => {
    expect(usesSelectionAid({ type: 'add_sketch', plane: planeSelector })).toBe(true)
    expect(usesSelectionAid({ type: 'add_sketch', plane: '@builtin_plane_top' })).toBe(false)
    expect(usesSelectionAid({ type: 'add_shell', faces: [planeSelector] })).toBe(true)
    expect(usesSelectionAid({ type: 'add_shell', faces: ['?q'] })).toBe(false)
    expect(usesSelectionAid({ type: 'add_fillet', edges: [zEdgeSelector] })).toBe(true)
    expect(usesSelectionAid({ type: 'add_fillet', edges: ['?q'] })).toBe(false)
    expect(usesSelectionAid({ type: 'add_chamfer', edges: [zEdgeSelector] })).toBe(true)
    expect(usesSelectionAid({ type: 'add_projected_entity', source: oneEdgeSelector })).toBe(true)
    expect(usesSelectionAid({ type: 'add_projected_entity', source: '@builtin_origin' })).toBe(false)
    expect(usesSelectionAid({ type: 'add_mirror', plane: planeSelector })).toBe(true)
    expect(usesSelectionAid({ type: 'add_mirror', plane: '@builtin_plane_top' })).toBe(false)
  })

  it('expands an instance pattern target selector to every match, any kind', () => {
    const resolved = resolveSelectionAids(
      { type: 'add_instance_pattern', featureId: 'ip1', targets: [planeSelector] },
      twoParts(),
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect((resolved.mutation as { targets: string[] }).targets).toEqual([
      q('body_a', ['@u|f_0'], 'flatface'),
      q('body_a', ['@u|f_1'], 'flatface'),
      q('body_b', ['@u|f_0'], 'flatface'),
    ])
  })

  it('resolves a vertex and an edge-or-face pick, and refuses a wrong element kind', () => {
    const vertex = resolveSelectionAids(
      { type: 'add_transform', featureId: 'tr1', translation_from: cornerVertexSelector },
      partsWithSourceShapes(),
    )
    expect(vertex.ok).toBe(true)
    expect(vertex.ok && (vertex.mutation as { translation_from: string }).translation_from)
      .toBe(q('body_a', ['@u|v_0'], 'vertex'))

    const edge = resolveSelectionAids(
      { type: 'add_linear_pattern', featureId: 'pt1', direction_query: oneEdgeSelector },
      partsWithEdges(),
    )
    expect(edge.ok).toBe(true)
    if (!edge.ok) return
    expect((edge.mutation as { direction_query: string }).direction_query)
      .toBe(q('body_a', ['@u|e_1'], 'straightedge'))

    const wrong = resolveSelectionAids(
      { type: 'add_revolve', featureId: 'rv1', axis: cornerVertexSelector },
      partsWithSourceShapes(),
    )
    expect(wrong.ok).toBe(false)
    if (wrong.ok) return
    expect(wrong.message).toContain('add_revolve axis')
    expect(wrong.message).toContain('non-edge')
  })

  it('resolves a setter value only for the pick field it names', () => {
    const parts = { body_b: twoParts().body_b }
    const target = resolveSelectionAids(
      { type: 'set_wrap_field', featureId: 'wr1', field: 'target', value: planeSelector },
      parts,
    )
    expect(target.ok).toBe(true)
    expect(target.ok && (target.mutation as { value: string }).value)
      .toBe(q('body_b', ['@u|f_0'], 'flatface'))

    // A field the table does not cover keeps its value as authored.
    const height = resolveSelectionAids(
      { type: 'set_wrap_field', featureId: 'wr1', field: 'height', value: 5 },
      parts,
    )
    expect(height.ok).toBe(true)
    expect(height.ok && height.mutation).toEqual({ type: 'set_wrap_field', featureId: 'wr1', field: 'height', value: 5 })

    const face = resolveSelectionAids(
      { type: 'set_plane_definition_field', featureId: 'pl1', field: 'face', value: planeSelector },
      parts,
    )
    expect(face.ok).toBe(true)
    expect(face.ok && (face.mutation as { value: string }).value)
      .toBe(q('body_b', ['@u|f_0'], 'flatface'))

    const faces = resolveSelectionAids(
      { type: 'set_move_face_field', featureId: 'mf1', field: 'faces', value: [planeSelector] },
      parts,
    )
    expect(faces.ok).toBe(true)
    expect(faces.ok && (faces.mutation as { value: string[] }).value)
      .toEqual([q('body_b', ['@u|f_0'], 'flatface')])
  })

  it('refuses an unresolved selector at the applier instead of dropping it', () => {
    // DocSession.execute and journal replay bypass the value rules; a selector
    // that got that far must be loud, not silently unbind the sketch.
    const doc = seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc)
    expect(() => mutationHandlers.add_sketch(doc, {
      type: 'add_sketch', featureId: 'sk1', plane: { selector: { kind: 'face' } },
    })).toThrow(/selector/)
    expect(doc.features?.some(feature => feature.id === 'sk1')).toBe(false)
    // A projection pair is filled by the drive: a selector source and an omitted
    // kind are both refused here rather than stored as an unresolved constraint.
    expect(() => mutationHandlers.add_projected_entity(doc, {
      type: 'add_projected_entity', featureId: 'sk1', kind: 'line', source: { selector: { kind: 'edge' } },
    })).toThrow(/selector/)
    expect(() => mutationHandlers.add_projected_entity(doc, {
      type: 'add_projected_entity', featureId: 'sk1', source: '?edge',
    })).toThrow(/kind/)
  })
})
