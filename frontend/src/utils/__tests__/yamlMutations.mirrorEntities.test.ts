import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { applyMirrorEntities, setIdSource } from '@/utils/yamlMutations'
import { sketchAt } from '@/testing/featureAccess'

const feat = (doc: PartDoc) => {
  const f = sketchAt(doc)
  return { entities: f.entities!, initial: f.initial!, constraints: f.constraints! }
}

// The mirror_entities applier: mirrored authored clones (new ids, mirrored
// initial blocks, carried construction flags) and the constraint carry-over
// policy -- relations whose every operand is mirrored or on the axis come back
// rewritten, everything else is dropped. The math itself is pinned in
// utils/geometry/__tests__/mirrorSketch.test.ts; these pin the document write.

/** Half a profile across the vertical axis x=0 (line `ax`), plus entities the
 *  mirror must leave alone (`l9` unselected, `pj` projected) or refuse (`ax` as
 *  a source). */
function halfDoc(): PartDoc {
  return {
    features: [{
      id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [
        { id: 'ax', kind: 'line' },
        { id: 'l1', kind: 'line' },
        { id: 'l2', kind: 'line' },
        { id: 'l9', kind: 'line' },
        { id: 'cl', kind: 'line', construction: true },
        { id: 'a1', kind: 'arc' },
        { id: 'c1', kind: 'circle' },
        { id: 'p1', kind: 'point' },
        { id: 'f1', kind: 'fit_spline', handles: 'both' },
        { id: 'pj', kind: 'line', source: '@sk/edge1' },
      ],
      initial: {
        ax: [0, 0, 0, 10],
        l1: [2, 0, 2, 4],
        l2: [2, 4, 5, 4],
        l9: [-3, 0, -3, 2],
        cl: [1, 1, 3, 1],
        a1: [3, 0, 1, 0, 180],
        c1: [4, 2, 1],
        p1: [5, 6],
        f1: [1, 1, 2, 2, 3, 1, 1.2, 1.2, 2.8, 1.2],
        pj: [7, 7, 8, 7],
      },
      constraints: [
        { id: 'k_chain', kind: 'coincident', a: '$l1end', b: '$l2start' },
        { id: 'k_axis_pin', kind: 'coincident', a: '$l1start', b: '$axstart' },
        { id: 'k_arc_pin', kind: 'coincident', a: '$l1end', b: '$a1start' },
        { id: 'k_tan', kind: 'tangent', a: '$l2', b: '$c1' },
        { id: 'k_rad', kind: 'radius', target: '$a1', value: 1 },
        { id: 'k_h', kind: 'horizontal', target: '$cl' },
        { id: 'k_v', kind: 'vertical', target: '$l1' },
        { id: 'k_ang', kind: 'angle', a: '$l1', b: '$l2', value: 90, sign: 1 },
        { id: 'k_px', kind: 'point_distance_x', a: '$p1', b: '$axstart', value: 5, sign: 1 },
        { id: 'k_fixed', kind: 'fixed', target: '$p1', x: 5, y: 6 },
        { id: 'k_offset', kind: 'offset', refs: ['$l1', '$l9'] },
        { id: 'k_cross', kind: 'coincident', a: '$l2end', b: '$l9start' },
        { id: 'k_axis_only', kind: 'horizontal', target: '$ax' },
        { id: 'k_dock', kind: 'dock', host: 'k_ang' },
      ],
    }],
  }
}

const SOURCE_IDS = ['l1', 'l2', 'ax', 'cl', 'a1', 'c1', 'p1', 'f1', 'pj']

function mirrorHalf(doc: PartDoc): void {
  applyMirrorEntities(doc, 'sk', SOURCE_IDS, 'ax')
}

