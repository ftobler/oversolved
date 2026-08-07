import { describe, it, expect } from 'vitest'
import {
  FACE_UUID_PREFIX,
  EDGE_UUID_PREFIX,
  VERTEX_UUID_PREFIX,
  SPLIT_EPS,
  sideFacePath,
  capFacePath,
  filletFacePath,
  splitFacePath,
  importedFacePath,
  importedInstanceFacePath,
  mintFaceUuid,
  deriveEdgeUuid,
  deriveVertexUuid,
  deriveCornerFaceUuid,
  orderSplitChildren,
  type SplitChild,
} from './constructionName'

// A construction path must be built from symbolic tokens only. This is the
// load-bearing property: no float ever enters a persisted identity.
const FLOAT_RE = /\d+\.\d+/

describe('construction path grammar', () => {
  it('builds symbolic-only paths (no float ever)', () => {
    const paths = [
      sideFacePath('extrude1', 'line3'),
      capFacePath('extrude1', 'start'),
      capFacePath('extrude1', 'end'),
      filletFacePath('fillet2', 'e_abc123'),
      splitFacePath('u_deadbeef', 7),
      importedFacePath('import1', 17),
      importedInstanceFacePath('import1', 17, 1),
    ]
    for (const p of paths) expect(p).not.toMatch(FLOAT_RE)
  })

  it('round-trips the expected path shapes', () => {
    expect(sideFacePath('extrude1', 'line3')).toBe('extrude1|side|line3')
    expect(capFacePath('extrude1', 'end')).toBe('extrude1|cap|end')
    expect(filletFacePath('fillet2', 'e_abc')).toBe('fillet2|fillet|e_abc')
    expect(splitFacePath('u_p', 2)).toBe('u_p|split|2')
    expect(importedFacePath('import1', 17)).toBe('import1|step|17')
    expect(importedInstanceFacePath('import1', 17, 0)).toBe('import1|step|17')
    expect(importedInstanceFacePath('import1', 17, 1)).toBe('import1|step|17|1')
  })
})

describe('imported face paths', () => {
  it('separates two imports of the same file', () => {
    expect(mintFaceUuid(importedFacePath('import1', 17)))
      .not.toBe(mintFaceUuid(importedFacePath('import2', 17)))
  })

  it('separates two entities of one import, and never collides with a side face', () => {
    const a = mintFaceUuid(importedFacePath('import1', 17))
    const b = mintFaceUuid(importedFacePath('import1', 171))
    // `1|7` vs `17` would collide if the separator were dropped from the path.
    const c = mintFaceUuid(sideFacePath('import1', 'step'))
    expect(new Set([a, b, c]).size).toBe(3)
  })

  it('index 0 stays byte-identical to the plain imported face path', () => {
    // A single-solid import must not renumber: two docs that imported the same
    // part as the first solid of a multi-solid file both keep today's UUIDs.
    expect(mintFaceUuid(importedInstanceFacePath('import1', 17, 0)))
      .toBe(mintFaceUuid(importedFacePath('import1', 17)))
  })

  it('separates repeated placements of one part by solid index', () => {
    // Two placements of ONE part share their STEP entity ids; the per-solid
    // index is the only thing that keeps their UUIDs disjoint.
    const perIndex = [0, 1, 2].map(i => mintFaceUuid(importedInstanceFacePath('import1', 17, i)))
    expect(new Set(perIndex).size).toBe(3)
    // The entity-id separator is not enough on its own: entity 17 + index 1
    // must not collide with entity 171 at index 0.
    const neighbour = mintFaceUuid(importedInstanceFacePath('import1', 171, 0))
    expect(new Set([...perIndex, neighbour]).size).toBe(4)
  })
})

