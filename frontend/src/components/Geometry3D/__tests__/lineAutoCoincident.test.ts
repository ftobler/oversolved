import { describe, it, expect } from 'vitest'
import { computeDrawClick, type DrawSnapState } from '@/components/Geometry3D/drawLogic'
import { mutationHandlers } from '@/hooks/mutationDispatch'
import type { PartDoc, Mutation, PartConstraint } from '@/types/cad'

// End-to-end over the pure layer: drive the line tool the way DrawingTool does
// and read the constraints that actually land in the document. The reported bug
// was invisible at the mutation level -- a coincident WAS emitted, it just named
// `draw:last`, a sentinel that parseTarget lowered to the dead ref `$draw:last`.
// Only the applied document shows that.

const FEATURE = 'S1'

function emptySnap(): DrawSnapState {
  return {
    hoveredVertexId: null,
    hoveredVertexPosition: null,
    hoveredSnapKind: null,
    hoveredSelectionId: null,
    drawSnapVertexId: null,
    alignmentSnapPoint: null,
    alignmentSnapKind: null,
  }
}

function emptyDoc(): PartDoc {
  return {
    features: [{ id: FEATURE, kind: 'sketch', entities: [], initial: {}, constraints: [] }],
  } as unknown as PartDoc
}

function sketchOf(doc: PartDoc) {
  return doc.features![0]
}

/** One click: resolve it, apply its mutations, and carry the tool state forward
 *  exactly as DrawingTool does (draw points from nextDrawPoints, draw snap from
 *  nextDrawSnap, everything else fresh per click). */
function makeTool(doc: PartDoc) {
  let ids = 0
  let drawPoints: [number, number][] = []
  let drawSnapVertexId: string | null = null

  return function click(at: [number, number], snapPatch: Partial<DrawSnapState> = {}) {
    const snap: DrawSnapState = { ...emptySnap(), ...snapPatch, drawSnapVertexId }
    const result = computeDrawClick('line', drawPoints, at, snap, FEATURE, () => `L${++ids}`)
    for (const m of result.mutations) {
      const handler = (mutationHandlers as Record<string, ((d: PartDoc, m: Mutation) => void) | undefined>)[m.type]
      handler?.(doc, m)
    }
    drawPoints = result.nextDrawPoints ?? drawPoints
    if (result.nextDrawSnap !== null) drawSnapVertexId = result.nextDrawSnap.vertexId
    if (result.gestureComplete) {
      drawPoints = []
      drawSnapVertexId = null
    }
    return result
  }
}

const kinds = (cs: PartConstraint[]) => cs.map(c => c.kind).sort()
const refs = (c: PartConstraint) => [c.a, c.b]