describe('applyMirrorEntities entities', () => {
  it('clones every selected entity with mirrored params, keeping flags', () => {
    const doc = halfDoc()
    mirrorHalf(doc)
    const f = feat(doc)
    const originals = new Set(['ax', 'l1', 'l2', 'l9', 'cl', 'a1', 'c1', 'p1', 'f1', 'pj'])
    const added = f.entities.filter(e => !originals.has(e.id))
    expect(added).toHaveLength(7)  // ax (the axis) and pj (projected) are not cloned

    const newIds = added.map(e => e.id)
    const kinds = Object.fromEntries(added.map(e => [e.kind, true]))
    expect(kinds).toMatchObject({ line: true, arc: true, circle: true, point: true, fit_spline: true })
    // x -> -x across the vertical axis.
    expect(f.initial[newIds[0]]).toEqual([-2, 0, -2, 4])     // l1
    expect(f.initial[newIds[1]]).toEqual([-2, 4, -5, 4])     // l2
    expect(f.initial[newIds[2]]).toEqual([-1, 1, -3, 1])     // cl
    expect(f.initial[newIds[3]]).toEqual([-3, 0, 1, 0, 180]) // a1: center flips, CCW span kept
    expect(f.initial[newIds[4]]).toEqual([-4, 2, 1])         // c1
    expect(f.initial[newIds[5]]).toEqual([-5, 6])            // p1
    expect(f.initial[newIds[6]]).toEqual([-1, 1, -2, 2, -3, 1, -1.2, 1.2, -2.8, 1.2])  // f1
  })

  it('carries construction and fit-spline handle flags onto the clone', () => {
    const doc = halfDoc()
    mirrorHalf(doc)
    const f = feat(doc)
    const originals = new Set(['ax', 'l1', 'l2', 'l9', 'cl', 'a1', 'c1', 'p1', 'f1', 'pj'])
    const added = f.entities.filter(e => !originals.has(e.id))
    const clClone = added.find(e => JSON.stringify(f.initial[e.id]) === '[-1,1,-3,1]')!
    expect(clClone.construction).toBe(true)  // construction carries over
    const fitClone = added.find(e => e.kind === 'fit_spline')!
    expect(fitClone.handles).toBe('both')  // the handle block flag carries over
    // The originals keep their flags too.
    expect(f.entities.find(e => e.id === 'cl')?.construction).toBe(true)
    expect(f.entities.find(e => e.id === 'ax')?.construction).toBeUndefined()
  })

  it('leaves unselected and projected entities and the axis exactly as they were', () => {
    const doc = halfDoc()
    mirrorHalf(doc)
    const f = feat(doc)
    expect(f.initial.l9).toEqual([-3, 0, -3, 2])
    expect(f.initial.pj).toEqual([7, 7, 8, 7])
    expect(f.initial.ax).toEqual([0, 0, 0, 10])
    expect(f.entities.filter(e => e.id === 'pj' || e.id === 'l9')).toHaveLength(2)  // not duplicated
  })

  it('refuses a degenerate axis with no document change', () => {
    const doc = halfDoc()
    feat(doc).initial.ax = [3, 3, 3, 3]
    mirrorHalf(doc)
    expect(feat(doc).entities).toHaveLength(10)
  })

  it('skips a source whose block is non-finite but mirrors the rest', () => {
    const doc = halfDoc()
    feat(doc).initial.p1 = [5, NaN]
    mirrorHalf(doc)
    const added = feat(doc).entities.filter(e => !['ax', 'l1', 'l2', 'l9', 'cl', 'a1', 'c1', 'p1', 'f1', 'pj'].includes(e.id))
    expect(added).toHaveLength(6)
  })

  it('no-ops for a missing feature or an empty selection', () => {
    const doc = halfDoc()
    applyMirrorEntities(doc, 'nope', ['l1'], 'ax')
    applyMirrorEntities(doc, 'sk', [], 'ax')
    expect(feat(doc).entities).toHaveLength(10)
    expect(feat(doc).constraints).toHaveLength(14)
  })

  it('skips a source that lies on the axis: its mirror is the same edge', () => {
    const doc = halfDoc()
    // A seam edge collinear with `ax` (x=0), the shape a half profile closes
    // with. Cloning it would stack a second coincident edge on the seam.
    const sketch = sketchAt(doc)
    sketch.entities!.push({ id: 'seam', kind: 'line' })
    sketch.initial!.seam = [0, 1, 0, 9]
    applyMirrorEntities(doc, 'sk', ['l1', 'seam'], 'ax')
    const f = feat(doc)
    const originals = new Set(['ax', 'l1', 'l2', 'l9', 'cl', 'a1', 'c1', 'p1', 'f1', 'pj', 'seam'])
    const added = f.entities.filter(e => !originals.has(e.id))
    expect(added).toHaveLength(1)  // only l1 got a copy
    expect(f.initial[added[0].id]).toEqual([-2, 0, -2, 4])
    // The original seam stays exactly where it was; it serves both halves.
    expect(f.initial.seam).toEqual([0, 1, 0, 9])
  })

  it('a circle centered on the axis mirrors to itself and is skipped too', () => {
    const doc = halfDoc()
    const sketch = sketchAt(doc)
    sketch.entities!.push({ id: 'ring', kind: 'circle' })
    sketch.initial!.ring = [0, 3, 2]
    applyMirrorEntities(doc, 'sk', ['ring'], 'ax')
    const f = feat(doc)
    expect(f.entities.filter(e => e.id === 'ring')).toHaveLength(1)
    expect(f.initial.ring).toEqual([0, 3, 2])
  })
})

