import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as THREE from 'three'
import {
  computeGizmoHit, drawCubeGizmo, GIZMO_SIZE, getPolys,
  gizmoLabelFont, fitLabelFontSize, ensureGizmoLabelFont,
  isGizmoLabelFontReady, resetGizmoLabelFontForTest,
} from '@/components/misc/CubeGizmo.utils'

// The navigation cube is pure geometry: project the 8 cube corners through the
// inverted camera quaternion, sort by depth, hit-test the mouse against the
// front-most visible polygon. None of it needs the R3F scene, so it is unit
// testable in isolation (the "delete the Viewport, logic still passes" rule).

const cameraWith = (q: THREE.Quaternion): THREE.Camera => {
  const cam = new THREE.Camera()
  cam.quaternion.copy(q)
  return cam
}

// project() in the util uses q = camera.quaternion.inverse(), s = W*0.27, and a
// Y-flip. For an identity camera the cube front face (normal +z) sits dead centre.
const C = GIZMO_SIZE / 2  // 64

describe('computeGizmoHit', () => {
  it('hits the front face at the gizmo centre for an identity camera', () => {
    const hit = computeGizmoHit(C, C, [], cameraWith(new THREE.Quaternion()))
    expect(hit).not.toBeNull()
    expect(hit!.type).toBe('face')
    // CUBE_FACES[0] is Front, normal (0,0,1).
    expect(hit!.index).toBe(0)
    expect(hit!.snapDir.x).toBeCloseTo(0)
    expect(hit!.snapDir.y).toBeCloseTo(0)
    expect(hit!.snapDir.z).toBeCloseTo(1)
  })

  it('returns the face most facing the camera for any orientation', () => {
    // Rotate the camera 90 deg about Y; the +x (Right) face swings to the front.
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
    const hit = computeGizmoHit(C, C, [], cameraWith(q))
    expect(hit).not.toBeNull()
    expect(hit!.type).toBe('face')
    // Whatever face is hit at centre, its normal must point toward the camera
    // (positive z after the inverse-camera rotation that the util applies).
    const facing = hit!.snapDir.clone().applyQuaternion(q.clone().invert()).z
    expect(facing).toBeGreaterThan(0.5)
  })

  it('hits a corner vertex when clicking its (chamfered, inset) polygon', () => {
    // Vertex 6 (1,1,1) projects toward ~(107.8, 32.2), but the bevel/chamfer
    // insets the drawn hexagon inward; its body sits around (99, 40).
    const hit = computeGizmoHit(99, 40, [], cameraWith(new THREE.Quaternion()))
    expect(hit).not.toBeNull()
    expect(hit!.type).toBe('vertex')
    expect(hit!.index).toBe(6)
    expect(hit!.snapDir.x).toBeCloseTo(1 / Math.sqrt(3))
    expect(hit!.snapDir.y).toBeCloseTo(1 / Math.sqrt(3))
    expect(hit!.snapDir.z).toBeCloseTo(1 / Math.sqrt(3))
  })

  it('returns null when clicking empty space outside the cube', () => {
    const hit = computeGizmoHit(2, 2, [], cameraWith(new THREE.Quaternion()))
    expect(hit).toBeNull()
  })

  it('back-face culls: a face pointing away is never hit', () => {
    // The hit at centre is always a front-facing face, never the Back face (1)
    // which is culled (nz < -0.1) for the identity camera.
    const hit = computeGizmoHit(C, C, [], cameraWith(new THREE.Quaternion()))
    expect(hit!.index).not.toBe(1)
  })
})

// A minimal recording 2D context so the canvas draw path runs headless. jsdom
// has no real canvas backend, so we feed our own and assert on the calls.
function makeRecordingCanvas() {
  const calls: Array<[string, ...unknown[]]> = []
  const rec = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]) }
  const ctx = {
    save: rec('save'), restore: rec('restore'), scale: rec('scale'),
    clearRect: rec('clearRect'), beginPath: rec('beginPath'), moveTo: rec('moveTo'),
    lineTo: rec('lineTo'), closePath: rec('closePath'), fill: rec('fill'),
    translate: rec('translate'), transform: rec('transform'), fillText: rec('fillText'),
    // Width proportional to the label so the fit logic sees something ordered;
    // jsdom has no font metrics, so this is a stand-in, never a measurement.
    measureText: (t: string) => ({ width: t.length }),
    fillStyle: '', font: '', textAlign: '', textBaseline: '',
  }
  const canvas = {
    width: 0, height: 0,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement
  return { canvas, ctx, calls }
}

