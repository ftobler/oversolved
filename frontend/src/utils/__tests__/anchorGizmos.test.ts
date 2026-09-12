// Stage 7.5's hover gate, tested without a viewport: entity hits in, positioned
// triads out. The rule under test is that nothing is drawn unless the cursor
// resolves an entity, and that what IS drawn is exactly the candidate set the
// Stage 7 pick would cycle.

import { describe, it, expect } from 'vitest'
import {
  buildAnchorTable,
  deriveAnchorFrame,
  hoverScopeEntity,
  lookupAnchor,
  resolveAnchorGizmos,
  type AnchorTable,
} from '@/utils/anchorGizmos'
import {
  assemblyBuiltinEntityKey,
  assemblyEntityKey,
  type EntityMateRefs,
} from '@/utils/anchorCandidates'
import { ASSEMBLY_HANDLE, ASSEMBLY_TOP_ID } from '@/utils/assemblyBuiltins'
import type { MateAnchorDescriptor } from '@/types/cad'
import type { Vec3 } from '@/utils/transform3d'

const PART = 'h1'
const VERT = assemblyEntityKey(PART, 0, 'vertex', 0)
const EDGE = assemblyEntityKey(PART, 0, 'edge', 0)
const FACE = assemblyEntityKey(PART, 0, 'face', 0)
const FREEFORM = assemblyEntityKey(PART, 0, 'face', 1)

const ENTITY_MATE_REFS: EntityMateRefs = {
  [VERT]: [{ part: PART, anchor: 'a_v' }],
  [EDGE]: [{ part: PART, anchor: 'a_e' }],
  [FACE]: [{ part: PART, anchor: 'a_f' }],
  [FREEFORM]: [],
}

const TABLE: AnchorTable = buildAnchorTable({
  [PART]: {
    a_v: { kind: 'point', point: [1, 1, 1], axis: [0, 0, 1] },
    a_e: { kind: 'line', point: [1, 1, 0], axis: [1, 0, 0] },
    a_f: { kind: 'plane', point: [1, 0, 0], axis: [0, 1, 0] },
  },
})

/** Resolver order at a corner: vertex wins, then the edge, then the face. */
const CORNER_HITS = [{ entityKey: VERT }, { entityKey: EDGE }, { entityKey: FACE }]

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

describe('deriveAnchorFrame', () => {
  it('keeps the anchor axis as the primary arm', () => {
    const [primary] = deriveAnchorFrame([0, 0, 5])
    expect(primary).toEqual([0, 0, 1])
  })

  it('derives an orthonormal frame', () => {
    const [u, v, w] = deriveAnchorFrame([1, 1, 1])
    for (const arm of [u, v, w]) expect(Math.hypot(...arm)).toBeCloseTo(1, 9)
    expect(dot(u, v)).toBeCloseTo(0, 9)
    expect(dot(v, w)).toBeCloseTo(0, 9)
    expect(dot(u, w)).toBeCloseTo(0, 9)
  })

  it('is deterministic: the same axis always yields the same triad', () => {
    expect(deriveAnchorFrame([0, 1, 0])).toEqual(deriveAnchorFrame([0, 2, 0]))
  })

  it('falls back to the world frame on a degenerate axis rather than emitting NaN', () => {
    expect(deriveAnchorFrame([0, 0, 0])).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 1]])
  })

  it('turns the secondary arms with a supplied part basis instead of the world', () => {
    // A part rolled 90 deg about its own Z (the anchor axis): the in-plane arms
    // must follow the part's X/Y, not stay world-aligned.
    const rolled: Vec3[] = [[0, 1, 0], [-1, 0, 0], [0, 0, 1]]
    const [primary, u, v] = deriveAnchorFrame([0, 0, 1], rolled)
    expect(primary).toEqual([0, 0, 1])
    // The secondary arms lie along the part's rolled X/Y, up to sign.
    for (const arm of [u, v]) expect(Math.abs(arm[2])).toBeCloseTo(0, 9)
    expect(Math.max(Math.abs(dot(u, rolled[0])), Math.abs(dot(u, rolled[1])))).toBeCloseTo(1, 9)
  })
})

describe('buildAnchorTable', () => {
  it('folds the assembly built-ins in under the reserved handle', () => {
    const anchor = lookupAnchor(TABLE, { part: ASSEMBLY_HANDLE, anchor: ASSEMBLY_TOP_ID })
    // x_axis = canonicalPerp of the Top plane's +Y normal (y crossed with x).
    expect(anchor).toEqual({ kind: 'plane', point: [0, 0, 0], axis: [0, 1, 0], x_axis: [0, 0, -1] })
  })

  it('keeps the parts it was given', () => {
    expect(lookupAnchor(TABLE, { part: PART, anchor: 'a_f' })?.point).toEqual([1, 0, 0])
  })
})

describe('hoverScopeEntity', () => {
  it('pins the scope to the winning entity under Ctrl', () => {
    expect(hoverScopeEntity(CORNER_HITS, true)).toBe(VERT)
  })

  it('clears the scope without Ctrl', () => {
    expect(hoverScopeEntity(CORNER_HITS, false)).toBeNull()
  })

  it('clears the scope when Ctrl is held over nothing', () => {
    expect(hoverScopeEntity([], true)).toBeNull()
  })
})