describe('face UUID minting', () => {
  it('is deterministic across two independent mints', () => {
    const a = mintFaceUuid(sideFacePath('extrude1', 'line3'))
    const b = mintFaceUuid(sideFacePath('extrude1', 'line3'))
    expect(a).toBe(b)
    expect(a.startsWith(FACE_UUID_PREFIX)).toBe(true)
  })

  it('distinguishes different construction slots', () => {
    const side = mintFaceUuid(sideFacePath('extrude1', 'line3'))
    const other = mintFaceUuid(sideFacePath('extrude1', 'line4'))
    const cap = mintFaceUuid(capFacePath('extrude1', 'start'))
    expect(new Set([side, other, cap]).size).toBe(3)
  })
})

describe('edge/vertex derivation', () => {
  it('derives an edge UUID from the unordered face pair', () => {
    const fa = mintFaceUuid(sideFacePath('e1', 'l1'))
    const fb = mintFaceUuid(capFacePath('e1', 'start'))
    expect(deriveEdgeUuid(fa, fb)).toBe(deriveEdgeUuid(fb, fa))
    expect(deriveEdgeUuid(fa, fb).startsWith(EDGE_UUID_PREFIX)).toBe(true)
  })

  it('derives a vertex UUID from the unordered face set', () => {
    const f = [mintFaceUuid('a'), mintFaceUuid('b'), mintFaceUuid('c')]
    const v1 = deriveVertexUuid(f)
    const v2 = deriveVertexUuid([f[2], f[0], f[1]])
    expect(v1).toBe(v2)
    expect(v1.startsWith(VERTEX_UUID_PREFIX)).toBe(true)
  })

  it('derives a corner-face UUID from the unordered neighbour set', () => {
    const f = [mintFaceUuid('a'), mintFaceUuid('b'), mintFaceUuid('c')]
    const c1 = deriveCornerFaceUuid(f)
    const c2 = deriveCornerFaceUuid([f[2], f[0], f[1]])
    expect(c1).toBe(c2)
    expect(c1.startsWith(FACE_UUID_PREFIX)).toBe(true)
    // Same ingredients as a vertex, different namespace: the |corner marker
    // keeps a corner patch from colliding with the vertex its blends meet at.
    expect(c1.slice(FACE_UUID_PREFIX.length)).not.toBe(deriveVertexUuid(f).slice(VERTEX_UUID_PREFIX.length))
    expect(deriveCornerFaceUuid(f, 1)).not.toBe(c1)
  })

  it('multiplicity suffix keeps edge 0 stable but separates edge 1', () => {
    const fa = mintFaceUuid('a')
    const fb = mintFaceUuid('b')
    expect(deriveEdgeUuid(fa, fb, 0)).toBe(deriveEdgeUuid(fa, fb))
    expect(deriveEdgeUuid(fa, fb, 1)).not.toBe(deriveEdgeUuid(fa, fb, 0))
  })
})

describe('orderSplitChildren', () => {
  it('sorts stably by the normalized key', () => {
    const children: SplitChild<string>[] = [
      { item: 'right', key: [0.8, 0.5] },
      { item: 'left', key: [0.2, 0.5] },
    ]
    expect(orderSplitChildren(children)).toEqual(['left', 'right'])
  })

  it('is invariant to uniform parent resize (relative frame cancels scale)', () => {
    // A 10->11 mm resize scales absolute geometry but not the relative key.
    const before: SplitChild<string>[] = [
      { item: 'a', key: [0.25] },
      { item: 'b', key: [0.75] },
    ]
    const afterResize: SplitChild<string>[] = [
      { item: 'a', key: [0.25] },
      { item: 'b', key: [0.75] },
    ]
    expect(orderSplitChildren(before)).toEqual(orderSplitChildren(afterResize))
  })

  it('refuses (returns null) on a near-tie within SPLIT_EPS', () => {
    const children: SplitChild<string>[] = [
      { item: 'a', key: [0.5] },
      { item: 'b', key: [0.5 + SPLIT_EPS / 2] },
    ]
    expect(orderSplitChildren(children)).toBeNull()
  })

  it('orders by topological side index when supplied', () => {
    const children: SplitChild<string>[] = [
      { item: 'tool-side', key: [1] },
      { item: 'keep-side', key: [0] },
    ]
    expect(orderSplitChildren(children)).toEqual(['keep-side', 'tool-side'])
  })
})