describe('applyMirrorEntities constraints', () => {
  it('clones exactly the carried set, rewritten to the mirrored ids', () => {
    const doc = halfDoc()
    mirrorHalf(doc)
    const f = feat(doc)
    const clones = f.constraints.filter(c => !c.id.startsWith('k_'))
    const carried = ['k_chain', 'k_axis_pin', 'k_arc_pin', 'k_tan', 'k_rad', 'k_h', 'k_v', 'k_ang', 'k_px', 'k_fixed']
    expect(clones.map(c => c.kind).sort()).toEqual(
      carried.map(k => f.constraints.find(c => c.id === k)!.kind).sort(),
    )
    expect(new Set(clones.map(c => c.id)).size).toBe(clones.length)  // fresh unique ids
    expect(clones.some(c => c.id.startsWith('k_'))).toBe(false)
  })

  it('rewrites vertex refs by position: the arc pin lands on the mirrored arc end', () => {
    const doc = halfDoc()
    mirrorHalf(doc)
    const f = feat(doc)
    const isOriginal = (id: string) => ['ax', 'l1', 'l2', 'l9', 'cl', 'a1', 'c1', 'p1', 'f1', 'pj'].includes(id)
    const cloneByParams = (json: string) =>
      f.entities.find(e => !isOriginal(e.id) && JSON.stringify(f.initial[e.id]) === json)!
    const l1Clone = cloneByParams('[-2,0,-2,4]')
    const l2Clone = cloneByParams('[-2,4,-5,4]')
    const arcClone = f.entities.find(e => e.kind === 'arc' && !isOriginal(e.id))!

    // The chain clone joins the two mirrored lines end-to-start.
    const chainClone = f.constraints.find(c =>
      !c.id.startsWith('k_') && c.kind === 'coincident' &&
      c.a === `$${l1Clone.id}end` && c.b === `$${l2Clone.id}start`)
    expect(chainClone).toBeDefined()

    // The axis pin keeps its axis operand untouched and moves the line operand.
    const axisPin = f.constraints.find(c =>
      !c.id.startsWith('k_') && c.kind === 'coincident' &&
      c.a === `$${l1Clone.id}start` && c.b === '$axstart')
    expect(axisPin).toBeDefined()

    // The arc pin: old `a1start` image is the mirrored arc's END (CCW swap).
    const arcPin = f.constraints.find(c =>
      !c.id.startsWith('k_') && c.kind === 'coincident' &&
      c.a === `$${l1Clone.id}end` && c.b === `$${arcClone.id}end`)
    expect(arcPin).toBeDefined()
  })

  it('keeps values, flips sign on directional dimensions, mirrors fixed x/y', () => {
    const doc = halfDoc()
    mirrorHalf(doc)
    const f = feat(doc)
    const radClone = f.constraints.find(c => !c.id.startsWith('k_') && c.kind === 'radius')!
    expect(radClone.value).toBe(1)
    const angClone = f.constraints.find(c => !c.id.startsWith('k_') && c.kind === 'angle')!
    expect(angClone.value).toBe(90)
    expect(angClone.sign).toBe(-1)  // the mirror swaps the side the signed measure matched
    const pxClone = f.constraints.find(c => !c.id.startsWith('k_') && c.kind === 'point_distance_x')!
    expect(pxClone.sign).toBe(-1)
    const fixedClone = f.constraints.find(c => !c.id.startsWith('k_') && c.kind === 'fixed')!
    expect([fixedClone.x, fixedClone.y]).toEqual([-5, 6])
  })

  it('drops sugar, cross-boundary, axis-only, and dock constraints', () => {
    const doc = halfDoc()
    mirrorHalf(doc)
    const f = feat(doc)
    const clones = f.constraints.filter(c => !c.id.startsWith('k_'))
    expect(clones.some(c => c.kind === 'offset')).toBe(false)
    expect(clones.some(c => c.kind === 'dock')).toBe(false)
    // k_cross names unselected $l9 and k_axis_only mirrors nothing: no clone
    // references $l9 or targets the bare axis.
    expect(clones.some(c => JSON.stringify(c).includes('$l9'))).toBe(false)
    expect(clones.some(c => c.target === '$ax')).toBe(false)
    // The originals all survive.
    expect(f.constraints.filter(c => c.id.startsWith('k_'))).toHaveLength(14)
  })

  it('swaps horizontal for vertical on a 45 deg axis and drops both on a 30 deg axis', () => {
    const mk = (axisParams: number[]): PartDoc => ({
      features: [{
        id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [{ id: 'ax', kind: 'line' }, { id: 'l', kind: 'line' }],
        initial: { ax: axisParams, l: [0, 1, 2, 1] },
        constraints: [{ id: 'k_h', kind: 'horizontal', target: '$l' }],
      }],
    })

    const swap = mk([0, 0, 1, 1])
    applyMirrorEntities(swap, 'sk', ['l'], 'ax')
    const swapClones = feat(swap).constraints.filter(c => !c.id.startsWith('k_'))
    expect(swapClones).toHaveLength(1)
    expect(swapClones[0].kind).toBe('vertical')  // a horizontal line mirrored in y=x runs vertical
    const lineClone = feat(swap).entities.find(e => e.id !== 'ax' && e.id !== 'l')!
    expect(feat(swap).initial[lineClone.id]).toEqual([1, 0, 1, 2])

    const drop = mk([0, 0, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)])
    applyMirrorEntities(drop, 'sk', ['l'], 'ax')
    const dropClones = feat(drop).constraints.filter(c => !c.id.startsWith('k_'))
    expect(dropClones).toHaveLength(0)  // neither horizontal nor vertical survives a 30 deg axis
  })

  it('keeps horizontal for an axis-aligned axis', () => {
    const doc = mk30()
    feat(doc).initial.ax = [0, 0, 0, 10]  // vertical axis
    applyMirrorEntities(doc, 'sk', ['l'], 'ax')
    const clones = feat(doc).constraints.filter(c => !c.id.startsWith('k_'))
    expect(clones).toHaveLength(1)
    expect(clones[0].kind).toBe('horizontal')
  })
})