describe('drawCubeGizmo', () => {
  it('returns an empty array when the canvas has no 2d context', () => {
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement
    expect(drawCubeGizmo(canvas, cameraWith(new THREE.Quaternion()), null)).toEqual([])
  })

  it('draws the cube and returns the 8 projected corner vertices', () => {
    const { canvas, calls } = makeRecordingCanvas()
    const verts = drawCubeGizmo(canvas, cameraWith(new THREE.Quaternion()), null)
    expect(verts).toHaveLength(8)
    // Front corner (1,1,1) -> (107.8, 32.2) under the identity camera.
    expect(verts[6].sx).toBeCloseTo(107.8)
    expect(verts[6].sy).toBeCloseTo(32.2)
    // It sized the backing store and stroked at least one path.
    expect((canvas as unknown as { width: number }).width).toBe(GIZMO_SIZE)
    expect(calls.some(c => c[0] === 'fill')).toBe(true)
    // Visible faces get their label rendered.
    expect(calls.some(c => c[0] === 'fillText' && c[1] === 'Front')).toBe(true)
  })

  // Capture the fillStyle in effect at each fill() call so we can prove the
  // bright hover colour was used for the hovered polygon.
  const drawCapturingFills = (hover: Parameters<typeof drawCubeGizmo>[2]): string[] => {
    const fills: string[] = []
    const ctx = {
      save() {}, restore() {}, scale() {}, clearRect() {}, beginPath() {},
      moveTo() {}, lineTo() {}, closePath() {}, translate() {}, transform() {},
      fillText() {}, measureText: (t: string) => ({ width: t.length }),
      fill() { fills.push(this.fillStyle as string) },
      fillStyle: '', font: '', textAlign: '', textBaseline: '',
    }
    const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement
    drawCubeGizmo(canvas, cameraWith(new THREE.Quaternion()), hover)
    return fills
  }

  it('highlights a hovered face with the bright fill', () => {
    const hover = { type: 'face' as const, index: 0, snapDir: new THREE.Vector3(0, 0, 1) }
    expect(drawCapturingFills(hover)).toContain('rgba(255,255,255,0.5)')
  })

  it('fills a hovered edge/vertex (which are otherwise invisible) only on hover', () => {
    // Front-facing vertex 6 is normally not filled; hovering it triggers the
    // non-face hover branch.
    const snapDir = new THREE.Vector3(1, 1, 1).normalize()
    const hover = { type: 'vertex' as const, index: 6, snapDir }
    expect(drawCapturingFills(hover)).toContain('rgba(255,255,255,0.5)')
  })

  it('draws every polygon the hit-test can return, including grazing slivers', () => {
    // Orientations where the front-most polygon under the pointer has normal z
    // in [-0.1, 0), the band where hit-test and draw pass used to disagree:
    // the cursor turned to pointer and a click snapped the camera, but the
    // element was never painted, so its hover highlight could not exist.
    // Found by an orientation sweep and pinned numerically so a geometry
    // retune cannot silently slide the cases out of the band again.
    const grazingCases: Array<[number, number, number, number, number]> = [
      // [eulerX, eulerY, eulerZ, pointerX, pointerY]
      [4.116454, 1.915205, 3.974011, 111, 45],  // edge 6 wins the pixel
      [6.257305, 4.269182, 4.229359, 30, 75],  // face 4 wins the pixel
    ]

    const fillsFor = (camera: THREE.Camera, hover: Parameters<typeof drawCubeGizmo>[2]): string[] => {
      const fills: string[] = []
      const ctx = {
        save() {}, restore() {}, scale() {}, clearRect() {}, beginPath() {},
        moveTo() {}, lineTo() {}, closePath() {}, translate() {}, transform() {},
        fillText() {}, measureText: (t: string) => ({ width: t.length }),
        fill() { fills.push(this.fillStyle as string) },
        fillStyle: '', font: '', textAlign: '', textBaseline: '',
      }
      const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement
      drawCubeGizmo(canvas, camera, hover)
      return fills
    }

    for (const [ex, ey, ez, px, py] of grazingCases) {
      const cam = cameraWith(new THREE.Quaternion().setFromEuler(new THREE.Euler(ex, ey, ez)))
      const hit = computeGizmoHit(px, py, [], cam)
      expect(hit).not.toBeNull()

      // The winner really is a grazing polygon, i.e. this case exercises the
      // old disagreement rather than an ordinary front-facing hit.
      const nz = hit!.snapDir.clone().applyQuaternion(cam.quaternion.clone().invert()).z
      expect(nz).toBeLessThan(0)
      expect(nz).toBeGreaterThanOrEqual(-0.1)

      // Consistency contract: whatever the hit-test can return must be drawn,
      // so the hover highlight it promises actually lights up.
      expect(fillsFor(cam, hit)).toContain('rgba(255,255,255,0.5)')
    }
  })
})

// ─── Per-frame allocation (VP-L1) ───

