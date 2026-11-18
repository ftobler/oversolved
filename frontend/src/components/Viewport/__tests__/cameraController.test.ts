import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { snapToDirection, alignToFrame, alignToFace, fitToContent, shouldAutoFit, nearestSquareRoll, carriedUp } from '@/components/Viewport/cameraController'
import { TurntableControls } from '@/components/Viewport/turntable'
import type { PartResult } from '@/types/cad'

function makeOrtho() {
  const cam = new THREE.OrthographicCamera(-400, 400, 300, -300, -1000, 1000)
  cam.position.set(50, 60, 100)
  cam.zoom = 7
  cam.updateProjectionMatrix()
  return cam
}

// The real controller, so the camera and its orbit state stay in lockstep the
// way they do in the viewport. A fake `{target, update}` would let the old
// position-plus-lookAt assumptions slip back in untested.
function makeControls(cam = makeOrtho()) {
  return new TurntableControls(cam)
}

describe('cameraController', () => {
  it('snapToDirection points along the direction and preserves distance from origin', () => {
    const cam = makeOrtho()
    const dist = cam.position.length()
    const controls = makeControls(cam)
    snapToDirection(cam, controls, new THREE.Vector3(0, 0, 5))
    expect(cam.position.x).toBeCloseTo(0)
    expect(cam.position.y).toBeCloseTo(0)
    expect(cam.position.z).toBeCloseTo(dist)
    expect(controls.target.toArray()).toEqual([0, 0, 0])
  })

  it('alignToFrame looks down a tilted frame normal at its origin and no-ops on a degenerate one', () => {
    const cam = makeOrtho()
    const controls = makeControls(cam)
    // A sketch on a 45 degree face, away from the world origin: the case the
    // builtin-only lookup could not frame at all.
    const s = Math.SQRT1_2
    alignToFrame(cam, controls, { rotation: [1, 0, 0, 0, s, -s, 0, s, s], origin: [10, 20, 30] })
    expect(cam.position.x).toBeCloseTo(10, 9)
    expect(cam.position.y).toBeCloseTo(20 + 100 * s, 9)
    expect(cam.position.z).toBeCloseTo(30 + 100 * s, 9)
    expect(controls.target.toArray()).toEqual([10, 20, 30])

    const cam2 = makeOrtho()
    const before = cam2.position.toArray()
    alignToFrame(cam2, makeControls(cam2), { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 0], origin: [0, 0, 0] })
    expect(cam2.position.toArray()).toEqual(before)
  })

  it('alignToFace offsets along the normal from the face center and no-ops on a degenerate normal', () => {
    const cam = makeOrtho()
    const controls = makeControls(cam)
    alignToFace(cam, controls, [0, 0, 1], [10, 20, 30])
    expect(cam.position.x).toBeCloseTo(10, 9)
    expect(cam.position.y).toBeCloseTo(20, 9)
    expect(cam.position.z).toBeCloseTo(130, 9)
    expect(controls.target.toArray()).toEqual([10, 20, 30])

    const cam2 = makeOrtho()
    const before = cam2.position.toArray()
    alignToFace(cam2, makeControls(cam2), [0, 0, 0], [1, 2, 3])
    expect(cam2.position.toArray()).toEqual(before)
  })

  it('fitToContent returns false with no geometry and true once body vertices are present', () => {
    const cam = makeOrtho()
    expect(fitToContent(cam, makeControls(cam), {}, null)).toBe(false)

    const parts: Record<string, PartResult> = {
      a: { mesh: { vertices: new Float32Array([-10, -10, -10, 10, 10, 10]) } } as unknown as PartResult,
    }
    const fit = fitToContent(cam, makeControls(cam), parts, null)
    expect(fit).toBe(true)
    expect(cam.zoom).toBeGreaterThan(0)
    expect(Number.isFinite(cam.zoom)).toBe(true)
  })

  it('fits tuple (array) vertex data, not only Float32Array', () => {
    const cam = makeOrtho()
    const parts: Record<string, PartResult> = {
      a: { mesh: { vertices: [[-10, -10, -10], [10, 10, 10]] } } as unknown as PartResult,
    }
    expect(fitToContent(cam, makeControls(cam), parts, null)).toBe(true)
    expect(Number.isFinite(cam.zoom)).toBe(true)
    expect(cam.zoom).toBeGreaterThan(0)
  })

  it('fit moves the target to the content centre without changing the view direction', () => {
    const cam = makeOrtho()
    const controls = makeControls(cam)
    controls.azimuth = 0.42
    controls.elevation = 0.31
    controls.update()
    const directionBefore = cam.position.clone().sub(controls.target).normalize()
    const parts: Record<string, PartResult> = {
      a: { mesh: { vertices: new Float32Array([90, 90, 90, 110, 110, 110]) } } as unknown as PartResult,
    }
    expect(fitToContent(cam, controls, parts, null)).toBe(true)
    expect(controls.target.toArray()).toEqual([100, 100, 100])
    const directionAfter = cam.position.clone().sub(controls.target).normalize()
    expect(directionAfter.x).toBeCloseTo(directionBefore.x, 9)
    expect(directionAfter.y).toBeCloseTo(directionBefore.y, 9)
    expect(directionAfter.z).toBeCloseTo(directionBefore.z, 9)
  })

  it('scene fallback measures only fitBounds-tagged meshes and is stable on repeat (no oscillation)', () => {
    const cam = makeOrtho()
    const scene = new THREE.Scene()

    // A fixed-size plane quad (what the real PlaneSurface tags). Zoom-independent.
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(50, 50))
    plane.userData.fitBounds = true
    scene.add(plane)

    // An untagged screen-scaled helper: a small mesh whose world size tracks the
    // current zoom (const/zoom), exactly like markers/labels/dimensions. If the
    // fit measured this, every press would change zoom and re-measure it.
    const helper = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
    const syncHelper = () => { helper.scale.setScalar(400 / cam.zoom); helper.updateMatrixWorld() }
    syncHelper()
    scene.add(helper)
    scene.updateMatrixWorld(true)

    const controls = makeControls(cam)
    expect(fitToContent(cam, controls, {}, scene)).toBe(true)
    const zoomAfterFirst = cam.zoom

    // Second press: the helper would have resized if it were measured. Re-sync it
    // and fit again - a stable fit lands on the same zoom (fixed point).
    syncHelper()
    expect(fitToContent(cam, controls, {}, scene)).toBe(true)
    expect(cam.zoom).toBeCloseTo(zoomAfterFirst, 6)
  })
})

