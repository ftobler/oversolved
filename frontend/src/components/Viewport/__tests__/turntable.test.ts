import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  TurntableControls,
  anglesFromDirection,
  gestureForButton,
  MOUSE_BUTTONS,
  orbitDirection,
  orbitForward,
  orbitRight,
  orbitUp,
  poseQuaternion,
  rightButtonMapping,
  rotateOrbit,
  rotateTrackball,
  snapshotTurntablePose,
  restoreTurntablePose,
  turnAbout,
} from '@/components/Viewport/turntable'
import { pickPivotPoint } from '@/components/Viewport/pivotPick'
import { alignToFace, alignToFrame, snapToDirection } from '@/components/Viewport/cameraController'

// The pure half of the orbit law plus the controller against a real camera.
// No R3F scene: the camera and a detached canvas are all these cases need.

function makeCamera(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-400, 400, 300, -300, -1000, 1000)
  cam.position.set(20, 20, 100)
  cam.updateProjectionMatrix()
  return cam
}

function makeControls(camera = makeCamera()): TurntableControls {
  return new TurntableControls(camera)
}

// jsdom canvases have no layout; the controller falls back to 1px, which would
// make every drag a huge angle. Give it a viewport size so the angle-per-pixel
// matches a real one.
function makeElement(width = 800, height = 600): HTMLCanvasElement {
  const el = document.createElement('canvas')
  Object.defineProperty(el, 'clientWidth', { value: width })
  Object.defineProperty(el, 'clientHeight', { value: height })
  return el
}

function press(el: Element | Document, type: string, init: MouseEventInit = {}): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
}

function wheel(el: Element, deltaY: number): void {
  el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY }))
}

// jsdom has no PointerEvent, and its MouseEvent carries neither pointerType nor
// pointerId; both are what route a press to the touch gesture.
function touch(el: Element | Document, type: string, init: MouseEventInit & { pointerId?: number } = {}): void {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(e, 'pointerType', { value: 'touch' })
  Object.defineProperty(e, 'pointerId', { value: init.pointerId ?? 1 })
  el.dispatchEvent(e)
}

function screenX(camera: THREE.Camera, point: THREE.Vector3): number {
  camera.updateMatrixWorld()
  ;(camera as THREE.OrthographicCamera).updateProjectionMatrix()
  return point.clone().project(camera).x
}

function localAxis(camera: THREE.Camera, axis: THREE.Vector3): THREE.Vector3 {
  return axis.clone().applyQuaternion(camera.quaternion)
}

// Deterministic LCG: property tests must fail reproducibly, not once in a
// thousand CI runs.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

