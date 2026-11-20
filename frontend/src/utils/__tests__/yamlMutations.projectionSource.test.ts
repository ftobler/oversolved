// A projection source that can never resolve must be refused at the applier
// boundary: a stored document still opens and reports it, but a new row may not
// be authored. Each hostile case leaves the document byte-identical, and the
// positive controls prove the rule is about resolvability, not about the source
// spelling.
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { applyAddProjectedEntity, applyDeleteElements } from '@/utils/yamlMutations/sketch'
import { projectionMutationsForId } from '@/tools/projectionMutations'

function doc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      {
        id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [{ id: 'l1', kind: 'line' }, { id: 'p1', kind: 'point' }],
        initial: { l1: [0, 0, 10, 0], p1: [1, 1] },
        constraints: [],
      },
      {
        id: 'sk2', kind: 'sketch', plane: '@builtin_plane_right',
        entities: [{ id: 'q2', kind: 'line' }],
        initial: { q2: [0, 0, 5, 0] },
        constraints: [],
      },
      {
        id: 'sk3', kind: 'sketch', plane: '@builtin_plane_top',
        entities: [{ id: 'q3', kind: 'line' }],
        initial: { q3: [0, 0, 5, 0] },
        constraints: [],
      },
    ],
  }
}

function add(d: PartDoc, featureId: string, source: string, entityId?: string): void {
  applyAddProjectedEntity(d, featureId, 'line', source, entityId)
}

describe('add_projected_entity refuses a source that can never resolve', () => {
  it('refuses projecting a sketch own entity', () => {
    const d = doc()
    const before = structuredClone(d)
    expect(() => add(d, 'sk2', '@sk2/q2')).toThrow(/cannot project its own entity/)
    expect(d).toEqual(before)
  })

  it('refuses an unknown sketch and lists the sketches', () => {
    const d = doc()
    const before = structuredClone(d)
    expect(() => add(d, 'sk2', '@sk9/zz')).toThrow(/names no sketch 'sk9'/)
    expect(() => add(d, 'sk2', '@sk9/zz')).toThrow(/sk1, sk2, sk3/)
    expect(d).toEqual(before)
  })

  it('refuses an unknown entity in a real sketch and lists its entities', () => {
    const d = doc()
    const before = structuredClone(d)
    expect(() => add(d, 'sk2', '@sk1/nope')).toThrow(/names no entity 'nope' in sketch 'sk1'/)
    expect(() => add(d, 'sk2', '@sk1/nope')).toThrow(/l1, p1/)
    expect(d).toEqual(before)
  })

  it('refuses a forward reference', () => {
    const d = doc()
    const before = structuredClone(d)
    expect(() => add(d, 'sk2', '@sk3/q3')).toThrow(
      /forward reference: 'sk3' comes later than 'sk2'/,
    )
    expect(d).toEqual(before)
  })

  it('refuses a $ source that closes a chain onto the target', () => {
    const d = doc()
    const sk2 = d.features![1]
    if (sk2.kind !== 'sketch') throw new Error('not a sketch')
    sk2.entities = [{ id: 'qa', kind: 'point' }, { id: 'qb', kind: 'point' }, { id: 'qc', kind: 'point' }]
    sk2.initial = { qa: [1, 1], qb: [2, 2], qc: [3, 3] }
    sk2.constraints = [
      { id: 'p_qa', kind: 'projection', target: '$qa', source: '$qb' },
      { id: 'p_qb', kind: 'projection', target: '$qb', source: '$qc' },
    ]
    const before = structuredClone(d)
    expect(() => add(d, 'sk2', '$qa', 'qc')).toThrow(/cycle: \$qa follows/)
    expect(d).toEqual(before)
  })

  it('refuses a $ source naming the target itself', () => {
    const d = doc()
    const before = structuredClone(d)
    expect(() => add(d, 'sk2', '$q2', 'q2')).toThrow(/cannot source itself/)
    expect(d).toEqual(before)
  })

  it('treats a cross-sketch cycle as the forward reference it also is', () => {
    const d = doc()
    // sk1 projects sk2's geometry while sk2 projects sk1's: the first row is
    // already stored, so the new sk1 row is a forward reference.
    const sk2 = d.features![1]
    if (sk2.kind !== 'sketch') throw new Error('not a sketch')
    sk2.constraints = [{ id: 'p_q2', kind: 'projection', target: '$q2', source: '@sk1/l1' }]
    const before = structuredClone(d)
    expect(() => add(d, 'sk1', '@sk2/q2')).toThrow(/forward reference: 'sk2' comes later than 'sk1'/)
    expect(d).toEqual(before)
  })

  it('refuses a source sketch entity that has no position yet', () => {
    const d = doc()
    const sk1 = d.features![0]
    if (sk1.kind !== 'sketch') throw new Error('not a sketch')
    sk1.entities!.push({ id: 'never', kind: 'point' })
    delete sk1.initial!.never
    const before = structuredClone(d)
    expect(() => add(d, 'sk2', '@sk1/never')).toThrow(/has no position yet/)
    expect(d).toEqual(before)
  })

  it('refuses before materializing empty sketch containers', () => {
    const d = doc()
    const sk2 = d.features![1]
    if (sk2.kind !== 'sketch') throw new Error('not a sketch')
    delete sk2.constraints
    expect(() => add(d, 'sk2', '@sk2/q2')).toThrow(/cannot project its own entity/)
    expect('constraints' in sk2).toBe(false)
  })
})