function mk30(): PartDoc {
  return {
    features: [{
      id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'ax', kind: 'line' }, { id: 'l', kind: 'line' }],
      initial: { ax: [0, 0, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6) ], l: [0, 1, 2, 1] },
      constraints: [{ id: 'k_h', kind: 'horizontal', target: '$l' }],
    }],
  }
}

describe('applyMirrorEntities determinism', () => {
  it('mints the mirrored ids in source order from the seeded id source', () => {
    // Reset the source between runs, the way drive replay re-seeds each run.
    const seeded = () => {
      let n = 0
      return () => `mid${++n}`
    }
    try {
      setIdSource(seeded())
      const docA = halfDoc()
      mirrorHalf(docA)
      setIdSource(seeded())
      const docB = halfDoc()
      mirrorHalf(docB)
      const idsA = feat(docA).entities.slice(10).map(e => e.id)
      const idsB = feat(docB).entities.slice(10).map(e => e.id)
      expect(idsA).toEqual(['mid1', 'mid2', 'mid3', 'mid4', 'mid5', 'mid6', 'mid7'])
      expect(idsB).toEqual(idsA)
      const consA = feat(docA).constraints.slice(14).map(c => c.id)
      const consB = feat(docB).constraints.slice(14).map(c => c.id)
      expect(consA).toEqual(consB)
      expect(new Set(consA).size).toBe(consA.length)
    } finally {
      setIdSource(null)
    }
  })
})
