// Reading the orbit pivot from the body under the cursor. The ID buffer names
// the entity but not the depth, so this is a one-shot raycast against the body
// surfaces only: the meshes opt in by tagging `userData.orbitPivot`, which is
// what keeps planes, sketches, helpers and the cube out of the pick.
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { isShownInScene, pickPivotPoint, pointerToNdc } from '@/components/Viewport/pivotPick'

const RECT = { left: 100, top: 50, width: 800, height: 600 }

function cameraAtOriginLookingDownZ(): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-400, 400, 300, -300, -1000, 1000)
  camera.position.set(0, 0, 100)
  camera.lookAt(0, 0, 0)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld()
  return camera
}

function taggedBody(z: number, size = 200): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial())
  mesh.userData.orbitPivot = true
  mesh.position.set(0, 0, z)
  return mesh
}

describe('pointerToNdc', () => {
  it('maps the rect corners to the clip-space corners', () => {
    expect(pointerToNdc(RECT, 100, 50)!.toArray()).toEqual([-1, 1])
    expect(pointerToNdc(RECT, 900, 650)!.toArray()).toEqual([1, -1])
    expect(pointerToNdc(RECT, 500, 350)!.toArray()).toEqual([0, 0])
  })

  it('refuses a rect with no layout instead of dividing by zero', () => {
    expect(pointerToNdc({ left: 0, top: 0, width: 0, height: 600 }, 10, 10)).toBeNull()
    expect(pointerToNdc({ left: 0, top: 0, width: 800, height: 0 }, 10, 10)).toBeNull()
  })
})

describe('pickPivotPoint', () => {
  it('returns the point on the tagged body under the cursor', () => {
    const scene = new THREE.Scene()
    scene.add(taggedBody(20))
    const hit = pickPivotPoint(cameraAtOriginLookingDownZ(), scene, RECT, 500, 350)
    expect(hit).not.toBeNull()
    expect(hit!.x).toBeCloseTo(0, 9)
    expect(hit!.y).toBeCloseTo(0, 9)
    expect(hit!.z).toBeCloseTo(20, 9)
  })

  it('takes the nearest tagged body, and ignores untagged ones in front', () => {
    const scene = new THREE.Scene()
    const untagged = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshBasicMaterial())
    untagged.position.set(0, 0, 80)
    scene.add(untagged)
    scene.add(taggedBody(40))
    scene.add(taggedBody(-20))

    const hit = pickPivotPoint(cameraAtOriginLookingDownZ(), scene, RECT, 500, 350)
    expect(hit!.z).toBeCloseTo(40, 9)
  })

  it('ignores a body whose group is hidden, and one clipped away from the cursor', () => {
    const scene = new THREE.Scene()
    const hiddenGroup = new THREE.Group()
    hiddenGroup.visible = false
    hiddenGroup.add(taggedBody(40))
    scene.add(hiddenGroup)
    scene.add(taggedBody(20, 10))

    // The visible body is small and sits on the axis: a press beside it is a
    // miss, even though the hidden body behind it would have caught the ray.
    expect(pickPivotPoint(cameraAtOriginLookingDownZ(), scene, RECT, 560, 350)).toBeNull()
  })

  it('reports a miss for a scene with no tagged body', () => {
    const scene = new THREE.Scene()
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshBasicMaterial()))
    expect(pickPivotPoint(cameraAtOriginLookingDownZ(), scene, RECT, 500, 350)).toBeNull()
  })
})

describe('isShownInScene', () => {
  it('follows the whole parent chain', () => {
    const root = new THREE.Group()
    const middle = new THREE.Group()
    const leaf = new THREE.Object3D()
    middle.add(leaf)
    root.add(middle)
    expect(isShownInScene(leaf)).toBe(true)
    middle.visible = false
    expect(isShownInScene(leaf)).toBe(false)
    expect(isShownInScene(root)).toBe(true)
  })
})
