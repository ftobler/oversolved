import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { projectCursorToSketchPlane } from '../dragMathPlane'
import { worldToSketchLocalPure } from '../coordTransform'
import { makeSanitizedEvent } from '../pointerAbstraction'
import { computeDrawClick, type DrawSnapState } from '../drawLogic'

// End-to-end pure statement of the draw-click contract: a cursor NDC is projected
// onto the sketch plane (math plane, no mesh), sanitized into sketch-local 2D,
// then handed to computeDrawClick -- exactly the path the DrawPlane commit click
// now takes. No React, no R3F, no Viewport.

function makeGroup(position: [number, number, number], quat: THREE.Quaternion): THREE.Group {
  const g = new THREE.Group()
  g.position.fromArray(position)
  g.quaternion.copy(quat)
  g.updateMatrixWorld(true)
  return g
}

function orthoCamera(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-10, 10, 10, -10, -100, 100)
  cam.position.set(0, 0, 50)
  cam.lookAt(0, 0, 0)
  cam.updateMatrixWorld(true)
  cam.updateProjectionMatrix()
  return cam
}

// Project an NDC cursor through the math plane and into a sanitized sketch-local
// 2D point (the pure half of sanitizePointerEvent, no Three.js group ref).
function projectToLocal(
  cam: THREE.Camera,
  group: THREE.Group,
  ndc: { x: number; y: number },
): [number, number] | null {
  const world = projectCursorToSketchPlane(cam, group, ndc)
  if (!world) return null
  const pos = new THREE.Vector3()
  group.getWorldPosition(pos)
  const q = new THREE.Quaternion()
  group.getWorldQuaternion(q)
  const local3d = worldToSketchLocalPure(
    [world.x, world.y, world.z],
    [pos.x, pos.y, pos.z],
    [q.x, q.y, q.z, q.w],
  )
  const san = makeSanitizedEvent(local3d, [0, 0])
  return san ? san.localPoint : null
}

const emptySnap = (): DrawSnapState => ({
  hoveredVertexId: null,
  hoveredVertexPosition: null,
  hoveredSnapKind: null,
  hoveredSelectionId: null,
  drawSnapVertexId: null,
  alignmentSnapPoint: null,
  alignmentSnapKind: null,
  alignmentSnapVertexId: null,
})

let idCounter = 0
const newId = () => `E${++idCounter}`

describe('draw click plane contract', () => {
  // Offset + in-plane rotated plane. Normal stays world +Z so the ortho camera
  // looking down -Z meets it; the offset along Z is what makes [0,0] differ from
  // the document origin.
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 6)
  const group = makeGroup([3, 0, 5], q)
  const cam = orthoCamera()
  const FEATURE = 'S1'

  it('a circle first click on an offset plane lands under the cursor', () => {
    const local = projectToLocal(cam, group, { x: 0.4, y: -0.3 })
    expect(local).not.toBeNull()
    const result = computeDrawClick('circle', [], local!, emptySnap(), FEATURE, newId)
    expect(result.nextDrawPoints).not.toBeNull()
    expect(result.nextDrawPoints![0][0]).toBeCloseTo(local![0], 5)
    expect(result.nextDrawPoints![0][1]).toBeCloseTo(local![1], 5)
  })

  it('a line first click on an offset plane lands under the cursor', () => {
    const local = projectToLocal(cam, group, { x: -0.2, y: 0.6 })
    expect(local).not.toBeNull()
    const result = computeDrawClick('line', [], local!, emptySnap(), FEATURE, newId)
    expect(result.nextDrawPoints).not.toBeNull()
    expect(result.nextDrawPoints![0][0]).toBeCloseTo(local![0], 5)
    expect(result.nextDrawPoints![0][1]).toBeCloseTo(local![1], 5)
  })

  it('the same click with a face hovered lands in the same place', () => {
    const local = projectToLocal(cam, group, { x: 0.4, y: -0.3 })!
    const snap = emptySnap()
    snap.hoveredSelectionId = '?4,4;@bxx@fyy:flatface'
    const faceResult = computeDrawClick('circle', [], local, snap, FEATURE, newId)
    const bareResult = computeDrawClick('circle', [], local, emptySnap(), FEATURE, newId)
    expect(faceResult.nextDrawPoints![0]).toEqual(bareResult.nextDrawPoints![0])
  })

  it('the same click with the origin hovered lands at originLocal, not [0,0]', () => {
    const local = projectToLocal(cam, group, { x: 0.4, y: -0.3 })!
    const snap = emptySnap()
    snap.hoveredVertexPosition = [-37.5, 12.25]
    const result = computeDrawClick('circle', [], local, snap, FEATURE, newId)
    expect(result.nextDrawPoints![0]).toEqual([-37.5, 12.25])
    expect(result.nextDrawPoints![0]).not.toEqual([0, 0])
  })

  it('a circle second click measures its radius from the first click point', () => {
    const first = projectToLocal(cam, group, { x: 0.4, y: -0.3 })!
    const second = projectToLocal(cam, group, { x: -0.2, y: 0.6 })!
    const afterFirst = computeDrawClick('circle', [], first, emptySnap(), FEATURE, newId)
    const result = computeDrawClick('circle', afterFirst.nextDrawPoints!, second, emptySnap(), FEATURE, newId)
    // A wrong first centre would poison the radius; the radius must be the
    // distance between the two real click points.
    const expectedR = Math.hypot(second[0] - first[0], second[1] - first[1])
    expect(result.mutations).toHaveLength(1)
    if (result.mutations[0].type === 'add_entity') {
      expect(result.mutations[0].params[2]).toBeCloseTo(expectedR, 5)
    }
  })
})