// fitToContent owns the clip planes because a fixed range cannot serve both
// ends: wide enough for a large model makes the depth-buffer resolution unit
// coarse, and Part3D's polygonOffsetUnits=1 is one such unit, so the edge/face
// separation grows into a visible penetration depth that makes small parts
// transparent. Sized to the content, neither end has to lose.
describe('fitToContent clip planes', () => {
  function boxPart(cx: number, cy: number, cz: number, half: number): Record<string, PartResult> {
    return {
      a: {
        mesh: {
          vertices: new Float32Array([cx - half, cy - half, cz - half, cx + half, cy + half, cz + half]),
        },
      } as unknown as PartResult,
    }
  }

  // Depth along the view axis, the axis near/far are measured on.
  function depthOf(cam: THREE.OrthographicCamera, p: [number, number, number]): number {
    cam.updateMatrixWorld()
    return -new THREE.Vector3(...p).applyMatrix4(cam.matrixWorldInverse).z
  }

  function cornersOf(cx: number, cy: number, cz: number, half: number): [number, number, number][] {
    const out: [number, number, number][] = []
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      out.push([cx + sx * half, cy + sy * half, cz + sz * half])
    }
    return out
  }

  it('keeps the range tight for a small model so the polygon offset stays invisible', () => {
    const cam = makeOrtho()
    expect(fitToContent(cam, makeControls(cam), boxPart(0, 0, 0, 10), null)).toBe(true)
    expect(cam.far - cam.near).toBeLessThanOrEqual(1500)
  })

  it('clips neither end of a model far deeper than any fixed range', () => {
    const cam = makeOrtho()
    expect(fitToContent(cam, makeControls(cam), boxPart(0, 0, 0, 10000), null)).toBe(true)
    for (const corner of cornersOf(0, 0, 0, 10000)) {
      const depth = depthOf(cam, corner)
      expect(depth).toBeGreaterThan(cam.near)
      expect(depth).toBeLessThan(cam.far)
    }
  })

  it('keeps the world origin visible when the model sits far from it', () => {
    const cam = makeOrtho()
    expect(fitToContent(cam, makeControls(cam), boxPart(0, 0, 3000, 10), null)).toBe(true)
    const originDepth = depthOf(cam, [0, 0, 0])
    expect(originDepth).toBeGreaterThan(cam.near)
    expect(originDepth).toBeLessThan(cam.far)
  })

  it('does not let the origin drag the framing away from the model', () => {
    const atOrigin = makeOrtho()
    fitToContent(atOrigin, makeControls(atOrigin), boxPart(0, 0, 0, 10), null)

    // Same model, moved far off. The origin counts for depth only, so zoom -
    // which is decided by the lateral extents - must not change.
    const farOff = makeOrtho()
    fitToContent(farOff, makeControls(farOff), boxPart(3000, 3000, 0, 10), null)
    expect(farOff.zoom).toBeCloseTo(atOrigin.zoom, 6)
  })
})