describe('resolveAnchorGizmos', () => {
  it('draws nothing by default: no hover, no anchors', () => {
    expect(resolveAnchorGizmos([], ENTITY_MATE_REFS, TABLE)).toEqual([])
  })

  it('hovering a face resolves exactly that face anchor', () => {
    const gizmos = resolveAnchorGizmos([{ entityKey: FACE }], ENTITY_MATE_REFS, TABLE)
    expect(gizmos).toHaveLength(1)
    expect(gizmos[0].ref).toEqual({ part: PART, anchor: 'a_f' })
    expect(gizmos[0].point).toEqual([1, 0, 0])
    expect(gizmos[0].axes[0]).toEqual([0, 1, 0])
  })

  it('a corner hover resolves the shared-point set the pick cycles, in the same order', () => {
    const gizmos = resolveAnchorGizmos(CORNER_HITS, ENTITY_MATE_REFS, TABLE)
    expect(gizmos.map(g => g.ref.anchor)).toEqual(['a_v', 'a_e', 'a_f'])
  })

  it('Ctrl+hover narrows the set to the hovered entity', () => {
    const scope = hoverScopeEntity(CORNER_HITS, true)
    const gizmos = resolveAnchorGizmos(CORNER_HITS, ENTITY_MATE_REFS, TABLE, scope)
    expect(gizmos.map(g => g.ref.anchor)).toEqual(['a_v'])
  })

  it('an anchor-less entity offers no gizmo', () => {
    expect(resolveAnchorGizmos([{ entityKey: FREEFORM }], ENTITY_MATE_REFS, TABLE)).toEqual([])
  })

  it('marks the aimed candidate and only it', () => {
    const gizmos = resolveAnchorGizmos(
      CORNER_HITS, ENTITY_MATE_REFS, TABLE, null, { part: PART, anchor: 'a_e' },
    )
    expect(gizmos.map(g => g.aimed)).toEqual([false, true, false])
  })

  it('drops a candidate whose anchor the table does not carry, rather than drawing it at the origin', () => {
    const refs: EntityMateRefs = { [FACE]: [{ part: PART, anchor: 'ghost' }] }
    expect(resolveAnchorGizmos([{ entityKey: FACE }], refs, TABLE)).toEqual([])
  })

  it('resolves a built-in plane hover through the reserved handle', () => {
    const key = assemblyBuiltinEntityKey(ASSEMBLY_TOP_ID)
    const refs: EntityMateRefs = { [key]: [{ part: ASSEMBLY_HANDLE, anchor: ASSEMBLY_TOP_ID }] }
    const gizmos = resolveAnchorGizmos([{ entityKey: key }], refs, TABLE)
    expect(gizmos).toHaveLength(1)
    expect(gizmos[0].axes[0]).toEqual([0, 1, 0])
  })

  it('keys gizmos per reference so two instances of one part do not collide', () => {
    const other = assemblyEntityKey('h2', 0, 'face', 0)
    const table = buildAnchorTable({
      [PART]: { a_f: { kind: 'plane', point: [1, 0, 0], axis: [0, 1, 0] } },
      h2: { a_f: { kind: 'plane', point: [9, 0, 0], axis: [0, 1, 0] } },
    })
    const refs: EntityMateRefs = {
      [FACE]: [{ part: PART, anchor: 'a_f' }],
      [other]: [{ part: 'h2', anchor: 'a_f' }],
    }
    const gizmos = resolveAnchorGizmos([{ entityKey: FACE }, { entityKey: other }], refs, table)
    expect(gizmos.map(g => g.key)).toEqual([`${PART}|a_f`, 'h2|a_f'])
    expect(gizmos.map(g => g.point[0])).toEqual([1, 9])
  })
})

describe('descriptor-aware lookup (C5)', () => {
  const moved: MateAnchorDescriptor = {
    geom_hash: '@gdf|moved', kind: 'plane', created_by: 'f1', point: [5, 0, 0],
  }
  const descriptors = { [PART]: { a_f: moved } }

  it('re-finds a current anchor by descriptor when the ref id misses the table', () => {
    const ref = { part: PART, anchor: 'a_stale', anchor_descriptor: moved }
    expect(lookupAnchor(TABLE, ref, descriptors)?.point).toEqual([1, 0, 0])
  })

  it('stays dropped when the ref carries no descriptor', () => {
    expect(lookupAnchor(TABLE, { part: PART, anchor: 'a_stale' }, descriptors)).toBeUndefined()
  })

  it('resolveAnchorGizmos resolves a stale ref through the descriptors table', () => {
    const refs: EntityMateRefs = { [FACE]: [{ part: PART, anchor: 'a_stale', anchor_descriptor: moved }] }
    const gizmos = resolveAnchorGizmos([{ entityKey: FACE }], refs, TABLE, null, null, undefined, descriptors)
    expect(gizmos).toHaveLength(1)
    expect(gizmos[0].point).toEqual([1, 0, 0])
  })
})
