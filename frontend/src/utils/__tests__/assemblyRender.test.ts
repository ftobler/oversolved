// Stage 6f: what the assembly viewport draws, asserted without a viewport.

import { describe, it, expect } from 'vitest'
import type { AssemblyDoc, BodyResult, PartInstance, Transform3D } from '@/types/cad'
import { ASSEMBLY_BUILTIN_DEFAULTS } from '@/utils/assemblyBuiltins'
import {
  getAssemblyBuiltins,
  getAssemblyBuiltinsToRender,
  getAssemblyPartGroups,
  gizmoOrientation,
  gizmoOrigin,
} from '@/utils/assemblyRender'
import type { ManipulationSession } from '@/utils/partManipulation'
import { IDENTITY_TRANSFORM, quatFromAxisAngle, makeTransform } from '@/utils/transform3d'

function instance(handle: string, extra: Partial<PartInstance> = {}): PartInstance {
  return { handle, doc_id: `doc-${handle}`, doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, ...extra }
}

function body(handle: string, index: number): BodyResult {
  return {
    id: `${handle}:body_${index}`,
    created_by: handle,
    modified_by: [],
    mesh: { vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), faces: new Uint32Array([0, 1, 2]) },
  }
}

function bodyDict(...handles: string[]): Record<string, BodyResult> {
  const out: Record<string, BodyResult> = {}
  for (const h of handles) out[`${h}:body_0`] = body(h, 0)
  return out
}

function session(handle: string, seed: Transform3D, current: Transform3D): ManipulationSession {
  return { handle, seed, current }
}

// The defaults carry no `visible`, so they are hidden; shown() flags them on.
const shownDefaults = ASSEMBLY_BUILTIN_DEFAULTS.map(f => ({ ...f, visible: true }))

describe('getAssemblyBuiltinsToRender', () => {
  it('draws the origin and its three planes once they are shown', () => {
    const doc: AssemblyDoc = { kind: 'assembly', features: shownDefaults }
    const items = getAssemblyBuiltinsToRender(doc)

    expect(items.map(i => i.id)).toEqual(['AssemblyOrigin', 'AssemblyTop', 'AssemblyFront', 'AssemblyRight'])
    expect(items[0].kind).toBe('origin')
    // Same orientation convention as the part editor's reference planes.
    expect(items.find(i => i.id === 'AssemblyFront')!.rotation).toEqual([0, 0, 0])
    expect(items.find(i => i.id === 'AssemblyTop')!.rotation).toEqual([-Math.PI / 2, 0, 0])
    expect(items.find(i => i.id === 'AssemblyRight')!.rotation).toEqual([0, Math.PI / 2, 0])
  })

  it('draws nothing by default: reference geometry is hidden until shown', () => {
    const doc: AssemblyDoc = { kind: 'assembly', features: [...ASSEMBLY_BUILTIN_DEFAULTS] }
    expect(getAssemblyBuiltinsToRender(doc)).toEqual([])
  })

  it('draws only the shown built-ins', () => {
    const doc: AssemblyDoc = {
      kind: 'assembly',
      features: ASSEMBLY_BUILTIN_DEFAULTS.map(f => ({ ...f, visible: f.id === 'AssemblyTop' })),
    }
    expect(getAssemblyBuiltinsToRender(doc).map(i => i.id)).toEqual(['AssemblyTop'])
  })

  it('ignores part instances, mates and an absent doc', () => {
    const doc: AssemblyDoc = {
      kind: 'assembly',
      features: [
        ...shownDefaults,
        { id: 'f1', kind: 'part_instance', instance: instance('p1') },
      ],
    }
    expect(getAssemblyBuiltinsToRender(doc)).toHaveLength(4)
    expect(getAssemblyBuiltinsToRender(null)).toEqual([])
  })

  it('does not render a part built-in that happens to share a feature id', () => {
    const doc: AssemblyDoc = { kind: 'assembly', features: [{ id: 'Top', kind: 'plane', visible: true }] }
    expect(getAssemblyBuiltinsToRender(doc)).toEqual([])
  })
})

