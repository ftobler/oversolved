// The spline-trimmed test body shared by the eps-read gates. It is the
// smallest shape that reproduces the default BRepGProp rule's weakness: every
// surface is analytic, but the blind hole breaks into the revolved pocket, so
// the r10 cylinder carries a BSPLINE-trimmed inner loop and the default Gauss
// read integrates that face wrong by ~2e-6 of the body.
//
// The authored part, from the evidence in the gprop-eps-volume plan: a
// 120 x 40 x 13 box (z 0..13) minus a revolved r10 pocket about the X line
// y = 0, z = 13, then a d6 blind hole along +Y from the y = -20 face, depth
// 20, axis x = 0, z = 6.5. The real part's r3 ends, cones and r18 blends are
// not needed to reproduce; a plain r10 cylinder over the box does.
//
// A test fixture, not a shipping module: only the *Real suites import it.

type Dict = Record<string, unknown>

export const POCKET_RADIUS = 10
export const POCKET_AXIS_Z = 13
export const POCKET_HALF_LENGTH = 30
export const HOLE_RADIUS = 3
export const HOLE_AXIS_Z = 6.5
export const HOLE_LENGTH = 20

function line(id: string, x1: number, y1: number, x2: number, y2: number): Dict {
  return { id, initial: [x1, y1, x2, y2] }
}

function fixedSketch(id: string, plane: string, lines: Dict[]): Dict {
  return {
    id,
    kind: 'sketch',
    plane,
    entities: lines.map((l) => ({ id: l.id, kind: 'line' })),
    initial: Object.fromEntries(lines.map((l) => [l.id, l.initial])),
    constraints: lines.map((l) => ({ id: `f${l.id}`, kind: 'fixed', target: { entity: l.id } })),
  }
}

function planeOffset(id: string, plane: string, offset: number): Dict {
  return { id, kind: 'plane', definition: { mode: 'offset', plane, offset } }
}

/**
 * The fixture document at `scale` (every length multiplied, so the geometry is
 * the same part at a bigger size). `withSplit` appends a split of the finished
 * body on the Right plane, keeping both halves.
 */
export function splineTrimDoc(scale = 1, withSplit = false): { features: Dict[] } {
  const k = scale
  const halfX = 60 * k
  const halfY = 20 * k
  const height = 13 * k
  const pr = POCKET_RADIUS * k
  const pl = POCKET_HALF_LENGTH * k
  const features: Dict[] = [
    fixedSketch('sk1', '@builtin_plane_front', [
      line('l0', -halfX, -halfY, halfX, -halfY),
      line('l1', halfX, -halfY, halfX, halfY),
      line('l2', halfX, halfY, -halfX, halfY),
      line('l3', -halfX, halfY, -halfX, -halfY),
    ]),
    { id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', distance: height, direction: 'normal', operation: 'new' } },
    // The pocket's axis sits on a plane 13 up from the Front plane, so the
    // revolved r10 cylinder is centred on the box's top face at y = 0.
    planeOffset('plp', '@builtin_plane_front', POCKET_AXIS_Z * k),
    fixedSketch('skax', '@plp', [line('ax', -50 * k, 0, 50 * k, 0)]),
    fixedSketch('skprof', '@plp', [
      line('p0', -pl, 0, pl, 0),
      line('p1', pl, 0, pl, pr),
      line('p2', pl, pr, -pl, pr),
      line('p3', -pl, pr, -pl, 0),
    ]),
    {
      id: 'rev1', kind: 'revolve',
      revolve: { sketch: '$skprof', angle: 360, axis: '@skax/ax', operation: 'cut' },
    },
    // The hole's sketch plane is the y = -20 face; Top's sketch y runs along
    // -Z, so v = -6.5 puts the axis at z = 6.5.
    planeOffset('plh', '@builtin_plane_top', -halfY),
    {
      id: 'skh', kind: 'sketch', plane: '@plh',
      entities: [{ id: 'site', kind: 'point' }],
      initial: { site: [0, -HOLE_AXIS_Z * k] },
      constraints: [{ id: 'fsite', kind: 'fixed', target: { entity: 'site' } }],
    },
    {
      id: 'ho1', kind: 'hole',
      hole: {
        sketch: '$skh', diameter: 2 * HOLE_RADIUS * k, depth_mode: 'blind',
        depth: HOLE_LENGTH * k, direction: 'normal', target: '@body_ex1',
      },
    },
  ]
  if (withSplit) {
    features.push({ id: 'sp1', kind: 'split', split: { bodies: ['@body_ex1'], plane: '@builtin_plane_right', keep: 'both' } })
  }
  return { features }
}

// Simpson's rule with a fixed, even step count. The integrand below is smooth
// on the substituted interval, so 1000 steps leave far less error than the
// 1e-7 relative budget the tests compare against.
function simpson(f: (x: number) => number, a: number, b: number, steps = 1000): number {
  const n = steps % 2 === 0 ? steps : steps + 1
  const h = (b - a) / n
  let sum = f(a) + f(b)
  for (let i = 1; i < n; i++) sum += (i % 2 === 0 ? 2 : 4) * f(a + i * h)
  return (h / 3) * sum
}

/**
 * The material the blind hole removes. The bore is itself 20 pi r^2 long, but
 * its far half runs through the pocket's void. At a point (x, z) of the bore
 * disk the hole axis stays inside the pocket void for the first
 * sqrt(R^2 - (z - zc)^2) of its length, so the removed volume is
 *
 *   bore - integral over the disk of sqrt(R^2 - (z - zc)^2).
 *
 * The integrand does not depend on x, so the disk integral collapses to one
 * dimension: 2 sqrt(r^2 - (z - z0)^2) times that length. Integrating z directly
 * leaves sqrt endpoint singularities and converges slowly; z = z0 + r sin(t)
 * cancels them (dz = r cos(t) dt times the half-width r cos(t)), which is why
 * the quadrature runs in t.
 */
export function analyticHoleRemoval(scale = 1): number {
  const k = scale
  const r = HOLE_RADIUS * k
  const z0 = HOLE_AXIS_Z * k
  const R = POCKET_RADIUS * k
  const zc = POCKET_AXIS_Z * k
  const overlap = simpson((t) => {
    const z = z0 + r * Math.sin(t)
    const diskHalfWidth = r * Math.cos(t)
    const voidLength = Math.sqrt(R * R - (z - zc) ** 2)
    return 2 * diskHalfWidth * voidLength * (r * Math.cos(t))
  }, -Math.PI / 2, Math.PI / 2)
  const bore = HOLE_LENGTH * k * Math.PI * r * r
  return bore - overlap
}
