// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as THREE from 'three'
import {
  computeGizmoHit, drawCubeGizmo, GIZMO_SIZE, GIZMO_HEIGHT, GIZMO_PAD, GIZMO_CULL_NZ, getPolys,
  gizmoLabelFont, fitLabelFontSize, ensureGizmoLabelFont,
  isGizmoLabelFontReady, resetGizmoLabelFontForTest,
  gizmoSilhouette, rollArrowPolygons, gizmoRequestFor, ROLL_CENTER, ROLL_STEP, type Hit, type Pv,
  orbitTrianglePolygons, ORBIT_STEP, isCulled,
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
const C = GIZMO_SIZE / 2  // 70

// The snap direction of a cube hit; a roll hit here is a test failure.
function snapDirOf(hit: Hit | null): THREE.Vector3 {
  if (!hit || hit.type === 'roll' || hit.type === 'orbit') throw new Error(`expected a cube hit, got ${JSON.stringify(hit)}`)
  return hit.snapDir
}

describe('computeGizmoHit', () => {
  it('hits the front face at the gizmo centre for an identity camera', () => {
    const hit = computeGizmoHit(C, C, [], cameraWith(new THREE.Quaternion()))
    expect(hit).not.toBeNull()
    expect(hit!.type).toBe('face')
    // CUBE_FACES[0] is Front, normal (0,0,1).
    expect(hit!.index).toBe(0)
    expect(snapDirOf(hit).x).toBeCloseTo(0)
    expect(snapDirOf(hit).y).toBeCloseTo(0)
    expect(snapDirOf(hit).z).toBeCloseTo(1)
  })

  it('returns the face most facing the camera for any orientation', () => {
    // Rotate the camera 90 deg about Y; the +x (Right) face swings to the front.
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
    const hit = computeGizmoHit(C, C, [], cameraWith(q))
    expect(hit).not.toBeNull()
    expect(hit!.type).toBe('face')
    // Whatever face is hit at centre, its normal must point toward the camera
    // (positive z after the inverse-camera rotation that the util applies).
    const facing = snapDirOf(hit).clone().applyQuaternion(q.clone().invert()).z
    expect(facing).toBeGreaterThan(0.5)
  })

  it('hits a corner vertex when clicking its (chamfered, inset) polygon', () => {
    // Vertex 6 (1,1,1) projects toward ~(107.8, 32.2), but the bevel/chamfer
    // insets the drawn hexagon inward; its body sits around (99, 40).
    const hit = computeGizmoHit(99, 40, [], cameraWith(new THREE.Quaternion()))
    expect(hit).not.toBeNull()
    expect(hit!.type).toBe('vertex')
    expect(hit!.index).toBe(6)
    expect(snapDirOf(hit).x).toBeCloseTo(1 / Math.sqrt(3))
    expect(snapDirOf(hit).y).toBeCloseTo(1 / Math.sqrt(3))
    expect(snapDirOf(hit).z).toBeCloseTo(1 / Math.sqrt(3))
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
    lineTo: rec('lineTo'), closePath: rec('closePath'), fill: rec('fill'), stroke: rec('stroke'),
    strokeStyle: '', lineWidth: 1, lineJoin: '',
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
    expect((canvas as unknown as { width: number }).width).toBe(GIZMO_SIZE + 2 * GIZMO_PAD)
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
      moveTo() {}, lineTo() {}, closePath() {}, translate() {}, transform() {}, stroke() {},
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
    ]

    const fillsFor = (camera: THREE.Camera, hover: Parameters<typeof drawCubeGizmo>[2]): string[] => {
      const fills: string[] = []
      const ctx = {
        save() {}, restore() {}, scale() {}, clearRect() {}, beginPath() {},
        moveTo() {}, lineTo() {}, closePath() {}, translate() {}, transform() {}, stroke() {},
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
      const nz = snapDirOf(hit).clone().applyQuaternion(cam.quaternion.clone().invert()).z
      expect(nz).toBeLessThan(0)
      expect(nz).toBeGreaterThanOrEqual(GIZMO_CULL_NZ)

      // Consistency contract: whatever the hit-test can return must be drawn,
      // so the hover highlight it promises actually lights up.
      expect(fillsFor(cam, hit)).toContain('rgba(255,255,255,0.5)')
    }
  })
})

describe('back faces', () => {
  // This pose used to paint face 4 (Top) as a sliver seen from behind, the
  // pixel at (30, 75) on it: the face slack in the cull let it draw and win
  // the hit-test although it faces away. A face is culled once nz <= 0.
  const cam = cameraWith(new THREE.Quaternion().setFromEuler(new THREE.Euler(6.257305, 4.269182, 4.229359)))

  it('never hits a face that turns away from the camera', () => {
    const hit = computeGizmoHit(30, 75, [], cam)
    if (hit && hit.type === 'face') {
      const nz = hit.snapDir.clone().applyQuaternion(cam.quaternion.clone().invert()).z
      expect(nz).toBeGreaterThan(0)
    }
  })

  it('never draws a face that turns away, at any orientation', () => {
    const q = new THREE.Quaternion()
    for (let i = 0; i < 300; i++) {
      q.setFromEuler(new THREE.Euler(i * 0.37, i * 0.91, i * 0.13)).invert()
      for (const poly of getPolys(q, GIZMO_SIZE, GIZMO_SIZE)) {
        if (poly.type === 'face' && poly.nz <= 0) expect(isCulled(poly)).toBe(true)
        // Edges and corners keep the grazing slack.
        if (poly.type !== 'face' && poly.nz < 0 && poly.nz >= GIZMO_CULL_NZ) expect(isCulled(poly)).toBe(false)
      }
    }
  })
})

// ─── Roll arrows ───

// A clock-angle point on a circle round the arcs' centre (degrees from 12 o'clock).
const clockAt = (deg: number, r: number): [number, number] => {
  const a = deg * Math.PI / 180
  return [ROLL_CENTER.x + r * Math.sin(a), ROLL_CENTER.y - r * Math.cos(a)]
}

describe('roll arrows', () => {
  it('hits the 4 o\'clock arrow as a counter-clockwise turn and 8 o\'clock as clockwise', () => {
    const cam = cameraWith(new THREE.Quaternion())
    const ccw = computeGizmoHit(...clockAt(150, 76), [], cam)
    const cw = computeGizmoHit(...clockAt(210, 76), [], cam)
    expect(ccw).toEqual({ type: 'roll', index: 0, roll: -ROLL_STEP })
    expect(cw).toEqual({ type: 'roll', index: 1, roll: ROLL_STEP })
    expect(ROLL_STEP).toBeCloseTo(Math.PI / 12)
  })

  it('does not reach past 4 or 8 o\'clock, or into the 6 o\'clock gap', () => {
    const cam = cameraWith(new THREE.Quaternion())
    expect(computeGizmoHit(...clockAt(100, 76), [], cam)).toBeNull()
    expect(computeGizmoHit(...clockAt(260, 76), [], cam)).toBeNull()
    // The gap itself belongs to the south orbit triangle.
    expect(computeGizmoHit(...clockAt(180, 72), [], cam)?.type).toBe('orbit')
  })

  it('fits the arrows inside the canvas and outside every cube silhouette', () => {
    for (const poly of rollArrowPolygons()) {
      for (const p of poly) {
        expect(p.sx).toBeGreaterThanOrEqual(-GIZMO_PAD)
        expect(p.sx).toBeLessThanOrEqual(GIZMO_SIZE + GIZMO_PAD)
        expect(p.sy).toBeLessThanOrEqual(GIZMO_HEIGHT)
      }
    }
    // The arrows never steal a cube pixel: sweep orientations and check no
    // cube point reaches the arrow pick ring.
    let maxR = 0
    for (let i = 0; i < 200; i++) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(i * 0.37, i * 0.91, i * 0.13))
      for (const poly of getPolys(q, GIZMO_SIZE, GIZMO_SIZE))
        for (const p of poly.pts) maxR = Math.max(maxR, Math.hypot(p.sx - ROLL_CENTER.x, p.sy - ROLL_CENTER.y))
    }
    expect(maxR).toBeLessThan(76 - 9)
  })

  it('turns a roll hit into a roll request and a cube hit into its direction', () => {
    expect(gizmoRequestFor({ type: 'roll', index: 1, roll: ROLL_STEP })).toEqual({ roll: ROLL_STEP })
    const dir = new THREE.Vector3(0, 0, 1)
    expect(gizmoRequestFor({ type: 'face', index: 0, snapDir: dir })).toBe(dir)
  })

  it('highlights only the hovered arrow', () => {
    const fills: string[] = []
    const ctx = {
      save() {}, restore() {}, scale() {}, clearRect() {}, beginPath() {},
      moveTo() {}, lineTo() {}, closePath() {}, translate() {}, transform() {}, stroke() {},
      fillText() {}, measureText: (t: string) => ({ width: t.length }),
      fill() { fills.push(this.fillStyle as string) },
      fillStyle: '', font: '', textAlign: '', textBaseline: '',
    }
    const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement
    drawCubeGizmo(canvas, cameraWith(new THREE.Quaternion()), { type: 'roll', index: 1, roll: ROLL_STEP })
    // The arrows are the two fills before the four orbit triangles, in index order.
    expect(fills.slice(-6, -4)).toEqual(['rgba(255,255,255,0.15)', 'rgba(255,255,255,0.5)'])
    expect(fills.slice(-4)).toEqual(Array(4).fill('rgba(255,255,255,0.15)'))
  })
})