describe('add_projected_entity accepts a source that can resolve', () => {  it('accepts an earlier sketch entity', () => {
    const d = doc()
    expect(() => add(d, 'sk2', '@sk1/l1')).not.toThrow()
    expect(() => add(d, 'sk3', '@sk1/l1')).not.toThrow()
    const sk3 = d.features![2]
    if (sk3.kind !== 'sketch') throw new Error('not a sketch')
    expect(sk3.constraints?.some(c => c.kind === 'projection' && c.source === '@sk1/l1')).toBe(true)
  })

  it('accepts a perpendicular plane and a vertex suffix', () => {
    const d = doc()
    expect(() => add(d, 'sk2', '@sk1/l1')).not.toThrow()
    expect(() => add(d, 'sk2', '@sk1/l1/start')).not.toThrow()
    const sk2 = d.features![1]
    if (sk2.kind !== 'sketch') throw new Error('not a sketch')
    const sources = sk2.constraints!.filter(c => c.kind === 'projection').map(c => c.source)
    expect(sources).toContain('@sk1/l1')
    expect(sources).toContain('@sk1/l1/start')
  })

  it('accepts a non-cyclic $ chain', () => {
    const d = doc()
    const sk1 = d.features![0]
    if (sk1.kind !== 'sketch') throw new Error('not a sketch')
    sk1.constraints = [
      { id: 'p_p1', kind: 'projection', target: '$p1', source: '@builtin_origin' },
    ]
    expect(() => add(d, 'sk1', '$p1', 'fromp1')).not.toThrow()
  })

  it('accepts a derived face-projection member id', () => {
    const d = doc()
    const sk1 = d.features![0]
    if (sk1.kind !== 'sketch') throw new Error('not a sketch')
    sk1.constraints = [{
      id: 'proj_face', kind: 'projection', source: '?face',
      members: { 'u|e_aaaabbbb': 'proj_face.aaaabbbb' },
    }]
    expect(() => add(d, 'sk2', '@sk1/proj_face.aaaabbbb')).not.toThrow()
  })
})

// The vertex keys a foreign projection may name are the keys a constraint may
// name on that kind: an arc's ends, an ellipse's axis ends and a spline's
// control points all have a position, so refusing them hid real geometry.
function vertexDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      {
        id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [
          { id: 'l1', kind: 'line' },
          { id: 'A', kind: 'arc' },
          { id: 'E', kind: 'ellipse' },
          { id: 'S', kind: 'spline' },
        ],
        initial: {
          l1: [0, 0, 10, 0],
          A: [-15, 20, 17, 90, 270],
          E: [4.5, 40, 20, 8, 0],
          S: [0, 0, 10, 20, 20, 20, 30, 0],
        },
        constraints: [],
      },
      {
        id: 'sk2', kind: 'sketch', plane: '@builtin_plane_right',
        entities: [], initial: {}, constraints: [],
      },
    ],
  }
}

