import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { worldUnitsPerPixel } from '@/picking/screenSpaceScale'
import { buildPlaneMatrix } from '@/picking/idRegistrationUtils'
import {
  linearLabelAlongWorldPerPixel, linearLabelAngleDeg, linearLabelWorldPerPixel,
} from '../labelScreenAngle'
import type { PlaneTransform } from '@/types/cad'

/**
 * The two screen facts a linear dimension's label needs, against real cameras
 * in a node test: the rotation that follows the line, and the world size of a
 * CSS pixel for the gap around the text. The viewport's camera is orthographic,
 * but the helpers also carry the perspective branch (depth-dependent pixels),
 * so both are pinned here.
 */

const IDENTITY = new THREE.Matrix4()

function ortho(zoom = 1): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-400, 400, 300, -300, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)
  camera.zoom = zoom
  camera.updateMatrixWorld(true)
  camera.updateProjectionMatrix()
  return camera
}

function perspective(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  camera.updateProjectionMatrix()
  return camera
}

describe('linearLabelWorldPerPixel', () => {
  it('matches worldUnitsPerPixel for the orthographic viewport camera', () => {
    const camera = ortho()
    const got = linearLabelWorldPerPixel(camera, 600, IDENTITY, 0, 0)

    expect(got).toBeCloseTo(worldUnitsPerPixel(camera.projectionMatrix.elements[5], 600, 1), 10)
    // Frustum height 600 over a 600 px canvas at zoom 1, the p2w identity.
    expect(got).toBeCloseTo(1, 10)
  })

  it('halves the world per pixel at zoom 2', () => {
    const atOne = linearLabelWorldPerPixel(ortho(1), 600, IDENTITY, 0, 0)
    const atTwo = linearLabelWorldPerPixel(ortho(2), 600, IDENTITY, 0, 0)

    expect(atTwo).toBeCloseTo(atOne / 2, 10)
  })

  it('scales with the label depth under a perspective camera', () => {
    const camera = perspective()
    const atOrigin = linearLabelWorldPerPixel(camera, 600, IDENTITY, 0, 0)
    // The same label lifted 5 units toward the camera along its view axis:
    // half the world per pixel.
    const closer = linearLabelWorldPerPixel(camera, 600, new THREE.Matrix4().makeTranslation(0, 0, 5), 0, 0)

    // clipW at the origin is the camera distance, 10.
    expect(atOrigin).toBeCloseTo(worldUnitsPerPixel(camera.projectionMatrix.elements[5], 600, 10), 10)
    expect(closer).toBeCloseTo(atOrigin / 2, 10)
  })

  it('returns zero, never NaN, for a label at or behind the camera', () => {
    const camera = perspective()
    // World z = 20 is behind a camera sitting at z = 10.
    const behind = new THREE.Matrix4().makeTranslation(0, 0, 20)
    const got = linearLabelWorldPerPixel(camera, 600, behind, 0, 0)

    expect(got).toBe(0)
    expect(Number.isFinite(got)).toBe(true)
    // Exactly at the eye is the same story.
    expect(linearLabelWorldPerPixel(camera, 600, new THREE.Matrix4().makeTranslation(0, 0, 10), 0, 0)).toBe(0)
  })

  it('returns zero for a camera stand-in with no projection matrices', () => {
    const stand = { isOrthographicCamera: true, zoom: 1 } as unknown as THREE.Camera

    expect(linearLabelWorldPerPixel(stand, 600, IDENTITY, 0, 0)).toBe(0)
    expect(linearLabelAngleDeg(stand, 800, 600, IDENTITY, 0, 0, 10, 0)).toBeNull()
  })
})