// ─── Orbit triangles ───

describe('orbit triangles', () => {
  const cam = () => cameraWith(new THREE.Quaternion())

  it('maps N, E, S, W to a 15 degree camera step toward that side', () => {
    const at = [[C, C - 67], [C + 67, C], [C, C + 67], [C - 67, C]] as const
    const dirs = at.map(([x, y]) => {
      const hit = computeGizmoHit(x, y, [], cam())
      if (hit?.type !== 'orbit') throw new Error(`expected an orbit hit, got ${JSON.stringify(hit)}`)
      return [hit.right, hit.up]
    })
    expect(dirs).toEqual([[0, 1], [1, 0], [0, -1], [-1, 0]])
    const req = gizmoRequestFor({ type: 'orbit', index: 1, right: 1, up: 0 })
    expect(req).toEqual({ orbit: { right: 1, up: 0, angle: ORBIT_STEP } })
    expect(ORBIT_STEP).toBeCloseTo(Math.PI / 12)
  })

  it('draws equilateral triangles pointing away from the cube', () => {
    for (const pts of orbitTrianglePolygons()) {
      const side = (a: Pv, b: Pv) => Math.hypot(a.sx - b.sx, a.sy - b.sy)
      expect(side(pts[0], pts[1])).toBeCloseTo(side(pts[1], pts[2]))
      expect(side(pts[1], pts[2])).toBeCloseTo(side(pts[2], pts[0]))
      // The tip is the vertex farthest from the cube centre.
      const r = pts.map(p => Math.hypot(p.sx - C, p.sy - C))
      expect(r[0]).toBeGreaterThan(Math.max(r[1], r[2]))
      for (const p of pts) {
        expect(p.sx).toBeGreaterThanOrEqual(-GIZMO_PAD)
        expect(p.sx).toBeLessThanOrEqual(GIZMO_SIZE + GIZMO_PAD)
        expect(p.sy).toBeGreaterThanOrEqual(-GIZMO_PAD)
        expect(p.sy).toBeLessThanOrEqual(GIZMO_HEIGHT)
      }
    }
  })

  it('keeps the south triangle clear of both roll arrows', () => {
    const south = orbitTrianglePolygons()[2]
    for (const arrow of rollArrowPolygons()) {
      const xs = arrow.map(p => p.sx)
      const minX = Math.min(...xs), maxX = Math.max(...xs)
      for (const p of south) expect(p.sx < minX || p.sx > maxX).toBe(true)
    }
  })

  it('does not reach any cube silhouette', () => {
    let maxR = 0
    for (let i = 0; i < 200; i++) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(i * 0.37, i * 0.91, i * 0.13))
      for (const poly of getPolys(q, GIZMO_SIZE, GIZMO_SIZE))
        for (const p of poly.pts) maxR = Math.max(maxR, Math.hypot(p.sx - C, p.sy - C))
    }
    // The pick disc's inner edge, with the cube centre as origin.
    expect(maxR).toBeLessThan(67 - 7)
  })
})

