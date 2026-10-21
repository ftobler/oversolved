import * as THREE from 'three'

// The viewport's orbit law: an unclamped turntable with a level horizon.
//
// OrbitControls is clamped to the poles by construction (its polar angle lives
// in [0, pi] and `makeSafe` keeps it just off the ends), so a drag can never
// tip the camera over the top and a top view has an arbitrary roll. This
// controller carries the elevation as a plain unbounded number instead:
//
//   position = target + distance * dir(azimuth, elevation)
//   dir      = (cos e sin a, sin e, cos e cos a)   (target -> camera)
//   right    = (cos a, 0, -sin a)                  (always horizontal)
//   up       = right x forward
//
// Because `right` has no Y component, the camera never rolls: the horizon stays
// parallel to the screen edge even when the view is upside down past a pole
// (cos e < 0). `up` is orthogonal to `right` and `forward` by construction and
// is still well defined at the poles, so there is no lookAt degeneration and no
// NaN: at e = pi/2, right and up are two horizontal axes and the camera looks
// straight down (screen up is -Z for azimuth 0, the CAD top view).

export type TurntableAction = 'rotate' | 'pan' | 'dolly'

export type TurntableGesture = {
  action: TurntableAction
  pointerId: number
  x: number
  y: number
}

// The historical part/assembly binding: left is selection, middle pans, right
// rotates unless a modifier overrides it. Shift dollies and ctrl/meta pans, the
// same actions the old drei OrbitControls was remapped to per press.
export const MOUSE_BUTTONS: Readonly<Record<'LEFT' | 'MIDDLE' | 'RIGHT', TurntableAction | null>> = {
  LEFT: null,
  MIDDLE: 'pan',
  RIGHT: 'rotate',
}

export function rightButtonMapping(e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): TurntableAction {
  if (e.shiftKey) return 'dolly'
  if (e.ctrlKey || e.metaKey) return 'pan'
  return 'rotate'
}

export function gestureForButton(
  button: number,
  mods: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
): TurntableAction | null {
  if (button === 0) return MOUSE_BUTTONS.LEFT
  if (button === 1) return MOUSE_BUTTONS.MIDDLE
  if (button === 2) return MOUSE_BUTTONS.RIGHT === null ? null : rightButtonMapping(mods)
  return null
}

// One wheel notch, or one shift-dolly move event. Lifted from OrbitControls so
// the wheel and the drag keep the feel the viewport had.
const ZOOM_STEP = 0.95
const MIN_DISTANCE = 1e-6
const POLE_EPSILON = 1e-9