describe('turntable pose math', () => {
  it('keeps the camera right vector horizontal for any azimuth and elevation, including inverted and multi-turn', () => {
    const random = seededRandom(0x5eed)
    const camera = makeCamera()
    const controls = new TurntableControls(camera)

    for (let i = 0; i < 400; i++) {
      const azimuth = (random() * 40 - 20) * Math.PI
      const elevation = (random() * 20 - 10) * Math.PI
      controls.azimuth = azimuth
      controls.elevation = elevation
      controls.update()

      const right = localAxis(camera, new THREE.Vector3(1, 0, 0))
      expect(Math.abs(right.y)).toBeLessThan(1e-12)
      expect(right.length()).toBeCloseTo(1, 12)
    }
  })

  it('continues the elevation past a pole with no clamp and a continuous pose', () => {
    const camera = makeCamera()
    const controls = makeControls(camera)
    const el = makeElement()
    controls.connect(el)

    controls.azimuth = 0.3
    controls.elevation = 0
    controls.update()

    // A full-height drag is half a turn; 0.6 of the height takes the elevation
    // to 0.6*pi, well past the orbit controls' old pi/2 stop.
    press(el, 'pointerdown', { button: 2, clientX: 400, clientY: 200 })
    press(document, 'pointermove', { clientX: 400, clientY: 380 })
    press(document, 'pointerup', { clientX: 400, clientY: 380 })
    expect(controls.elevation).toBeGreaterThan(Math.PI / 2)

    // Walk through the pole in small steps: the position and the up vector must
    // never jump, and no component may go non-finite.
    controls.azimuth = 0.3
    controls.elevation = Math.PI / 2 - 0.2
    controls.update()
    let previous = {
      position: camera.position.clone(),
      up: localAxis(camera, new THREE.Vector3(0, 1, 0)),
    }
    const steps = 200
    const dy = (0.4 / (2 * Math.PI)) * 600 / steps
    for (let i = 0; i < steps; i++) {
      const next = rotateOrbit(controls, 0, dy, 600)
      controls.azimuth = next.azimuth
      controls.elevation = next.elevation
      controls.update()
      const position = camera.position.clone()
      const up = localAxis(camera, new THREE.Vector3(0, 1, 0))
      expect(Number.isFinite(position.x + position.y + position.z)).toBe(true)
      expect(Number.isFinite(up.x + up.y + up.z)).toBe(true)
      // distance 103.9 * 0.002 rad per step is ~0.2; allow a little slack.
      expect(position.distanceTo(previous.position)).toBeLessThan(0.4)
      expect(up.distanceTo(previous.up)).toBeLessThan(0.02)
      previous = { position, up }
    }
    expect(controls.elevation).toBeGreaterThan(Math.PI / 2)
  })

  it('defines up = right x forward as an orthonormal basis exactly at the pole, with no NaN', () => {
    const azimuths = [0, 0.4, -1.7, Math.PI / 2, Math.PI, 7.3]
    for (const azimuth of azimuths) {
      for (const elevation of [Math.PI / 2, -Math.PI / 2]) {
        const direction = orbitDirection(azimuth, elevation)
        const right = orbitRight(azimuth)
        const forward = orbitForward(azimuth, elevation)
        const up = orbitUp(azimuth, elevation)

        expect(up.length()).toBeCloseTo(1, 12)
        expect(up.dot(right)).toBeCloseTo(0, 12)
        expect(up.dot(forward)).toBeCloseTo(0, 12)
        expect([up.x, up.y, up.z].every(Number.isFinite)).toBe(true)
        // The basis relation the controller draws with.
        expect(up.x).toBeCloseTo(right.y * forward.z - right.z * forward.y, 12)
        expect(up.y).toBeCloseTo(right.z * forward.x - right.x * forward.z, 12)
        expect(up.z).toBeCloseTo(right.x * forward.y - right.y * forward.x, 12)
        expect(direction.length()).toBeCloseTo(1, 12)
        // Right is a horizontal axis even looking straight down/up.
        expect(right.y).toBe(0)
      }
    }
  })

  it('inverts the horizontal drag direction when the view is upside down so the model follows the cursor', () => {
    const camera = makeCamera()
    const controls = makeControls(camera)
    const el = makeElement()
    controls.connect(el)

    const dragRight = () => {
      press(el, 'pointerdown', { button: 2, clientX: 400, clientY: 300 })
      press(document, 'pointermove', { clientX: 460, clientY: 300 })
      press(document, 'pointerup', { clientX: 460, clientY: 300 })
    }

    // Upright front view: a point between the camera and the target is the
    // visible face, and it moves right when the user drags right.
    controls.azimuth = 0
    controls.elevation = 0
    controls.update()
    const frontPoint = new THREE.Vector3(0, 0, 10)
    const uprightBefore = screenX(camera, frontPoint)
    dragRight()
    expect(controls.azimuth).toBeLessThan(0)
    expect(screenX(camera, frontPoint)).toBeGreaterThan(uprightBefore)

    // Inverted view (camera under the model, screen up is -Y). The visible
    // face is the other side, and it must move the same screen direction.
    controls.azimuth = 0
    controls.elevation = Math.PI
    controls.update()
    const backPoint = new THREE.Vector3(0, 0, -10)
    const invertedBefore = screenX(camera, backPoint)
    dragRight()
    expect(controls.azimuth).toBeGreaterThan(0)
    expect(screenX(camera, backPoint)).toBeGreaterThan(invertedBefore)
  })
})