describe('add_projected_entity accepts every vertex key the kind has', () => {
  it('accepts an arc start/end/center, an ellipse axis end and a spline control point', () => {
    const d = vertexDoc()
    for (const source of [
      '@sk1/A/start', '@sk1/A/end', '@sk1/A/center',
      '@sk1/E/center', '@sk1/E/major1', '@sk1/E/minor2',
      '@sk1/S/start', '@sk1/S/c1',
    ]) {
      expect(() => add(d, 'sk2', source), source).not.toThrow()
    }
    const sk2 = d.features![1]
    if (sk2.kind !== 'sketch') throw new Error('not a sketch')
    const sources = sk2.constraints!.filter(c => c.kind === 'projection').map(c => c.source)
    expect(sources).toEqual([
      '@sk1/A/start', '@sk1/A/end', '@sk1/A/center',
      '@sk1/E/center', '@sk1/E/major1', '@sk1/E/minor2',
      '@sk1/S/start', '@sk1/S/c1',
    ])
  })

  it('still refuses an unknown suffix and lists the keys the kind really has', () => {
    const d = vertexDoc()
    expect(() => add(d, 'sk2', '@sk1/A/nope')).toThrow(
      "names no vertex 'nope' on sk1/A (arc); vertices: center, start, end",
    )
    expect(() => add(d, 'sk2', '@sk1/l1/center')).toThrow(
      "names no vertex 'center' on sk1/l1 (line); vertices: start, end",
    )
  })
})

describe('the project tool click path projects a foreign arc endpoint', () => {
  it('emits one point projection that the applier accepts', () => {
    const d = vertexDoc()
    const noResolvers = {
      entityKind: () => null,
      edgeKind: () => null,
      faceEdges: () => null,
    }
    const mutations = projectionMutationsForId('vertex:sk1:A:end', 'sk2', noResolvers)
    expect(mutations).toEqual([
      { type: 'add_projected_entity', featureId: 'sk2', kind: 'point', source: '@sk1/A/end' },
    ])
    for (const mutation of mutations) {
      if (mutation.type !== 'add_projected_entity') throw new Error('unexpected mutation')
      applyAddProjectedEntity(d, mutation.featureId, mutation.kind ?? 'point', mutation.source as string)
    }
    const sk2 = d.features![1]
    if (sk2.kind !== 'sketch') throw new Error('not a sketch')
    expect(sk2.entities).toHaveLength(1)
    expect(sk2.entities![0].kind).toBe('point')
    expect(sk2.constraints).toEqual([
      { id: `proj_${sk2.entities![0].id}`, kind: 'projection', target: `$${sk2.entities![0].id}`, source: '@sk1/A/end' },
    ])
  })
})

describe('applyDeleteElements names projections that keep their last position', () => {
  it('reports a cross-sketch dependent', () => {
    const d = doc()
    const sk2 = d.features![1]
    if (sk2.kind !== 'sketch') throw new Error('not a sketch')
    sk2.constraints = [{ id: 'p_q2', kind: 'projection', target: '$q2', source: '@sk1/l1' }]
    expect(applyDeleteElements(d, ['entity:sk1:l1'])).toEqual({
      text: 'sk2/q2 projected sk1/l1 and keep their last position; convert them to fixed to unlink them',
      ids: ['sk2'],
    })
  })

  it('reports a same-sketch $ dependent', () => {
    const d = doc()
    const sk1 = d.features![0]
    if (sk1.kind !== 'sketch') throw new Error('not a sketch')
    sk1.constraints = [{ id: 'p_p1', kind: 'projection', target: '$p1', source: '$l1' }]
    expect(applyDeleteElements(d, ['entity:sk1:l1'])).toEqual({
      text: 'sk1/p1 projected sk1/l1 and keep their last position; convert them to fixed to unlink them',
      ids: ['sk1'],
    })
  })

  it('stays quiet for a delete nothing projects from', () => {
    expect(applyDeleteElements(doc(), ['entity:sk1:p1'])).toBeNull()
  })
})