describe('getAssemblyBuiltins', () => {
  it('lists every built-in with its visibility, hidden by default', () => {
    const doc: AssemblyDoc = { kind: 'assembly', features: [...ASSEMBLY_BUILTIN_DEFAULTS] }
    const rows = getAssemblyBuiltins(doc)
    expect(rows.map(r => r.id)).toEqual(['AssemblyOrigin', 'AssemblyTop', 'AssemblyFront', 'AssemblyRight'])
    expect(rows.every(r => r.visible === false)).toBe(true)
    expect(rows.find(r => r.id === 'AssemblyTop')!.label).toBe('Top')
  })

  it('reflects a shown built-in', () => {
    const doc: AssemblyDoc = {
      kind: 'assembly',
      features: ASSEMBLY_BUILTIN_DEFAULTS.map(f => ({ ...f, visible: f.id === 'AssemblyFront' })),
    }
    expect(getAssemblyBuiltins(doc).find(r => r.id === 'AssemblyFront')!.visible).toBe(true)
  })

  it('lists nothing for an absent doc', () => {
    expect(getAssemblyBuiltins(null)).toEqual([])
  })
})

describe('getAssemblyPartGroups', () => {
  it('groups each instance-s bodies and leaves them at their solved pose', () => {
    const groups = getAssemblyPartGroups(bodyDict('p1', 'p2'), [instance('p1'), instance('p2')], null, new Set())

    expect(groups.map(g => g.handle)).toEqual(['p1', 'p2'])
    expect(groups[0].items).toHaveLength(1)
    // The solved transform is already baked into the vertices worker-side.
    expect(groups[0].position).toEqual([0, 0, 0])
    expect(groups[0].quaternion).toEqual([0, 0, 0, 1])
  })

  it('drops a hidden instance and an instance with no bodies', () => {
    const groups = getAssemblyPartGroups(
      bodyDict('p1', 'p2'),
      [instance('p1', { visible: false }), instance('p2'), instance('p3')],
      null,
      new Set(),
    )
    expect(groups.map(g => g.handle)).toEqual(['p2'])
  })

  it('marks the selected instance', () => {
    const groups = getAssemblyPartGroups(bodyDict('p1', 'p2'), [instance('p1'), instance('p2')], null, new Set(['p2']))
    expect(groups.map(g => g.selected)).toEqual([false, true])
  })

  it('offsets only the dragged part, by the drag delta', () => {
    const drag = session('p2', IDENTITY_TRANSFORM, { ...IDENTITY_TRANSFORM, tx: 3, ty: 4 })
    const groups = getAssemblyPartGroups(bodyDict('p1', 'p2'), [instance('p1'), instance('p2')], drag, new Set())

    expect(groups[0].manipulating).toBe(false)
    expect(groups[0].position).toEqual([0, 0, 0])
    expect(groups[1].manipulating).toBe(true)
    expect(groups[1].position[0]).toBeCloseTo(3, 6)
    expect(groups[1].position[1]).toBeCloseTo(4, 6)
  })

  it('measures the offset against the session seed, so a mate-displaced part still tracks the pointer', () => {
    // The part was seeded at x=10 and dragged 2 further; the drawn mesh sits
    // wherever the mate solve put it, and must move by exactly the drag delta.
    const seed: Transform3D = { ...IDENTITY_TRANSFORM, tx: 10 }
    const drag = session('p1', seed, { ...seed, tx: 12 })
    const groups = getAssemblyPartGroups(bodyDict('p1'), [instance('p1')], drag, new Set())
    expect(groups[0].position[0]).toBeCloseTo(2, 6)
  })

  it('carries a gizmo rotation into the group quaternion', () => {
    const q = quatFromAxisAngle([0, 0, 1], Math.PI / 2)
    const drag = session('p1', IDENTITY_TRANSFORM, makeTransform([0, 0, 0], q))
    const groups = getAssemblyPartGroups(bodyDict('p1'), [instance('p1')], drag, new Set())
    expect(groups[0].quaternion[2]).toBeCloseTo(Math.SQRT1_2, 6)
    expect(groups[0].quaternion[3]).toBeCloseTo(Math.SQRT1_2, 6)
  })

  // What this function buys, and what it does not, spelled out so the next
  // reader knows where the memo protecting it has to sit.
  //
  // It is a pure rebuild: called twice with the very same arguments it returns
  // content-equal groups whose objects and `items` arrays are all NEW. Only the
  // leaves it does not construct -- the BodyRenderItem objects out of
  // getBodiesToRender, and the typed-array meshes inside them -- carry through.
  //
  // So the identity every AssemblyBody sees is decided entirely upstream, by
  // whether AssemblyViewport's `groups` memo re-runs. That memo is keyed on
  // `instances` among others, which is exactly why the store hands back the
  // array it already holds when nothing about the parts changed
  // (`sameInstances`, stores/assemblyStore.ts). Without that, a doc edit that
  // moved no part still landed here and re-minted the whole render tree.
  it('rebuilds every group and items array it returns, keeping only the leaves', () => {
    const bodies = bodyDict('p1', 'p2')
    const instances = [instance('p1'), instance('p2')]

    const first = getAssemblyPartGroups(bodies, instances, null, new Set())
    const second = getAssemblyPartGroups(bodies, instances, null, new Set())

    expect(second).toEqual(first)  // content-equal, group for group
    expect(second).not.toBe(first)
    for (let i = 0; i < first.length; i++) {
      expect(second[i]).not.toBe(first[i])
      expect(second[i].items).not.toBe(first[i].items)
      expect(second[i].items.map(it => it.key)).toEqual(first[i].items.map(it => it.key))
      // The mesh is the expensive part and it is never rebuilt: the render item
      // hands on the very Float32Array the solve produced.
      for (let j = 0; j < first[i].items.length; j++) {
        expect(second[i].items[j].mesh.vertices).toBe(first[i].items[j].mesh.vertices)
      }
    }
  })
})