describe('camera alignment on the turntable state', () => {
  it('gives every axis frame its view direction and puts a pole frame\'s y axis up the screen', () => {
    // Rows are x axis, y axis, normal. Side frames keep the level horizon (up
    // +Y); a frame facing straight up or down has a free roll, which the
    // frame's own y axis decides.
    const cases: Array<[string, number[], [number, number, number], [number, number, number]]> = [
      ['front', [1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 100], [0, 1, 0]],
      ['back', [-1, 0, 0, 0, 1, 0, 0, 0, -1], [0, 0, -100], [0, 1, 0]],
      ['right', [0, 0, -1, 0, 1, 0, 1, 0, 0], [100, 0, 0], [0, 1, 0]],
      ['left', [0, 0, 1, 0, 1, 0, -1, 0, 0], [-100, 0, 0], [0, 1, 0]],
      // Top has the Front plane at the bottom of the screen: screen up is -Z.
      ['top', [1, 0, 0, 0, 0, -1, 0, 1, 0], [0, 100, 0], [0, 0, -1]],
      // Bottom mirrors it.
      ['bottom', [1, 0, 0, 0, 0, 1, 0, -1, 0], [0, -100, 0], [0, 0, 1]],
      // A sketch on a -Y face (x -> -X, y -> -Z): seen from below, still y up.
      ['-Y face', [-1, 0, 0, 0, 0, -1, 0, -1, 0], [0, -100, 0], [0, 0, -1]],
      // A sketch on a top face turned a quarter: its y axis is +X, so is up.
      ['turned top', [0, 0, 1, 1, 0, 0, 0, 1, 0], [0, 100, 0], [1, 0, 0]],
    ]
    for (const [name, rotation, position, screenUp] of cases) {
      const camera = makeCamera()
      const controls = makeControls(camera)
      // A leftover azimuth must not leak into a pole frame's roll.
      controls.azimuth = 2.4
      controls.update()
      alignToFrame(camera, controls, { rotation, origin: [0, 0, 0] })
      expect(camera.position.x, name).toBeCloseTo(position[0], 9)
      expect(camera.position.y, name).toBeCloseTo(position[1], 9)
      expect(camera.position.z, name).toBeCloseTo(position[2], 9)
      const up = localAxis(camera, new THREE.Vector3(0, 1, 0))
      expect(up.x, name).toBeCloseTo(screenUp[0], 12)
      expect(up.y, name).toBeCloseTo(screenUp[1], 12)
      expect(up.z, name).toBeCloseTo(screenUp[2], 12)
      expect(Number.isFinite(up.x + up.y + up.z), name).toBe(true)
    }
  })

  it('keeps the current azimuth when aligning to a horizontal face', () => {
    const camera = makeCamera()
    const controls = makeControls(camera)
    controls.azimuth = 1.1
    controls.elevation = 0.2
    controls.update()

    alignToFace(camera, controls, [0, 1, 0], [1, 2, 3])

    expect(controls.azimuth).toBeCloseTo(1.1, 12)
    expect(controls.elevation).toBeCloseTo(Math.PI / 2, 12)
    expect(controls.target.toArray()).toEqual([1, 2, 3])
    expect(camera.position.x).toBeCloseTo(1, 9)
    expect(camera.position.y).toBeCloseTo(102, 9)
    expect(camera.position.z).toBeCloseTo(3, 9)
  })

  it('snaps a cube top click to the canonical top roll, not the leftover azimuth', () => {
    const camera = makeCamera()
    const controls = makeControls(camera)
    controls.azimuth = 2.4
    controls.elevation = 0.1
    controls.update()

    snapToDirection(camera, controls, new THREE.Vector3(0, 1, 0))

    expect(controls.azimuth).toBeCloseTo(0, 12)
    const up = localAxis(camera, new THREE.Vector3(0, 1, 0))
    expect(up.toArray().map(v => Math.round(v * 1e9) / 1e9)).toEqual([0, 0, -1])
  })
})