describe('shouldAutoFit', () => {
  it('fits once geometry has arrived and stops once it has succeeded', () => {
    expect(shouldAutoFit(false, 0, false)).toBe(false)  // nothing to frame yet
    expect(shouldAutoFit(false, 2, false)).toBe(true)
    expect(shouldAutoFit(true, 2, false)).toBe(false)
  })

  // The regression: a live drag tick replaces the whole `bodies` record, so an
  // auto-fit that never succeeded (zero-sized frustum, geometry not yet meshed)
  // re-armed on every tick and reframed the camera mid-gesture.
  it('never fits while a part is being manipulated', () => {
    expect(shouldAutoFit(false, 2, true)).toBe(false)
  })

  it('nearestSquareRoll: looking down lands on the nearest cardinal mark', () => {
    const dir = new THREE.Vector3(0, 1, 0)
    const deg = (d: number) => (d * Math.PI) / 180
    for (const [angleDeg, expectedAz] of [[37, 0], [50, Math.PI / 2], [190, Math.PI]] as [number, number][]) {
      const a = deg(angleDeg)
      const up = new THREE.Vector3(-Math.sin(a), 0, -Math.cos(a))
      const pose = nearestSquareRoll(up, dir)
      expect(pose.azimuth).toBeCloseTo(expectedAz, 9)
      expect(pose.elevation).toBeCloseTo(Math.PI / 2, 9)
      expect(pose.roll).toBeCloseTo(0, 9)
    }
  })

  it('nearestSquareRoll: looking up uses the mirrored law', () => {
    const dir = new THREE.Vector3(0, -1, 0)
    const pose = nearestSquareRoll(new THREE.Vector3(0, 0, 1), dir)
    expect(Math.hypot(pose.azimuth % (Math.PI / 2), 0)).toBeLessThan(1e-9)
    // view direction equals the normal
    expect(pose.elevation).toBeCloseTo(-Math.PI / 2, 9)
  })

  it('nearestSquareRoll: a side face snaps roll to the nearest quarter turn', () => {
    const dir = new THREE.Vector3(0, 0, 1)
    const mkUp = (roll: number) => new THREE.Vector3(-Math.sin(roll), Math.cos(roll), 0)
    const pA = nearestSquareRoll(mkUp(0.349), dir)
    expect(pA.roll).toBeCloseTo(0, 9)
    const pB = nearestSquareRoll(mkUp(1.396), dir)
    expect(pB.roll).toBeCloseTo(Math.PI / 2, 9)
  })

  it('nearestSquareRoll: an oblique face with roll 0 stays upright and keeps its direction', () => {
    const dir = new THREE.Vector3(1, 1, 0).normalize()
    const baseAz = Math.atan2(dir.x, dir.z)
    const baseEl = Math.atan2(dir.y, Math.hypot(dir.x, dir.z))
    const up = new THREE.Vector3(-Math.sin(baseAz) * Math.sin(baseEl), Math.cos(baseEl), -Math.cos(baseAz) * Math.sin(baseEl))
    // that's orbitUp(baseAz, baseEl) already; roll 0 basis up = orbitUp
    const pose = nearestSquareRoll(up, dir)
    expect(pose.roll).toBeCloseTo(0, 9)
    expect(pose.azimuth).toBeCloseTo(baseAz, 9)
    expect(pose.elevation).toBeCloseTo(baseEl, 9)
  })

  it('nearestSquareRoll: old up along the new view direction takes k = 0', () => {
    const dir = new THREE.Vector3(0, 1, 0)
    const pose = nearestSquareRoll(new THREE.Vector3(0, 1, 0), dir)
    expect(pose.azimuth).toBeCloseTo(0, 9)
    expect(pose.elevation).toBeCloseTo(Math.PI / 2, 9)
    expect(pose.roll).toBeCloseTo(0, 9)
  })

  it('nearestSquareRoll: the chosen pose view direction equals the face normal exactly', () => {
    const dirs = [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 1, 0).normalize(), new THREE.Vector3(1, 2, 3).normalize()]
    for (const d of dirs) {
      const pose = nearestSquareRoll(new THREE.Vector3(0, 1, 0), d)
      // reconstruct direction from azimuth/elevation
      const x = Math.cos(pose.elevation) * Math.sin(pose.azimuth)
      const y = Math.sin(pose.elevation)
      const z = Math.cos(pose.elevation) * Math.cos(pose.azimuth)
      expect(x).toBeCloseTo(d.x, 9)
      expect(y).toBeCloseTo(d.y, 9)
      expect(z).toBeCloseTo(d.z, 9)
    }
  })
})

