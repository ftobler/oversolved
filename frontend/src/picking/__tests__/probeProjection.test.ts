// @vitest-environment node

import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { probeCameraFrom, worldToScreen, sketchToScreen, type SceneProbe } from '../sceneProbe'

/**
 * The probe's projections must agree with the renderer's own camera for the
 * orthographic part viewport. The first test checks the pure math against
 * three.js `Vector3.project` on an orbited, panned camera; the pinned cases
 * below spell out the same answer by hand so a regression cannot hide inside a
 * shared mistake in both implementations.
 */

function probeWith(camera: THREE.OrthographicCamera): SceneProbe {
  return {
    revision: 1,
    camera: probeCameraFrom(camera),
    canvas: { width: 800, height: 600 },
    sketchPlane: null,
    pickables: [],
  }
}

function expectedScreen(camera: THREE.Camera, p: [number, number, number]): [number, number] {
  const v = new THREE.Vector3(p[0], p[1], p[2]).project(camera)
  return [(v.x + 1) / 2 * 800, (1 - v.y) / 2 * 600]
}

describe('worldToScreen', () => {
  it('agrees with three.js projection on an orbited, panned orthographic camera', () => {
    const cam = new THREE.OrthographicCamera(-400, 400, 300, -300, 0.1, 1000)
    cam.position.set(50, 30, 10)
    cam.lookAt(3, -2, 0)
    cam.updateMatrixWorld()
    const probe = probeWith(cam)
    const points: [number, number, number][] = [
      [0, 0, 0], [100, 0, 0], [0, 100, 0], [10, -20, 5], [50, 30, 0],
    ]
    const screens = worldToScreen(probe, points)
    points.forEach((p, i) => {
      const [ex, ey] = expectedScreen(cam, p)
      expect(screens[i]![0]).toBeCloseTo(ex, 6)
      expect(screens[i]![1]).toBeCloseTo(ey, 6)
    })
  })

  it('maps the frustum corners to the canvas corners for a centred camera', () => {
    const cam = new THREE.OrthographicCamera(-400, 400, 300, -300, 0.1, 1000)
    cam.position.set(0, 0, 10)
    cam.updateMatrixWorld()
    const probe = probeWith(cam)
    const screens = worldToScreen(probe, [[0, 0, 0], [400, 300, 0], [-400, -300, 0]])
    expect(screens[0]).toEqual([400, 300])
    expect(screens[1]![0]).toBeCloseTo(800, 10)
    expect(screens[1]![1]).toBeCloseTo(0, 10)
    expect(screens[2]![0]).toBeCloseTo(0, 10)
    expect(screens[2]![1]).toBeCloseTo(600, 10)
  })

  it('applies zoom through the projection matrix', () => {
    const cam = new THREE.OrthographicCamera(-400, 400, 300, -300, 0.1, 1000)
    cam.position.set(0, 0, 10)
    cam.zoom = 2
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld()
    const probe = probeWith(cam)
    const screens = worldToScreen(probe, [[0, 150, 0]])
    expect(screens[0]![0]).toBeCloseTo(400, 10)
    expect(screens[0]![1]).toBeCloseTo(0, 10)
  })

  it('applies a pure camera translation as a screen shift', () => {
    const cam = new THREE.OrthographicCamera(-400, 400, 300, -300, 0.1, 1000)
    cam.position.set(50, 30, 10)
    cam.updateMatrixWorld()
    const probe = probeWith(cam)
    const screens = worldToScreen(probe, [[50, 30, 0]])
    expect(screens[0]![0]).toBeCloseTo(400, 10)
    expect(screens[0]![1]).toBeCloseTo(300, 10)
  })
})

describe('sketchToScreen', () => {
  it('treats a missing sketch plane as the origin XY plane', () => {
    const cam = new THREE.OrthographicCamera(-400, 400, 300, -300, 0.1, 1000)
    cam.position.set(0, 0, 10)
    cam.updateMatrixWorld()
    const probe = probeWith(cam)
    const screens = sketchToScreen(probe, [[0, 0], [400, 300]])
    expect(screens[0]).toEqual([400, 300])
    expect(screens[1]![0]).toBeCloseTo(800, 10)
    expect(screens[1]![1]).toBeCloseTo(0, 10)
  })

  it('maps local axes through the plane transform (Top plane frame)', () => {
    // The kernel's builtin_plane_top frame: x -> world x, y -> world -z,
    // normal -> world y. Local (0, 1) therefore lands at world (0, 0, -1),
    // which from a camera looking down +y reads as one pixel-space step up.
    const cam = new THREE.OrthographicCamera(-400, 400, 300, -300, 0.1, 1000)
    cam.position.set(0, 100, 0)
    cam.lookAt(0, 0, 0)
    cam.updateMatrixWorld()
    const probe = probeWith(cam)
    probe.sketchPlane = {
      rotation: [1, 0, 0, 0, 0, -1, 0, 1, 0],
      origin: [0, 0, 0],
    }
    const screens = sketchToScreen(probe, [[0, 0], [0, 100]])
    const world: [number, number, number][] = [[0, 0, 0], [0, 0, -100]]
    world.forEach((p, i) => {
      const [ex, ey] = expectedScreen(cam, p)
      expect(screens[i]![0]).toBeCloseTo(ex, 6)
      expect(screens[i]![1]).toBeCloseTo(ey, 6)
    })
  })

  it('adds the plane origin after the local axes', () => {
    const cam = new THREE.OrthographicCamera(-400, 400, 300, -300, 0.1, 1000)
    cam.position.set(0, 0, 10)
    cam.updateMatrixWorld()
    const probe = probeWith(cam)
    probe.sketchPlane = {
      rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      origin: [10, 20, 0],
    }
    const screens = sketchToScreen(probe, [[0, 0]])
    expect(screens[0]![0]).toBeCloseTo(410, 10)
    expect(screens[0]![1]).toBeCloseTo(280, 10)
  })
})