describe('pan and zoom', () => {
  it('pans the target in the camera right/up plane and leaves the distance alone', () => {
    const camera = makeCamera()
    const controls = makeControls(camera)
    const el = makeElement()
    controls.connect(el)
    controls.azimuth = 0.7
    controls.elevation = 1.2
    controls.update()
    const beforeTarget = controls.target.clone()
    const beforeDistance = controls.distance
    const direction = orbitDirection(controls.azimuth, controls.elevation)

    press(el, 'pointerdown', { button: 1, clientX: 400, clientY: 300 })
    press(document, 'pointermove', { clientX: 430, clientY: 280 })
    press(document, 'pointerup', { clientX: 430, clientY: 280 })

    expect(controls.target.distanceTo(beforeTarget)).toBeGreaterThan(0)
    // The target moved only within the view plane: no component along the view
    // axis, so the distance from the camera is unchanged.
    expect(controls.target.clone().sub(beforeTarget).dot(direction)).toBeCloseTo(0, 9)
    expect(controls.distance).toBeCloseTo(beforeDistance, 12)
  })

  it('zooms only the ortho projection, never the target or the orbit distance', () => {
    const camera = makeCamera()
    const controls = makeControls(camera)
    const el = makeElement()
    controls.connect(el)
    controls.azimuth = 0.2
    controls.elevation = 0.4
    controls.update()
    const zoomBefore = camera.zoom
    const positionBefore = camera.position.clone()
    const targetBefore = controls.target.clone()

    wheel(el, -100)

    expect(camera.zoom).toBeGreaterThan(zoomBefore)
    expect(controls.target.toArray()).toEqual(targetBefore.toArray())
    expect(camera.position.toArray()).toEqual(positionBefore.toArray())
  })

  it('keeps the ortho camera rotation matrix in step with the pose (ID picking reads it)', () => {
    const camera = makeCamera()
    const controls = makeControls(camera)
    controls.azimuth = -0.9
    controls.elevation = 2.2
    controls.update()
    expect(camera.matrixWorld.elements.slice(12, 15)).toEqual(camera.position.toArray())
  })
})

describe('mouse bindings', () => {
  const noMods = { shiftKey: false, ctrlKey: false, metaKey: false }

  it('keeps the viewport table: left does nothing, middle pans, right rotates', () => {
    expect(MOUSE_BUTTONS.LEFT).toBeNull()
    expect(MOUSE_BUTTONS.MIDDLE).toBe('pan')
    expect(MOUSE_BUTTONS.RIGHT).toBe('rotate')
    expect(gestureForButton(0, noMods)).toBeNull()
    expect(gestureForButton(1, noMods)).toBe('pan')
    expect(gestureForButton(2, noMods)).toBe('rotate')
    expect(gestureForButton(3, noMods)).toBeNull()
  })

  it('maps shift to dolly and ctrl/meta to pan on the right button', () => {
    expect(rightButtonMapping({ ...noMods, shiftKey: true })).toBe('dolly')
    expect(rightButtonMapping({ ...noMods, ctrlKey: true })).toBe('pan')
    expect(rightButtonMapping({ ...noMods, metaKey: true })).toBe('pan')
    expect(rightButtonMapping(noMods)).toBe('rotate')
  })

  it('re-evaluates the mapping on every press so a modifier does not stick', () => {
    expect(gestureForButton(2, { ...noMods, shiftKey: true })).toBe('dolly')
    expect(gestureForButton(2, noMods)).toBe('rotate')
  })

  it('cancels a camera press but leaves the left button to selection', () => {
    const camera = makeCamera()
    const controls = makeControls(camera)
    const el = makeElement()
    controls.connect(el)

    const right = new MouseEvent('pointerdown', { button: 2, bubbles: true, cancelable: true })
    el.dispatchEvent(right)
    expect(right.defaultPrevented).toBe(true)

    const left = new MouseEvent('pointerdown', { button: 0, bubbles: true, cancelable: true })
    el.dispatchEvent(left)
    expect(left.defaultPrevented).toBe(false)
  })
})