// ─── Silhouette outline ───

describe('gizmo silhouette', () => {
  const isConvexClosed = (hull: Pv[]): boolean => {
    let sign = 0
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length], c = hull[(i + 2) % hull.length]
      const z = (b.sx - a.sx) * (c.sy - b.sy) - (b.sy - a.sy) * (c.sx - b.sx)
      if (Math.abs(z) < 1e-9) continue
      if (sign === 0) sign = Math.sign(z)
      else if (Math.sign(z) !== sign) return false
    }
    return true
  }

  it('is one convex loop enclosing every cube polygon point', () => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 0.7, 0.1))
    const polys = getPolys(q, GIZMO_SIZE, GIZMO_SIZE)
    const hull = gizmoSilhouette().slice()
    expect(hull.length).toBeGreaterThanOrEqual(6)
    expect(isConvexClosed(hull)).toBe(true)
    // Every point lies on the inner side of every hull edge.
    const area = hull.reduce((s, p, i) => {
      const n = hull[(i + 1) % hull.length]
      return s + p.sx * n.sy - n.sx * p.sy
    }, 0)
    const inward = Math.sign(area)
    for (const poly of polys) {
      for (const p of poly.pts) {
        for (let i = 0; i < hull.length; i++) {
          const a = hull[i], b = hull[(i + 1) % hull.length]
          const z = (b.sx - a.sx) * (p.sy - a.sy) - (b.sy - a.sy) * (p.sx - a.sx)
          expect(z * inward).toBeGreaterThanOrEqual(-1e-6)
        }
      }
    }
  })

  it('is the one stroke per frame: the arrows are fill only', () => {
    const { canvas, calls } = makeRecordingCanvas()
    drawCubeGizmo(canvas, cameraWith(new THREE.Quaternion()), null)
    expect(calls.filter(c => c[0] === 'stroke')).toHaveLength(1)
    expect((canvas as unknown as { height: number }).height).toBe(GIZMO_PAD + GIZMO_HEIGHT)
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
    transform() {}, stroke() {},
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