export function orbitDirection(
  azimuth: number,
  elevation: number,
  out: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 {
  const ce = Math.cos(elevation)
  return out.set(ce * Math.sin(azimuth), Math.sin(elevation), ce * Math.cos(azimuth))
}

export function orbitRight(azimuth: number, out: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
  return out.set(Math.cos(azimuth), 0, -Math.sin(azimuth))
}

export function orbitForward(
  azimuth: number,
  elevation: number,
  out: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 {
  return orbitDirection(azimuth, elevation, out).negate()
}

// Right x forward. Deriving it from the two other axes is what keeps the basis
// orthonormal everywhere, including exactly on a pole.
export function orbitUp(
  azimuth: number,
  elevation: number,
  out: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 {
  const se = Math.sin(elevation)
  return out.set(-Math.sin(azimuth) * se, Math.cos(elevation), -Math.cos(azimuth) * se)
}

// Direction (target -> camera) to the unbounded angles. `poleAzimuth` supplies
// the roll of a straight-up or straight-down view, where the direction itself
// says nothing about it: the cube snap and the builtin planes ask for 0 (Top
// with screen up -Z), while alignToFace passes the current azimuth so fitting a
// horizontal face does not spin the view.
export function anglesFromDirection(
  direction: THREE.Vector3,
  poleAzimuth = 0,
): { azimuth: number; elevation: number } {
  const length = direction.length()
  if (!(length > POLE_EPSILON)) return { azimuth: poleAzimuth, elevation: 0 }
  const x = direction.x / length
  const y = direction.y / length
  const z = direction.z / length
  const horizontal = Math.hypot(x, z)
  if (horizontal < POLE_EPSILON) {
    return { azimuth: poleAzimuth, elevation: y >= 0 ? Math.PI / 2 : -Math.PI / 2 }
  }
  return { azimuth: Math.atan2(x, z), elevation: Math.atan2(y, horizontal) }
}

export interface OrbitAngles {
  azimuth: number
  elevation: number
}

// A horizontal drag turns the turntable the other way when the view is
// inverted, so the model still follows the cursor (Blender's behaviour). A
// vertical drag is never clamped: the elevation simply keeps growing past the
// pole. `height` is the viewport's CSS height, the same scale OrbitControls
// used: a full-height drag is half a turn.
export function rotateOrbit(
  pose: OrbitAngles,
  dx: number,
  dy: number,
  height: number,
): OrbitAngles {
  const h = height > 0 ? height : 1
  const delta = (2 * Math.PI) / h
  const horizontalSign = Math.cos(pose.elevation) < 0 ? 1 : -1
  return {
    azimuth: pose.azimuth + horizontalSign * delta * dx,
    elevation: pose.elevation + delta * dy,
  }
}

export interface TurntablePoseSnapshot {
  target: [number, number, number]
  distance: number
  azimuth: number
  elevation: number
  zoom: number
}

function pointerIdOf(e: PointerEvent): number {
  // jsdom's MouseEvent carries no pointerId; a single synthetic gesture is all
  // those tests need, and one stable stand-in keeps the matching checks honest.
  return typeof e.pointerId === 'number' ? e.pointerId : 1
}

/**
 * The viewport camera's orbit state and the only owner of its pointer bindings.
 *
 * The camera's position, orientation and up are outputs of this state, never an
 * independent input. Programmatic moves (fit, align, cube snaps) go through
 * `setDirection` / `setPose` so a later drag starts from the pose the user sees.
 */
export class TurntableControls {
  readonly camera: THREE.Camera
  domElement: HTMLElement | null = null
  target = new THREE.Vector3()
  distance = 1
  azimuth = 0
  elevation = 0
  onChange: (() => void) | null = null
  onStart: (() => void) | null = null
  onEnd: (() => void) | null = null

  private _enabled = true
  private gesture: TurntableGesture | null = null

  constructor(camera: THREE.Camera, domElement: HTMLElement | null = null) {
    this.camera = camera
    this.adoptCamera()
    if (domElement) this.connect(domElement)
  }

  get enabled(): boolean {
    return this._enabled
  }

  // Disabling mid-gesture ends the gesture: the camera must not keep following
  // a drag that a sketch drag or a part manipulation has taken over.
  set enabled(value: boolean) {
    this._enabled = value
    if (!value) this.endGesture()
  }

  get zoom(): number {
    const zoom = (this.camera as THREE.Camera & { zoom?: number }).zoom
    return typeof zoom === 'number' ? zoom : 1
  }

  // The camera starts wherever the Canvas created it. Deriving the state from
  // that pose (instead of forcing INITIAL_CAMERA) is what lets the controller
  // adopt a camera the caller already framed.
  adoptCamera(): void {
    this.target.set(0, 0, 0)
    const offset = this.camera.position.clone().sub(this.target)
    this.distance = Math.max(offset.length(), MIN_DISTANCE)
    const angles = anglesFromDirection(offset, 0)
    this.azimuth = angles.azimuth
    this.elevation = angles.elevation
    this.applyPose(false, false)
  }

  connect(domElement: HTMLElement): void {
    this.disconnect()
    this.domElement = domElement
    domElement.addEventListener('pointerdown', this.handlePointerDown)
    domElement.addEventListener('wheel', this.handleWheel, { passive: false })
    domElement.addEventListener('contextmenu', this.handleContextMenu)
  }

  disconnect(): void {
    this.endGesture()
    const el = this.domElement
    if (el) {
      el.removeEventListener('pointerdown', this.handlePointerDown)
      el.removeEventListener('wheel', this.handleWheel)
      el.removeEventListener('contextmenu', this.handleContextMenu)
    }
    this.domElement = null
  }

  dispose(): void {
    this.disconnect()
    this.onChange = null
    this.onStart = null
    this.onEnd = null
  }

  // Point the camera along `direction` (target -> camera). `poleAzimuth` is
  // used only when the direction is exactly on the up axis.
  setDirection(
    direction: THREE.Vector3,
    options: { poleAzimuth?: number; distance?: number; target?: THREE.Vector3 } = {},
  ): void {
    if (options.target) this.target.copy(options.target)
    if (typeof options.distance === 'number') this.distance = Math.max(options.distance, MIN_DISTANCE)
    const angles = anglesFromDirection(direction, options.poleAzimuth ?? this.azimuth)
    this.azimuth = angles.azimuth
    this.elevation = angles.elevation
    this.applyPose(true)
  }

  setPose(pose: TurntablePoseSnapshot): void {
    this.target.set(pose.target[0], pose.target[1], pose.target[2])
    this.distance = Math.max(pose.distance, MIN_DISTANCE)
    this.azimuth = pose.azimuth
    this.elevation = pose.elevation
    this.setZoom(pose.zoom)
  }

  setZoom(zoom: number): void {
    if (!Number.isFinite(zoom) || zoom <= 0) return
    const camera = this.camera as THREE.Camera & { zoom?: number }
    if (typeof camera.zoom === 'number') camera.zoom = zoom
    this.applyPose(true)
  }

  // Re-derive the camera from the state. Any caller that moves the camera by
  // hand must go through this (or setDirection) or the next drag will undo it.
  update(): void {
    this.applyPose(true)
  }

  private applyPose(writePosition: boolean, notify = true): void {
    const direction = orbitDirection(this.azimuth, this.elevation)
    if (writePosition) this.camera.position.copy(this.target).addScaledVector(direction, this.distance)
    const right = orbitRight(this.azimuth)
    const up = orbitUp(this.azimuth, this.elevation)
    const basis = new THREE.Matrix4().makeBasis(right, up, direction)
    this.camera.quaternion.setFromRotationMatrix(basis)
    this.camera.up.copy(up)
    const camera = this.camera as THREE.Camera & { updateProjectionMatrix?: () => void }
    camera.updateProjectionMatrix?.()
    this.camera.updateMatrixWorld()
    if (notify) this.onChange?.()
  }

  private panByPixels(dx: number, dy: number): void {
    const camera = this.camera as THREE.Camera & {
      left?: number; right?: number; top?: number; bottom?: number
    }
    const width = this.elementWidth()
    const height = this.elementHeight()
    const frustumWidth = typeof camera.right === 'number' && typeof camera.left === 'number'
      ? camera.right - camera.left
      : 2
    const frustumHeight = typeof camera.top === 'number' && typeof camera.bottom === 'number'
      ? camera.top - camera.bottom
      : 2
    const zoom = this.zoom || 1
    const worldPerPixelX = frustumWidth / zoom / width
    const worldPerPixelY = frustumHeight / zoom / height
    const right = orbitRight(this.azimuth)
    const up = orbitUp(this.azimuth, this.elevation)
    // The target slides opposite to the cursor so the model follows it: drag
    // right and the scene moves right under the pointer.
    this.target.addScaledVector(right, -dx * worldPerPixelX)
    this.target.addScaledVector(up, dy * worldPerPixelY)
    this.applyPose(true)
  }

  private elementWidth(): number {
    const el = this.domElement
    if (!el) return 1
    return el.clientWidth || el.getBoundingClientRect().width || 1
  }

  private elementHeight(): number {
    const el = this.domElement
    if (!el) return 1
    return el.clientHeight || el.getBoundingClientRect().height || 1
  }

  private handlePointerDown = (e: PointerEvent): void => {
    if (!this._enabled || this.gesture) return
    const action = gestureForButton(e.button, e)
    if (!action) return
    // OrbitControls cancelled the press for a recognized gesture; without it a
    // middle-drag starts the browser's autoscroll and a drag selects text.
    e.preventDefault()
    this.gesture = {
      action,
      pointerId: pointerIdOf(e),
      x: e.clientX,
      y: e.clientY,
    }
    const doc = this.domElement?.ownerDocument
    doc?.addEventListener('pointermove', this.handlePointerMove)
    doc?.addEventListener('pointerup', this.handlePointerUp)
    doc?.addEventListener('pointercancel', this.handlePointerUp)
    this.onStart?.()
  }

  private handlePointerMove = (e: PointerEvent): void => {
    const gesture = this.gesture
    if (!gesture || pointerIdOf(e) !== gesture.pointerId) return
    if (!this._enabled) {
      this.endGesture()
      return
    }
    const dx = e.clientX - gesture.x
    const dy = e.clientY - gesture.y
    gesture.x = e.clientX
    gesture.y = e.clientY
    if (dx === 0 && dy === 0) return

    if (gesture.action === 'rotate') {
      const next = rotateOrbit(this, dx, dy, this.elementHeight())
      this.azimuth = next.azimuth
      this.elevation = next.elevation
      this.applyPose(true)
    } else if (gesture.action === 'pan') {
      this.panByPixels(dx, dy)
    } else if (gesture.action === 'dolly') {
      // One event is one notch, as in OrbitControls; a per-pixel rate would
      // change the feel the viewport has always had.
      if (dy > 0) this.setZoom(this.zoom * ZOOM_STEP)
      else if (dy < 0) this.setZoom(this.zoom / ZOOM_STEP)
    }
  }

  private handlePointerUp = (e: PointerEvent): void => {
    const gesture = this.gesture
    if (!gesture || pointerIdOf(e) !== gesture.pointerId) return
    this.endGesture()
  }

  private handleWheel = (e: WheelEvent): void => {
    if (!this._enabled || e.deltaY === 0) return
    e.preventDefault()
    this.onStart?.()
    this.setZoom(e.deltaY < 0 ? this.zoom / ZOOM_STEP : this.zoom * ZOOM_STEP)
    this.onEnd?.()
  }

  private handleContextMenu = (e: Event): void => {
    if (this._enabled) e.preventDefault()
  }

  private endGesture(): void {
    if (!this.gesture) return
    this.gesture = null
    const doc = this.domElement?.ownerDocument
    doc?.removeEventListener('pointermove', this.handlePointerMove)
    doc?.removeEventListener('pointerup', this.handlePointerUp)
    doc?.removeEventListener('pointercancel', this.handlePointerUp)
    this.onEnd?.()
  }
}

export function snapshotTurntablePose(controls: TurntableControls): TurntablePoseSnapshot {
  return {
    target: [controls.target.x, controls.target.y, controls.target.z],
    distance: controls.distance,
    azimuth: controls.azimuth,
    elevation: controls.elevation,
    zoom: controls.zoom,
  }
}

export function restoreTurntablePose(controls: TurntableControls, pose: TurntablePoseSnapshot): void {
  controls.setPose(pose)
}
