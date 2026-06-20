import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import type React from 'react'
import { worldToLocal3D, worldToSketchLocal } from '@/components/Geometry3D/coordTransformAdapters'

// The adapters pull the parent transform off a Three.js group ref and delegate
// to worldToSketchLocalPure. The logic worth pinning here is the ref-mount guard
// and the |localZ| > 1 off-plane rejection (a hit on an HTML overlay rather than
// the sketch plane). getWorldPosition/getWorldQuaternion self-update the world
// matrix, so no scene mount is needed.
const refTo = (obj: THREE.Object3D | null) =>
  ({ current: obj }) as React.RefObject<THREE.Object3D | null>

const groupAt = (
  pos: [number, number, number],
  quat?: THREE.Quaternion,
): THREE.Object3D => {
  const o = new THREE.Object3D()
  o.position.set(pos[0], pos[1], pos[2])
  if (quat) o.quaternion.copy(quat)
  return o
}

describe('worldToLocal3D', () => {
  it('returns null when the group ref is not mounted', () => {
    expect(worldToLocal3D(new THREE.Vector3(1, 2, 3), refTo(null))).toBeNull()
  })

  it('translates by the parent position under identity rotation', () => {
    const ref = refTo(groupAt([10, 20, 0]))
    expect(worldToLocal3D(new THREE.Vector3(11, 20, 0), ref)).toEqual([1, 0, 0])
  })

  it('applies the inverse parent rotation', () => {
    // Parent rotated +90 deg about Z maps sketch-local -> world; world -> local
    // is the inverse, so world (0,1,0) comes back as local (1,0,0).
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
    const ref = refTo(groupAt([0, 0, 0], q))
    const local = worldToLocal3D(new THREE.Vector3(0, 1, 0), ref)
    expect(local).not.toBeNull()
    expect(local![0]).toBeCloseTo(1, 9)
    expect(local![1]).toBeCloseTo(0, 9)
    expect(local![2]).toBeCloseTo(0, 9)
  })
})

describe('worldToSketchLocal', () => {
  it('returns null when the group ref is not mounted', () => {
    expect(worldToSketchLocal(new THREE.Vector3(1, 2, 3), refTo(null))).toBeNull()
  })

  it('drops the z component for an on-plane hit', () => {
    const ref = refTo(groupAt([10, 20, 0]))
    expect(worldToSketchLocal(new THREE.Vector3(13, 24, 0), ref)).toEqual([3, 4])
  })

  it('accepts a small off-plane offset within the |z| <= 1 tolerance', () => {
    const ref = refTo(groupAt([0, 0, 0]))
    expect(worldToSketchLocal(new THREE.Vector3(2, 5, 0.5), ref)).toEqual([2, 5])
  })

  it('rejects an off-plane hit beyond |z| > 1 (e.g. an HTML overlay)', () => {
    const ref = refTo(groupAt([0, 0, 0]))
    expect(worldToSketchLocal(new THREE.Vector3(2, 5, 2), ref)).toBeNull()
  })
})
