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
  mintFaceUuid,
  deriveEdgeUuid,
  deriveVertexUuid,
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
    ]
    for (const p of paths) expect(p).not.toMatch(FLOAT_RE)
  })

  it('round-trips the expected path shapes', () => {
    expect(sideFacePath('extrude1', 'line3')).toBe('extrude1|side|line3')
    expect(capFacePath('extrude1', 'end')).toBe('extrude1|cap|end')
    expect(filletFacePath('fillet2', 'e_abc')).toBe('fillet2|fillet|e_abc')
    expect(splitFacePath('u_p', 2)).toBe('u_p|split|2')
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