describe('orbit about the cursor point', () => {
  const RECT = { left: 0, top: 0, width: 800, height: 600 }

  function sceneWithBody(z = 20): THREE.Scene {
    const scene = new THREE.Scene()
    const body = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshBasicMaterial())
    body.userData.orbitPivot = true
    body.position.set(0, 0, z)
    scene.add(body)
    return scene
  }

  function setup(withBody = true) {
    const camera = makeCamera()
    camera.position.set(0, 0, 100)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld()
    const controls = new TurntableControls(camera)
    const el = makeElement()
    controls.connect(el)
    const scene = withBody ? sceneWithBody() : new THREE.Scene()
    // The production picker is SceneController's; the geometry of the read is
    // what this case pins, not the wiring.
    controls.pivotPick = (x, y) => pickPivotPoint(camera, scene, RECT, x, y)
    return { camera, controls, el }
  }

  it('13: a right-down over a body sets the pivot and the first frame does not move the image', () => {
    const { camera, controls, el } = setup()
    const position = camera.position.clone()
    const quaternion = camera.quaternion.clone()

    press(el, 'pointerdown', { button: 2, clientX: 400, clientY: 300 })

    expect(controls.orbitPivot).not.toBeNull()
    expect(controls.orbitPivot!.z).toBeCloseTo(20, 9)
    // Nothing about the pose moved: not the eye, not the aim, not the roll. The
    // grabbed point is still exactly under the cursor at (0, 0) in clip space.
    expect(camera.position.distanceTo(position)).toBeLessThan(1e-12)
    expect(camera.quaternion.angleTo(quaternion)).toBeLessThan(1e-12)
    const projected = controls.orbitPivot!.clone().project(camera)
    expect(projected.x).toBeCloseTo(0, 9)
    expect(projected.y).toBeCloseTo(0, 9)
    expect(controls.target.toArray()).toEqual([0, 0, 0])

    press(document, 'pointerup', { button: 2, clientX: 400, clientY: 300 })
  })

  it('13: a miss keeps the target and takes no pivot', () => {
    const { camera, controls, el } = setup()
    const position = camera.position.clone()

    // Top-right corner: the ray passes beside the small body.
    press(el, 'pointerdown', { button: 2, clientX: 790, clientY: 10 })

    expect(controls.orbitPivot).toBeNull()
    expect(controls.target.toArray()).toEqual([0, 0, 0])
    expect(camera.position.distanceTo(position)).toBeLessThan(1e-12)

    press(document, 'pointerup', { button: 2, clientX: 790, clientY: 10 })
  })

  it('13: a miss on an empty scene keeps the current target', () => {
    const { controls, el } = setup(false)

    press(el, 'pointerdown', { button: 2, clientX: 400, clientY: 300 })
    expect(controls.orbitPivot).toBeNull()
    press(document, 'pointerup', { button: 2, clientX: 400, clientY: 300 })

    expect(controls.target.toArray()).toEqual([0, 0, 0])
  })

  it('turns the view about the grabbed point, keeping it under the cursor', () => {
    const { camera, controls, el } = setup()

    // Off the view axis: the ray meets the body at x = 90.
    press(el, 'pointerdown', { button: 2, clientX: 490, clientY: 300 })
    const pivot = controls.orbitPivot!.clone()
    const screenBefore = pivot.clone().project(camera)
    const distanceBefore = camera.position.distanceTo(pivot)
    const azimuthBefore = controls.azimuth

    press(document, 'pointermove', { clientX: 560, clientY: 330 })

    expect(controls.azimuth).not.toBe(azimuthBefore)
    // The pivot stays pinned: an orbit about a point must not slide that point.
    const screenAfter = pivot.clone().project(camera)
    expect(screenAfter.x).toBeCloseTo(screenBefore.x, 9)
    expect(screenAfter.y).toBeCloseTo(screenBefore.y, 9)
    // It is a turn around the point, not a dolly toward it.
    expect(camera.position.distanceTo(pivot)).toBeCloseTo(distanceBefore, 9)
    // The look-at swings with the camera rather than staying at the origin.
    expect(controls.target.distanceTo(new THREE.Vector3())).toBeGreaterThan(1e-6)

    press(document, 'pointerup', { clientX: 560, clientY: 330 })
    expect(controls.orbitPivot).toBeNull()
  })

  it('takes no pivot when the preference is off', () => {
    const { controls, el } = setup()
    controls.orbitAroundCursor = false

    press(el, 'pointerdown', { button: 2, clientX: 400, clientY: 300 })
    expect(controls.orbitPivot).toBeNull()
    press(document, 'pointerup', { button: 2, clientX: 400, clientY: 300 })

    expect(controls.target.toArray()).toEqual([0, 0, 0])
  })

  it('takes no pivot for a modifier press that pans or dollies instead of rotating', () => {
    const { controls, el } = setup()

    press(el, 'pointerdown', { button: 2, clientX: 400, clientY: 300, ctrlKey: true })
    expect(controls.orbitPivot).toBeNull()
    press(document, 'pointerup', { button: 2, clientX: 400, clientY: 300, ctrlKey: true })
    expect(controls.target.toArray()).toEqual([0, 0, 0])

    press(el, 'pointerdown', { button: 2, clientX: 400, clientY: 300, shiftKey: true })
    expect(controls.orbitPivot).toBeNull()
    press(document, 'pointerup', { button: 2, clientX: 400, clientY: 300, shiftKey: true })
    expect(controls.target.toArray()).toEqual([0, 0, 0])
  })

  it('keeps the level horizon while turning about an off-axis pivot', () => {
    const { camera, controls, el } = setup()

    press(el, 'pointerdown', { button: 2, clientX: 490, clientY: 300 })
    expect(controls.orbitPivot).not.toBeNull()
    press(document, 'pointermove', { clientX: 490, clientY: 380 })
    press(document, 'pointerup', { clientX: 490, clientY: 380 })

    const right = localAxis(camera, new THREE.Vector3(1, 0, 0))
    expect(Math.abs(right.y)).toBeLessThan(1e-12)
    expect(right.length()).toBeCloseTo(1, 12)
  })
})