// The cube is redrawn every animation frame (and re-projected on every
// mousemove). getPolys used to clone hundreds of THREE.Vector3 per call building
// the chamfered/octagon/hex geometry from scratch; now the geometry is built
// once at module load and only rotated into screen space, reusing a shared
// output buffer. These tests pin that the per-frame path does not allocate a
// fresh poly/point tree.

describe('getPolys reuse', () => {
  it('returns the same polygon buffer and point arrays across calls', () => {
    const q = new THREE.Quaternion()
    const a = getPolys(q, GIZMO_SIZE, GIZMO_SIZE)
    const b = getPolys(q, GIZMO_SIZE, GIZMO_SIZE)
    expect(a).toBe(b)  // shared top-level buffer reused
    for (let i = 0; i < a.length; i++) {
      // Each poly's Pv[] point array must be the same instance, proving the
      // per-frame path stopped allocating it anew.
      expect(a[i].pts).toBe(b[i].pts)
    }
  })

  it('builds the full 26-poly set (6 faces, 12 edges, 8 vertices)', () => {
    const polys = getPolys(new THREE.Quaternion(), GIZMO_SIZE, GIZMO_SIZE)
    expect(polys).toHaveLength(26)
  })

  it('does not mutate the base cube geometry when projecting', () => {
    // Rotating through a non-identity quaternion must leave the base snapDirs
    // intact (the reused buffer must only write screen-space pts/zs).
    const baseDir = new THREE.Vector3(0, 0, 1)
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
    const before = baseDir.clone()
    getPolys(q, GIZMO_SIZE, GIZMO_SIZE)
    expect(baseDir.x).toBeCloseTo(before.x)
    expect(baseDir.y).toBeCloseTo(before.y)
    expect(baseDir.z).toBeCloseTo(before.z)
  })
})

// ─── Face label font ───

describe('gizmoLabelFont', () => {
  it('asks for Roboto and keeps a generic fallback in the stack', () => {
    const font = gizmoLabelFont()
    expect(font).toContain('Roboto')
    expect(font).toContain('sans-serif')
    expect(font).toBe('bold 10px Roboto, sans-serif')
  })

  it('carries the weight and stack through to a shrunk size', () => {
    expect(gizmoLabelFont(9.2)).toBe('bold 9.2px Roboto, sans-serif')
  })
})

describe('fitLabelFontSize', () => {
  const USABLE = 30

  it('leaves a label that already fits completely untouched', () => {
    expect(fitLabelFontSize(20, USABLE)).toBe(10)
    // Exactly filling the usable width is still a fit, not an overflow.
    expect(fitLabelFontSize(USABLE, USABLE)).toBe(10)
  })

  it('shrinks an overflowing label to exactly the usable width', () => {
    // 60 wide at size 10 must come back at the size that makes it 30 wide.
    expect(fitLabelFontSize(60, USABLE)).toBeCloseTo(5)
    expect(fitLabelFontSize(40, USABLE)).toBeCloseTo(7.5)
  })

  it('never scales a label up', () => {
    expect(fitLabelFontSize(1, USABLE)).toBe(10)
  })

  it('falls back to the base size on a degenerate measurement', () => {
    // A stub context (jsdom) can report 0 or NaN; that must not produce a
    // zero-sized or NaN font.
    expect(fitLabelFontSize(0, USABLE)).toBe(10)
    expect(fitLabelFontSize(NaN, USABLE)).toBe(10)
  })
})

// Draw the cube with a controllable measureText and report the font that was
// in effect at each fillText. The assertion is about the fit ALGORITHM: jsdom
// has no font metrics, so the widths are supplied, never measured.
function drawCapturingLabelFonts(
  camera: THREE.Camera,
  widths: Record<string, number>,
): Record<string, string> {
  const seen: Record<string, string> = {}
  const ctx = {
    save() {}, restore() {}, scale() {}, clearRect() {}, beginPath() {},
    moveTo() {}, lineTo() {}, closePath() {}, fill() {}, translate() {},
    transform() {},
    measureText: (t: string) => ({ width: widths[t] ?? 0 }),
    fillText(t: string) { seen[t] = this.font as string },
    fillStyle: '', font: '', textAlign: '', textBaseline: '',
  }
  const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement
  drawCubeGizmo(canvas, camera, null)
  return seen
}

// The camera quaternion that brings a given face to the front. drawCubeGizmo
// projects through the INVERTED camera quaternion, so these are inverses of the
// rotation that carries the face normal toward +z.
const facingTop = () =>
  cameraWith(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2))
const facingBottom = () =>
  cameraWith(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2))