describe('line tool authors the constraints its snapping promises', () => {
  it('joins consecutive chain segments with a coincident on the shared point', () => {
    const doc = emptyDoc()
    const click = makeTool(doc)

    click([0, 0])
    click([5, 0])
    click([5, 5])

    const s = sketchOf(doc)
    expect(s.entities).toHaveLength(2)
    // One join, between segment 1's end and segment 2's start.
    expect(kinds(s.constraints!)).toEqual(['coincident'])
    const [first, second] = s.entities!.map(e => e.id)
    expect(refs(s.constraints![0]).sort()).toEqual([`$${first}end`, `$${second}start`].sort())
  })

  it('closes a polyline onto the first vertex instead of only agreeing on coordinates', () => {
    const doc = emptyDoc()
    const click = makeTool(doc)

    click([0, 0])
    click([5, 0])
    click([5, 5])
    // The closing click snaps onto the chain's first vertex, so the tool sees a
    // vertex hover there the same as any other snapped click.
    const firstSegment = sketchOf(doc).entities![0].id
    const closing = click([0, 0], {
      hoveredVertexId: `vertex:${FEATURE}:${firstSegment}:start`,
      hoveredVertexPosition: [0, 0],
      hoveredSnapKind: 'vertex',
    })

    expect(closing.gestureComplete).toBe(true)
    const s = sketchOf(doc)
    expect(s.entities).toHaveLength(3)
    // Two chain joins plus the closing join: the loop is constrained closed.
    expect(kinds(s.constraints!)).toEqual(['coincident', 'coincident', 'coincident'])
    const last = s.entities![2].id
    expect(s.constraints!.some(c =>
      refs(c).includes(`$${last}end`) && refs(c).includes(`$${firstSegment}start`)
    )).toBe(true)
  })

  it('authors horizontal on the segment itself for an axis alignment snap', () => {
    const doc = emptyDoc()
    const click = makeTool(doc)

    click([0, 0])
    click([7, 99], {
      alignmentSnapPoint: [0, 0],
      alignmentSnapKind: 'kinda_horizontal',
    })

    const s = sketchOf(doc)
    expect(kinds(s.constraints!)).toEqual(['horizontal'])
    // The single-target form: make THIS line axis-aligned. A point pair would be
    // a claim about two vertices, and an alignment snap knows only one.
    expect(s.constraints![0].target).toBe(`$${s.entities![0].id}`)
    expect(s.constraints![0].a).toBeUndefined()
    expect(s.constraints![0].b).toBeUndefined()
  })

  it('authors vertical, not coincident, for a vertical alignment snap', () => {
    const doc = emptyDoc()
    const click = makeTool(doc)

    click([0, 0])
    click([0.2, 8], {
      alignmentSnapPoint: [0, 0],
      alignmentSnapKind: 'kinda_vertical',
    })

    expect(kinds(sketchOf(doc).constraints!)).toEqual(['vertical'])
  })

  it('never lets an alignment snap seed the next segment as a coincident', () => {
    // The regression shape: an alignment snap has no vertex to be coincident
    // with, so the chain must continue from the segment's own end vertex.
    const doc = emptyDoc()
    const click = makeTool(doc)

    click([0, 0])
    click([9, 0], { alignmentSnapPoint: [0, 0], alignmentSnapKind: 'kinda_horizontal' })
    click([9, 4])

    const s = sketchOf(doc)
    const [first, second] = s.entities!.map(e => e.id)
    expect(kinds(s.constraints!)).toEqual(['coincident', 'horizontal'])
    const join = s.constraints!.find(c => c.kind === 'coincident')!
    expect(refs(join).sort()).toEqual([`$${first}end`, `$${second}start`].sort())
  })

  it('leaves no constraint referencing an unresolvable ref', () => {
    // Every authored ref must name a real entity in this sketch. `$draw:last`
    // passed every mutation-level assertion and still named nothing.
    const doc = emptyDoc()
    const click = makeTool(doc)

    click([0, 0])
    click([9, 0], { alignmentSnapPoint: [0, 0], alignmentSnapKind: 'kinda_horizontal' })
    click([9, 4])
    click([2, 4], { alignmentSnapPoint: [9, 4], alignmentSnapKind: 'kinda_horizontal' })

    const s = sketchOf(doc)
    const known = new Set(s.entities!.map(e => e.id))
    for (const c of s.constraints!) {
      for (const ref of [c.target, c.a, c.b]) {
        if (ref === undefined) continue
        expect(typeof ref).toBe('string')
        const eid = (ref as string).replace(/^\$/, '').replace(/(start|end|center|xy)$/, '')
        expect(known.has(eid)).toBe(true)
      }
    }
  })

  it('still refuses a zero-length segment between one vertex and itself', () => {
    const doc = emptyDoc()
    const click = makeTool(doc)

    click([0, 0], { hoveredVertexId: 'vertex:S1:EXT:end', hoveredVertexPosition: [0, 0] })
    click([0, 0], {
      hoveredVertexId: 'vertex:S1:EXT:end',
      hoveredVertexPosition: [0, 0],
      hoveredSnapKind: 'vertex',
    })

    expect(sketchOf(doc).constraints).toHaveLength(0)
  })
})