describe('controller state', () => {
  it('adopts the camera it was given instead of teleporting it', () => {
    const camera = makeCamera()
    camera.position.set(50, 60, 100)
    camera.zoom = 300
    camera.updateProjectionMatrix()
    const controls = new TurntableControls(camera)
    expect(camera.position.toArray()).toEqual([50, 60, 100])
    expect(camera.zoom).toBe(300)
    expect(controls.distance).toBeCloseTo(Math.sqrt(50 ** 2 + 60 ** 2 + 100 ** 2), 12)
  })

  it('round-trips the pose through a snapshot, including an inverted elevation', () => {
    const camera = makeCamera()
    const controls = makeControls(camera)
    controls.azimuth = 1.3
    controls.elevation = Math.PI + 0.4
    controls.target.set(3, 4, 5)
    controls.distance = 77
    controls.setZoom(12)
    const snapshot = snapshotTurntablePose(controls)

    const otherCamera = makeCamera()
    const other = makeControls(otherCamera)
    restoreTurntablePose(other, snapshot)

    expect(snapshotTurntablePose(other)).toEqual(snapshot)
    expect(otherCamera.position.toArray()).toEqual(camera.position.toArray())
    expect(localAxis(otherCamera, new THREE.Vector3(0, 1, 0)).toArray())
      .toEqual(localAxis(camera, new THREE.Vector3(0, 1, 0)).toArray())
  })

  it('derives angles from a direction and uses the supplied pole azimuth', () => {
    expect(anglesFromDirection(new THREE.Vector3(0, 0, 1), 7)).toEqual({ azimuth: 0, elevation: 0 })
    expect(anglesFromDirection(new THREE.Vector3(0, 1, 0), 7).azimuth).toBe(7)
    expect(anglesFromDirection(new THREE.Vector3(0, 1, 0), 7).elevation).toBeCloseTo(Math.PI / 2, 12)
    expect(anglesFromDirection(new THREE.Vector3(0, -1, 0), 7).azimuth).toBe(7)
    expect(anglesFromDirection(new THREE.Vector3(0, -1, 0), 7).elevation).toBeCloseTo(-Math.PI / 2, 12)
  })
})

describe('touch bindings', () => {
  it('one finger rotates instead of being dropped as a button-less press', () => {
    const controls = makeControls()
    const el = makeElement()
    controls.connect(el)
    controls.azimuth = 0
    controls.elevation = 0
    controls.update()

    touch(el, 'pointerdown', { pointerId: 11, clientX: 400, clientY: 300 })
    touch(document, 'pointermove', { pointerId: 11, clientX: 520, clientY: 300 })
    expect(controls.azimuth).not.toBe(0)
    touch(document, 'pointerup', { pointerId: 11, clientX: 520, clientY: 300 })
  })

  it('two fingers pinch-zoom with the distance between them', () => {
    const controls = makeControls()
    const el = makeElement()
    controls.connect(el)
    const before = controls.zoom

    touch(el, 'pointerdown', { pointerId: 21, clientX: 300, clientY: 300 })
    touch(el, 'pointerdown', { pointerId: 22, clientX: 500, clientY: 300 })
    // Spread apart symmetrically: the centre stays put, the distance grows.
    touch(document, 'pointermove', { pointerId: 21, clientX: 250, clientY: 300 })
    touch(document, 'pointermove', { pointerId: 22, clientX: 550, clientY: 300 })
    expect(controls.zoom).toBeGreaterThan(before)
    touch(document, 'pointerup', { pointerId: 21, clientX: 250, clientY: 300 })
    touch(document, 'pointerup', { pointerId: 22, clientX: 550, clientY: 300 })
  })

  it('two fingers dragging together pan the target', () => {
    const controls = makeControls()
    const el = makeElement()
    controls.connect(el)
    const target = controls.target.clone()
    const zoom = controls.zoom

    touch(el, 'pointerdown', { pointerId: 21, clientX: 300, clientY: 300 })
    touch(el, 'pointerdown', { pointerId: 22, clientX: 500, clientY: 300 })
    // Both fingers move right by the same amount: the distance ends where it
    // started, so the net effect is pan only.
    touch(document, 'pointermove', { pointerId: 21, clientX: 340, clientY: 300 })
    touch(document, 'pointermove', { pointerId: 22, clientX: 540, clientY: 300 })
    expect(controls.target.distanceTo(target)).toBeGreaterThan(0)
    expect(controls.zoom).toBeCloseTo(zoom, 10)
  })

  it('lifts one finger back to a rotate without moving the pose by itself', () => {
    const controls = makeControls()
    const el = makeElement()
    controls.connect(el)

    touch(el, 'pointerdown', { pointerId: 21, clientX: 300, clientY: 300 })
    touch(el, 'pointerdown', { pointerId: 22, clientX: 500, clientY: 300 })
    const azimuth = controls.azimuth
    touch(document, 'pointerup', { pointerId: 22, clientX: 500, clientY: 300 })
    expect(controls.azimuth).toBe(azimuth)

    touch(document, 'pointermove', { pointerId: 21, clientX: 380, clientY: 300 })
    expect(controls.azimuth).not.toBe(azimuth)
  })
})

