// Stage 6f: what the assembly viewport draws, asserted without a viewport.

import { describe, it, expect } from 'vitest'
import type { AssemblyDoc, BodyResult, PartInstance, Transform3D } from '@/types/cad'
import { ASSEMBLY_BUILTIN_DEFAULTS } from '@/utils/builtins'
import {
  getAssemblyBuiltinsToRender,
  getAssemblyPartGroups,
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

describe('getAssemblyBuiltinsToRender', () => {
  it('puts the assembly origin and its three planes in the render list', () => {
    const doc: AssemblyDoc = { kind: 'assembly', features: [...ASSEMBLY_BUILTIN_DEFAULTS] }
    const items = getAssemblyBuiltinsToRender(doc)

    expect(items.map(i => i.id)).toEqual(['AssemblyOrigin', 'AssemblyTop', 'AssemblyFront', 'AssemblyRight'])
    expect(items[0].kind).toBe('origin')
    // Same orientation convention as the part editor's reference planes.
    expect(items.find(i => i.id === 'AssemblyFront')!.rotation).toEqual([0, 0, 0])
    expect(items.find(i => i.id === 'AssemblyTop')!.rotation).toEqual([-Math.PI / 2, 0, 0])
    expect(items.find(i => i.id === 'AssemblyRight')!.rotation).toEqual([0, Math.PI / 2, 0])
  })

  it('ignores part instances, mates and an absent doc', () => {
    const doc: AssemblyDoc = {
      kind: 'assembly',
      features: [
        ...ASSEMBLY_BUILTIN_DEFAULTS,
        { id: 'f1', kind: 'part_instance', instance: instance('p1') },
      ],
    }
    expect(getAssemblyBuiltinsToRender(doc)).toHaveLength(4)
    expect(getAssemblyBuiltinsToRender(null)).toEqual([])
  })

  it('does not render a part built-in that happens to share a feature id', () => {
    const doc: AssemblyDoc = { kind: 'assembly', features: [{ id: 'Top', kind: 'plane' }] }
    expect(getAssemblyBuiltinsToRender(doc)).toEqual([])
  })
})

describe('getAssemblyPartGroups', () => {
  it('groups each instance-s bodies and leaves them at their solved pose', () => {
    const groups = getAssemblyPartGroups(bodyDict('p1', 'p2'), [instance('p1'), instance('p2')], null, null)

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
      null,
    )
    expect(groups.map(g => g.handle)).toEqual(['p2'])
  })

  it('marks the selected instance', () => {
    const groups = getAssemblyPartGroups(bodyDict('p1', 'p2'), [instance('p1'), instance('p2')], null, 'p2')
    expect(groups.map(g => g.selected)).toEqual([false, true])
  })

  it('offsets only the dragged part, by the drag delta', () => {
    const drag = session('p2', IDENTITY_TRANSFORM, { ...IDENTITY_TRANSFORM, tx: 3, ty: 4 })
    const groups = getAssemblyPartGroups(bodyDict('p1', 'p2'), [instance('p1'), instance('p2')], drag, null)

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
    const groups = getAssemblyPartGroups(bodyDict('p1'), [instance('p1')], drag, null)
    expect(groups[0].position[0]).toBeCloseTo(2, 6)
  })

  it('carries a gizmo rotation into the group quaternion', () => {
    const q = quatFromAxisAngle([0, 0, 1], Math.PI / 2)
    const drag = session('p1', IDENTITY_TRANSFORM, makeTransform([0, 0, 0], q))
    const groups = getAssemblyPartGroups(bodyDict('p1'), [instance('p1')], drag, null)
    expect(groups[0].quaternion[2]).toBeCloseTo(Math.SQRT1_2, 6)
    expect(groups[0].quaternion[3]).toBeCloseTo(Math.SQRT1_2, 6)
  })
})

describe('gizmoOrigin', () => {
  const solved: Record<string, Transform3D> = { p1: { ...IDENTITY_TRANSFORM, tx: 5 } }

  it('sits at the part-s solved origin', () => {
    const groups = getAssemblyPartGroups(bodyDict('p1'), [instance('p1')], null, 'p1')
    expect(gizmoOrigin('p1', groups, solved, [instance('p1')])).toEqual([5, 0, 0])
  })

  it('follows a live drag', () => {
    const drag = session('p1', IDENTITY_TRANSFORM, { ...IDENTITY_TRANSFORM, ty: 2 })
    const groups = getAssemblyPartGroups(bodyDict('p1'), [instance('p1')], drag, 'p1')
    const o = gizmoOrigin('p1', groups, solved, [instance('p1')])!
    expect(o[0]).toBeCloseTo(5, 6)
    expect(o[1]).toBeCloseTo(2, 6)
  })

  it('falls back to the placed transform before the first solve, and is null with no selection', () => {
    const groups = getAssemblyPartGroups(bodyDict('p1'), [instance('p1', { transform: { ...IDENTITY_TRANSFORM, tz: 7 } })], null, 'p1')
    expect(gizmoOrigin('p1', groups, {}, [instance('p1', { transform: { ...IDENTITY_TRANSFORM, tz: 7 } })])).toEqual([0, 0, 7])
    expect(gizmoOrigin(null, groups, solved, [instance('p1')])).toBeNull()
  })
})