// The snap law needs the up the user had, moved to the new view without
// resetting it. Carrying it by the shortest rotation is what a physical camera
// tilt does; projecting it instead degenerates exactly on the common 90 degree
// tip, where the old up lies along the new view axis.
describe('carriedUp', () => {
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

  it('carries the front view up onto the canonical top view', () => {
    const up = carriedUp(V(0, 1, 0), V(0, 0, 1), V(0, 1, 0))
    expect(up.x).toBeCloseTo(0, 12)
    expect(up.y).toBeCloseTo(0, 12)
    expect(up.z).toBeCloseTo(-1, 12)
  })

  it('keeps a 90 degree rolled front view rolled when tipping to the top', () => {
    const up = carriedUp(V(-1, 0, 0), V(0, 0, 1), V(0, 1, 0))
    expect(Math.abs(up.y)).toBeLessThan(1e-12)
    expect(up.x).toBeCloseTo(-1, 12)
    expect(up.z).toBeCloseTo(0, 12)
  })

  it('keeps the up through the antipodal front to back flip', () => {
    const up = carriedUp(V(0, 1, 0), V(0, 0, 1), V(0, 0, -1))
    expect(up.x).toBeCloseTo(0, 12)
    expect(up.y).toBeCloseTo(1, 12)
    expect(up.z).toBeCloseTo(0, 12)
  })

  it('always lands perpendicular to the new direction', () => {
    // A seeded sweep, so a failure is reproducible rather than a once-in-a-
    // thousand CI surprise.
    let state = 0x5eed
    const rand = () => {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0
      return state / 0x100000000
    }
    const randomDirection = () => {
      const z = rand() * 2 - 1
      const a = rand() * Math.PI * 2
      const r = Math.sqrt(1 - z * z)
      return V(r * Math.cos(a), z, r * Math.sin(a))
    }
    for (let i = 0; i < 64; i++) {
      const oldDir = randomDirection()
      const newDir = randomDirection()
      // Any unit vector perpendicular to oldDir is a legitimate screen up.
      const seed = randomDirection()
      seed.addScaledVector(oldDir, -seed.dot(oldDir)).normalize()
      const up = carriedUp(seed, oldDir, newDir)
      expect(up.length()).toBeCloseTo(1, 9)
      expect(up.dot(newDir)).toBeCloseTo(0, 9)
    }
  })
})