describe('orbit scratch reuse', () => {
  it('writes the orbit direction into the caller vector', () => {
    const out = new THREE.Vector3()
    expect(orbitDirection(0.3, 0.4, out)).toBe(out)
    const first = out.clone()
    expect(orbitDirection(0.3, 0.4, out)).toBe(out)
    expect(out.equals(first)).toBe(true)
  })

  it('writes the right and up axes into the caller vectors', () => {
    const right = new THREE.Vector3()
    const up = new THREE.Vector3()
    expect(orbitRight(0.7, right)).toBe(right)
    expect(orbitUp(0.7, -0.2, up)).toBe(up)
    // A second call must reuse the same instances, not mint new ones.
    expect(orbitRight(0.1, right)).toBe(right)
    expect(orbitUp(0.1, 0.3, up)).toBe(up)
  })

  it('turns a point into the caller vector, so a pivot drag allocates nothing', () => {
    const pivot = new THREE.Vector3(1, 2, 3)
    const target = new THREE.Vector3(4, 5, 6)
    const out = new THREE.Vector3()
    expect(turnAbout(pivot, 0.4, 0.1, -0.2, target, out)).toBe(out)
    const first = out.clone()

    // The same input turns to the same place into the reused vector.
    expect(turnAbout(pivot, 0.4, 0.1, -0.2, target, out)).toBe(out)
    expect(out.equals(first)).toBe(true)
    // And the input vector is not mutated.
    expect(target.equals(new THREE.Vector3(4, 5, 6))).toBe(true)
  })
})