describe('linearLabelAngleDeg', () => {
  it('reads a line in the plane as its screen slope', () => {
    // Front view, 800 x 600 canvas: the line rises to the right, so CSS rotate
    // is negative.
    expect(linearLabelAngleDeg(ortho(), 800, 600, IDENTITY, 0, 0, 10, 5)).toBeCloseTo(-26.565, 3)
    expect(linearLabelAngleDeg(ortho(), 800, 600, IDENTITY, 0, 0, 10, -5)).toBeCloseTo(26.565, 3)
  })

  it('keeps the angle when the camera zooms, since the slope does not change', () => {
    expect(linearLabelAngleDeg(ortho(2), 800, 600, IDENTITY, 0, 0, 10, 5))
      .toBeCloseTo(linearLabelAngleDeg(ortho(1), 800, 600, IDENTITY, 0, 0, 10, 5)!, 10)
  })

  it('applies the sketch plane matrix before projecting', () => {
    // Rotate the plane 90 degrees about Z: a line along plane +X now runs along
    // world +Y, which is vertical on a front view. The fold pins that to -90.
    const plane = new THREE.Matrix4().makeRotationZ(Math.PI / 2)

    expect(linearLabelAngleDeg(ortho(), 800, 600, plane, 0, 0, 10, 0)).toBe(-90)
  })

  it('returns null for a line wholly behind a perspective camera, never NaN', () => {
    const camera = perspective()
    // Move the sketch plane 20 units toward +Z: both endpoints sit behind the
    // camera at z = 10.
    const behind = new THREE.Matrix4().makeTranslation(0, 0, 20)
    const got = linearLabelAngleDeg(camera, 800, 600, behind, 0, 0, 10, 0)

    expect(got).toBeNull()
  })

  it('returns null for a line that straddles the perspective eye', () => {
    const camera = perspective()
    // Rotate the plane about X: local Y climbs into +Z, so one endpoint sits in
    // front of the camera at z = 10 and the other behind it.
    const straddle = new THREE.Matrix4().makeRotationX(Math.PI / 2)
    const got = linearLabelAngleDeg(camera, 800, 600, straddle, 0, 0, 0, 20)

    expect(got).toBeNull()
    expect(linearLabelAlongWorldPerPixel(camera, 800, 600, straddle, 0, 0, 0, 20)).toBe(0)
  })

  it('returns null for a zero-sized viewport instead of dividing by it', () => {
    expect(linearLabelAngleDeg(ortho(), 0, 600, IDENTITY, 0, 0, 10, 0)).toBeNull()
    expect(linearLabelAngleDeg(ortho(), 800, 0, IDENTITY, 0, 0, 10, 0)).toBeNull()
  })
})

describe('linearLabelAlongWorldPerPixel', () => {
  // A sketch plane tilted about its local X: local Y climbs into +Z, so a front
  // camera sees a local-Y line foreshortened by cos(tilt).
  function tiltedPlane(deg: number): PlaneTransform {
    const rad = (deg * Math.PI) / 180
    const c = Math.cos(rad), s = Math.sin(rad)
    return { rotation: [1, 0, 0, 0, c, s, 0, -s, c], origin: [0, 0, 0] }
  }

  it('matches the isotropic scale when the line runs across the view', () => {
    // Flat plane, a line along world X: 200 world units project to 200 px.
    expect(linearLabelAlongWorldPerPixel(ortho(), 800, 600, IDENTITY, 0, 0, 200, 0)).toBeCloseTo(1, 10)
  })

  it('grows by 1 / cos(tilt) when the line is foreshortened', () => {
    const plane = buildPlaneMatrix(tiltedPlane(45))
    const along = linearLabelAlongWorldPerPixel(ortho(), 800, 600, plane, 10, 0, 10, 300)
    const isotropic = linearLabelWorldPerPixel(ortho(), 600, plane, 10, 150)

    // 300 world units project to 300 / sqrt(2) px.
    expect(along).toBeCloseTo(Math.SQRT2, 6)
    // The depth scale is unchanged: this is exactly the wrong factor, and the
    // reason the cut used to undershoot on a tilted plane.
    expect(isotropic).toBeCloseTo(1, 10)
  })

  it('returns zero for a zero-length line instead of dividing by it', () => {
    expect(linearLabelAlongWorldPerPixel(ortho(), 800, 600, IDENTITY, 5, 5, 5, 5)).toBe(0)
  })

  it('returns zero for a camera that cannot project', () => {
    const stand = { isOrthographicCamera: true, zoom: 1 } as unknown as THREE.Camera
    expect(linearLabelAlongWorldPerPixel(stand, 800, 600, IDENTITY, 0, 0, 10, 0)).toBe(0)
  })
})