describe('gizmoOrigin', () => {
  const solved: Record<string, Transform3D> = { p1: { ...IDENTITY_TRANSFORM, tx: 5 } }

  it('sits at the part-s solved origin', () => {
    const groups = getAssemblyPartGroups(bodyDict('p1'), [instance('p1')], null, new Set(['p1']))
    expect(gizmoOrigin('p1', groups, solved, [instance('p1')])).toEqual([5, 0, 0])
  })

  it('follows a live drag', () => {
    const drag = session('p1', IDENTITY_TRANSFORM, { ...IDENTITY_TRANSFORM, ty: 2 })
    const groups = getAssemblyPartGroups(bodyDict('p1'), [instance('p1')], drag, new Set(['p1']))
    const o = gizmoOrigin('p1', groups, solved, [instance('p1')])!
    expect(o[0]).toBeCloseTo(5, 6)
    expect(o[1]).toBeCloseTo(2, 6)
  })

  it('falls back to the placed transform before the first solve, and is null with no selection', () => {
    const groups = getAssemblyPartGroups(bodyDict('p1'), [instance('p1', { transform: { ...IDENTITY_TRANSFORM, tz: 7 } })], null, new Set(['p1']))
    expect(gizmoOrigin('p1', groups, {}, [instance('p1', { transform: { ...IDENTITY_TRANSFORM, tz: 7 } })])).toEqual([0, 0, 7])
    expect(gizmoOrigin(null, groups, solved, [instance('p1')])).toBeNull()
  })
})

describe('gizmoOrientation', () => {
  it('matches the part-s solved orientation, so the triad tilts with the part', () => {
    const q = quatFromAxisAngle([0, 0, 1], Math.PI / 2)
    const solved: Record<string, Transform3D> = { p1: makeTransform([0, 0, 0], q) }
    const groups = getAssemblyPartGroups(bodyDict('p1'), [instance('p1')], null, new Set(['p1']))
    const o = gizmoOrientation('p1', groups, solved, [instance('p1')])!
    expect(o[2]).toBeCloseTo(Math.SQRT1_2, 6)
    expect(o[3]).toBeCloseTo(Math.SQRT1_2, 6)
  })

  it('composes a live gizmo rotation onto the solved orientation', () => {
    // Solved at +90-deg about Z, then dragged another +90; the triad shows 180.
    const solved: Record<string, Transform3D> = { p1: makeTransform([0, 0, 0], quatFromAxisAngle([0, 0, 1], Math.PI / 2)) }
    const drag = session('p1', IDENTITY_TRANSFORM, makeTransform([0, 0, 0], quatFromAxisAngle([0, 0, 1], Math.PI / 2)))
    const groups = getAssemblyPartGroups(bodyDict('p1'), [instance('p1')], drag, new Set(['p1']))
    const o = gizmoOrientation('p1', groups, solved, [instance('p1')])!
    expect(o[2]).toBeCloseTo(1, 6)  // sin(90 deg) about Z
    expect(o[3]).toBeCloseTo(0, 6)  // cos(90 deg)
  })

  it('is null with no selection', () => {
    const groups = getAssemblyPartGroups(bodyDict('p1'), [instance('p1')], null, new Set(['p1']))
    expect(gizmoOrientation(null, groups, {}, [instance('p1')])).toBeNull()
  })
})