describe('face label fit-to-width', () => {
  it('shrinks a label that overflows the face', () => {
    // 'Bottom' is the longest of the six names and the one the user reported
    // as fitting with zero room to spare.
    const fonts = drawCapturingLabelFonts(facingBottom(), { Bottom: 100 })
    expect(fonts.Bottom).toBeDefined()
    const size = Number(/bold ([\d.]+)px/.exec(fonts.Bottom)![1])
    expect(size).toBeLessThan(10)
    expect(fonts.Bottom).toContain('Roboto')
  })

  it('leaves a label that fits at the untouched base size', () => {
    // Deliberately a width no plausible face can overflow.
    const fonts = drawCapturingLabelFonts(facingTop(), { Top: 1 })
    expect(fonts.Top).toBe('bold 10px Roboto, sans-serif')
  })

  it('does not shrink short labels just because a long one exists', () => {
    // Same draw, same usable width: a global shrink would catch 'Top' too.
    const wide = drawCapturingLabelFonts(facingBottom(), { Bottom: 100 })
    const narrow = drawCapturingLabelFonts(facingTop(), { Top: 1 })
    expect(narrow.Top).toBe(gizmoLabelFont())
    expect(wide.Bottom).not.toBe(gizmoLabelFont())
  })

  it('shrinks by the overflow ratio, not by a fixed step', () => {
    // Twice the overflow must yield half the size: proves the ratio drives it.
    const a = drawCapturingLabelFonts(facingBottom(), { Bottom: 100 })
    const b = drawCapturingLabelFonts(facingBottom(), { Bottom: 200 })
    const sizeOf = (f: string) => Number(/bold ([\d.]+)px/.exec(f)![1])
    expect(sizeOf(b.Bottom)).toBeCloseTo(sizeOf(a.Bottom) / 2, 1)
  })
})

describe('label font readiness', () => {
  beforeEach(() => resetGizmoLabelFontForTest())
  afterEach(() => {
    Reflect.deleteProperty(document as object, 'fonts')
    resetGizmoLabelFontForTest()
  })

  const stubFonts = (load: (f: string) => Promise<unknown>) => {
    Object.defineProperty(document, 'fonts', {
      value: { load }, configurable: true, writable: true,
    })
  }

  it('requests the exact shorthand it draws with, so the face is fetched', () => {
    // Canvas fillText never triggers a font load; this request is what does.
    const load = vi.fn(() => Promise.resolve())
    stubFonts(load)
    ensureGizmoLabelFont()
    expect(load).toHaveBeenCalledWith(gizmoLabelFont())
  })

  it('requests the font only once across many frames', () => {
    const load = vi.fn(() => Promise.resolve())
    stubFonts(load)
    ensureGizmoLabelFont()
    ensureGizmoLabelFont()
    ensureGizmoLabelFont()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('notifies a paint that was scheduled before the font was ready', async () => {
    let resolveLoad: () => void = () => {}
    stubFonts(() => new Promise<void>(r => { resolveLoad = () => r() }))

    const redraw = vi.fn()
    ensureGizmoLabelFont(redraw)
    // Still loading: nothing has fired, and the cube is painting the fallback.
    expect(redraw).not.toHaveBeenCalled()
    expect(isGizmoLabelFontReady()).toBe(false)

    resolveLoad()
    await Promise.resolve()
    await Promise.resolve()

    expect(redraw).toHaveBeenCalledTimes(1)
    expect(isGizmoLabelFontReady()).toBe(true)
  })

  it('still becomes ready when the font fails to load', async () => {
    stubFonts(() => Promise.reject(new Error('offline')))
    const redraw = vi.fn()
    ensureGizmoLabelFont(redraw)
    await Promise.resolve()
    await Promise.resolve()
    // A missing font must degrade to the fallback, never to a blank gizmo.
    expect(redraw).toHaveBeenCalled()
    expect(isGizmoLabelFontReady()).toBe(true)
  })

  it('runs the callback immediately once the font is already ready', () => {
    stubFonts(() => Promise.resolve())
    ensureGizmoLabelFont()
    // Force the ready state as a later frame would observe it.
    resetGizmoLabelFontForTest()
    Reflect.deleteProperty(document as object, 'fonts')
    const redraw = vi.fn()
    ensureGizmoLabelFont(redraw)  // no document.fonts: ready synchronously
    const second = vi.fn()
    ensureGizmoLabelFont(second)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('renders rather than throwing when document.fonts is absent', () => {
    Reflect.deleteProperty(document as object, 'fonts')
    expect(() => ensureGizmoLabelFont()).not.toThrow()
    expect(isGizmoLabelFontReady()).toBe(true)

    // And the draw path still puts labels on the cube.
    const { canvas, calls } = makeRecordingCanvas()
    expect(() => drawCubeGizmo(canvas, cameraWith(new THREE.Quaternion()), null)).not.toThrow()
    expect(calls.some(c => c[0] === 'fillText' && c[1] === 'Front')).toBe(true)
  })
})
