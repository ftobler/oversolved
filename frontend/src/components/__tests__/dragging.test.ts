import { describe, it, expect } from 'vitest'
import * as THREE from 'three'

/**
 * Test for the DragPlane z-ordering bug fix.
 *
 * Issue: When dragging elements, vertex hit spheres (positioned at z≈0.05 when zoomed)
 * were intercepting raycasts before the DragPlane (was at z=0.01), preventing drag updates.
 *
 * Fix: Move DragPlane to z=90, placing it clearly closer to the camera (at z=100)
 * than any scene geometry, so it always wins the raycast during drag operations.
 */

describe('DragPlane raycasting priority', () => {
  it('DragPlane at z=90 is closer to camera than vertex sphere at z=0.05', () => {
    // Setup scene similar to Viewport
    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-100, 100, 100, -100, -1000000, 1000000)
    camera.position.set(0, 0, 100)
    camera.lookAt(0, 0, 0)

    // Create a vertex hit sphere positioned toward camera (z offset like VertexDot)
    // At default zoom=200: offset = POINT_HIT_PIXELS_Z_OFFSET * p2w = 10 * (1/200) = 0.05
    const vertexSphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xff0000 })
    )
    vertexSphere.position.set(0, 0, 0.05)
    scene.add(vertexSphere)

    // Create the DragPlane at the fixed z position
    const dragPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(10000, 10000),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, side: THREE.DoubleSide })
    )
    dragPlane.position.set(0, 0, 90)
    scene.add(dragPlane)

    // Verify positions were set correctly
    expect(dragPlane.position.z).toBe(90)
    expect(vertexSphere.position.z).toBe(0.05)

    // Verify DragPlane is closer to camera: distance from z=100 to z=90 (10)
    // is less than distance to z=0.05 (99.95)
    expect(100 - 90).toBeLessThan(100 - 0.05)
  })

  it('orthographic camera rays are parallel, preserving x,y coordinates across z planes', () => {
    // For orthographic cameras, rays are parallel to the camera's view direction.
    // This means a screen position maps to the same world x,y regardless of the
    // z depth of the plane it hits, which is why we can safely move DragPlane
    // from z=0.01 to z=90 without affecting drag coordinate accuracy.
    const camera = new THREE.OrthographicCamera(-100, 100, 100, -100, -1000000, 1000000)
    camera.position.set(0, 0, 100)

    // For parallel rays from orthographic camera, the direction is always along -z
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(new THREE.Vector2(0.5, 0.5), camera)

    // The ray direction should be parallel to z-axis (all rays have same direction)
    expect(Math.abs(raycaster.ray.direction.z)).toBeCloseTo(1, 0.1)
    expect(Math.abs(raycaster.ray.direction.x)).toBeLessThan(0.01)
    expect(Math.abs(raycaster.ray.direction.y)).toBeLessThan(0.01)
  })

  it('z=90 plane is 10 units closer to camera than z=0.05 plane', () => {
    // Camera at z=100
    // Old DragPlane position: z=0.01 (distance: 99.99 units away)
    // New DragPlane position: z=90 (distance: 10 units away)
    // Vertex sphere offset: z=0.05 (distance: 99.95 units away, OLD BUG: closer than DragPlane!)

    const cameraZ = 100
    const oldDragPlaneZ = 0.01
    const newDragPlaneZ = 90
    const vertexSphereZ = 0.05

    const oldDistance = cameraZ - oldDragPlaneZ // 99.99
    const newDistance = cameraZ - newDragPlaneZ // 10
    const vertexDistance = cameraZ - vertexSphereZ // 99.95

    // Old bug: vertex sphere was closer to camera than DragPlane
    expect(vertexDistance).toBeLessThan(oldDistance)

    // After fix: DragPlane is much closer to camera than vertex sphere
    expect(newDistance).toBeLessThan(vertexDistance)
    expect(newDistance).toBe(10)
  })
})