describe('trackball orbit', () => {
  const HEIGHT = 600
  const RATE = (2 * Math.PI) / HEIGHT

  function trackballSetup() {
    const camera = makeCamera()
    const controls = new TurntableControls(camera)
    controls.orbitStyle = 'trackball'
    const el = makeElement()
    controls.connect(el)
    return { camera, controls, el }
  }

  function drag(el: Element, from: [number, number], steps: Array<[number, number]>): void {
    let [x, y] = from
    press(el, 'pointerdown', { button: 2, clientX: x, clientY: y })
    for (const [dx, dy] of steps) {
      x += dx
      y += dy
      press(document, 'pointermove', { button: 2, clientX: x, clientY: y })
    }
    press(document, 'pointerup', { button: 2, clientX: x, clientY: y })
  }

  it('a roll-free pose is the turntable pose', () => {
    const q = poseQuaternion({ azimuth: 0.7, elevation: -0.4, roll: 0 }, new THREE.Quaternion())
    const right = orbitRight(0.7)
    const up = orbitUp(0.7, -0.4)
    expect(new THREE.Vector3(1, 0, 0).applyQuaternion(q).distanceTo(right)).toBeLessThan(1e-12)
    expect(new THREE.Vector3(0, 1, 0).applyQuaternion(q).distanceTo(up)).toBeLessThan(1e-12)
  })

  it('a first step from a level side view matches the turntable step', () => {
    const pose = { azimuth: 0.3, elevation: 0, roll: 0 }
    const trackball = rotateTrackball(pose, 12, 7, HEIGHT)
    const turntable = rotateOrbit(pose, 12, 7, HEIGHT)
    expect(trackball.azimuth).toBeCloseTo(turntable.azimuth, 3)
    expect(trackball.elevation).toBeCloseTo(turntable.elevation, 3)
  })

  it('a circular drag rolls the horizon: the law has no upright constraint', () => {
    let pose = { azimuth: 0, elevation: 0.5, roll: 0 }
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * 2 * Math.PI
      pose = rotateTrackball(pose, 6 * Math.cos(a), 6 * Math.sin(a), HEIGHT)
    }
    expect(Math.abs(pose.roll)).toBeGreaterThan(0.05)
  })

  // The regression the trackball exists for: near a pole the turntable spins
  // the view fast about the line of sight. Here every step turns the camera by
  // exactly the drag angle, whatever the elevation, so there is no singularity.
  it('turns the camera by the drag angle per step at every elevation, poles included', () => {
    const q0 = new THREE.Quaternion()
    const q1 = new THREE.Quaternion()
    for (const elevation of [0, 0.8, Math.PI / 2 - 1e-3, Math.PI / 2, Math.PI / 2 + 1e-3, -1.4]) {
      for (const [dx, dy] of [[4, 0], [0, 4], [3, -3]] as Array<[number, number]>) {
        let pose = { azimuth: 0.4, elevation, roll: 0.2 }
        for (let i = 0; i < 40; i++) {
          poseQuaternion(pose, q0)
          pose = rotateTrackball(pose, dx, dy, HEIGHT)
          poseQuaternion(pose, q1)
          expect(q0.angleTo(q1)).toBeCloseTo(RATE * Math.hypot(dx, dy), 9)
        }
      }
    }
  })

  it('a straight drag and its reverse return to the same view', () => {
    const q0 = new THREE.Quaternion()
    const q1 = new THREE.Quaternion()
    const start = { azimuth: 1.1, elevation: 1.5, roll: -0.3 }
    let pose = start
    for (let i = 0; i < 50; i++) pose = rotateTrackball(pose, 5, 2, HEIGHT)
    for (let i = 0; i < 50; i++) pose = rotateTrackball(pose, -5, -2, HEIGHT)
    expect(poseQuaternion(start, q0).angleTo(poseQuaternion(pose, q1))).toBeLessThan(1e-9)
  })

  it('a horizontal drag on the top view tumbles instead of spinning in place', () => {
    const { camera, controls, el } = trackballSetup()
    controls.setDirection(new THREE.Vector3(0, 1, 0), { poleAzimuth: 0 })
    const forwardBefore = localAxis(camera, new THREE.Vector3(0, 0, -1))
    drag(el, [400, 300], [[30, 0]])
    const forwardAfter = localAxis(camera, new THREE.Vector3(0, 0, -1))
    // The turntable keeps looking straight down here; the trackball tips.
    expect(forwardAfter.angleTo(forwardBefore)).toBeGreaterThan(0.2)
  })

  it('keeps the grabbed pivot under the cursor', () => {
    const { camera, controls, el } = trackballSetup()
    const pivot = new THREE.Vector3(30, -10, 5)
    controls.pivotPick = () => pivot.clone()
    controls.elevation = 0.9
    controls.update()
    const before = pivot.clone().project(camera)
    drag(el, [400, 300], [[25, -10], [30, 15], [-5, 20]])
    const after = pivot.clone().project(camera)
    expect(after.x).toBeCloseTo(before.x, 9)
    expect(after.y).toBeCloseTo(before.y, 9)
  })

  it('a programmatic snap clears the roll and a snapshot carries it', () => {
    const { controls, el } = trackballSetup()
    drag(el, [400, 300], [[40, 40], [40, -40]])
    const snapshot = snapshotTurntablePose(controls)
    expect(snapshot.roll).toBe(controls.roll)
    const other = makeControls()
    restoreTurntablePose(other, snapshot)
    expect(other.roll).toBe(controls.roll)
    controls.setDirection(new THREE.Vector3(1, 0, 0))
    expect(controls.roll).toBe(0)
  })
})
