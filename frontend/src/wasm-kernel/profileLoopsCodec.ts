/**
 * Wire codec for the Rust profile-loop family (`geom-core/src/wire.rs`), the
 * little-endian bytes under `profile_loops_bytes` in the sketch package.
 *
 * One op byte and one layout per op: the TS facade keeps the old synchronous
 * function signatures, so one crossing per call is all the surface it needs.
 * The magic's trailing digit and the version byte beside it are the handshake;
 * bump both here and in the Rust codec on any layout change, like the sketch
 * solver's `SKG*`/`SKR*` pair.
 */

/** A loop edge as the kernel and the profile dump hold it: a stringly-typed
 *  dict from the topology output, keyed by `kind`. */
export type LoopEdge = Record<string, unknown>

export const PROFILE_LOOPS_MAGIC_IN = 0x314c5047  // "GPL1", little-endian
export const PROFILE_LOOPS_MAGIC_OUT = 0x31525047  // "GPR1"
export const PROFILE_LOOPS_VERSION = 1

export const ProfileLoopOp = {
  loopPts: 0,
  signedArea: 1,
  pointInLoop: 2,
  centroid: 3,
  containment: 4,
  subdivide: 5,
  arcSamples: 6,
  ellipseArcSamples: 7,
  splineSamples: 8,
  fitSplineSamples: 9,
  ellipseSamples: 10,
} as const

export type ProfileLoopOpCode = (typeof ProfileLoopOp)[keyof typeof ProfileLoopOp]

/** Edge kind codes, mirroring `read_edge` in the Rust codec. */
const EdgeKind = {
  line: 0,
  arc: 1,
  ellipse_arc: 2,
  spline: 3,
  fit_spline: 4,
  ellipse: 5,
} as const

const scratch = new DataView(new ArrayBuffer(8))

class ByteWriter {
  private bytes: number[] = []

  u8(v: number): void {
    this.bytes.push(v & 0xff)
  }

  u32(v: number): void {
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)
  }

  f64(v: number): void {
    scratch.setFloat64(0, v, true)
    for (let i = 0; i < 8; i++) this.bytes.push(scratch.getUint8(i))
  }

  done(): Uint8Array {
    return new Uint8Array(this.bytes)
  }
}

class ByteReader {
  private view: DataView
  private pos = 0

  constructor(buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  u8(): number {
    return this.view.getUint8(this.pos++)
  }

  u32(): number {
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v
  }

  f64(): number {
    const v = this.view.getFloat64(this.pos, true)
    this.pos += 8
    return v
  }
}

function fail(what: string): never {
  throw new Error(`profile loops: ${what}`)
}

function num(v: unknown, what: string): number {
  if (typeof v !== 'number') fail(`${what} is not a number`)
  return v
}

function point(v: unknown, what: string): [number, number] {
  if (!Array.isArray(v) || v.length < 2) fail(`${what} is not a point`)
  return [num(v[0], `${what}[0]`), num(v[1], `${what}[1]`)]
}

function optionalPoint(v: unknown, what: string): [number, number] | null {
  if (v === undefined || v === null) return null
  return point(v, what)
}

function bool(v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null) return fallback
  if (typeof v !== 'boolean') fail('ccw is not a boolean')
  return v
}

function writePoint(w: ByteWriter, p: [number, number]): void {
  w.f64(p[0])
  w.f64(p[1])
}

/**
 * Encode one edge. The samplers are only defined for a well-formed dict, so a
 * missing field is a host bug (the topology writer emits complete edges) and
 * throws rather than being resampled as a different shape.
 *
 * Defaults match the TS samplers' own `??` reads: a missing radius or angle is
 * 0, a missing `ccw` is true, a missing `theta` is 0.
 */
/**
 * Encode one edge. The geometry of a kind must be complete enough to sample:
 * a line's start, an arc's center, a spline's controls, a fit spline's poles
 * and knots. A missing *start* is not an error (the polygon reader simply
 * pushes nothing, exactly as the TS reader did when the key was absent), and
 * the fields a sampler never reads get a harmless default.
 */
function writeEdge(w: ByteWriter, e: LoopEdge): void {
  const kind = e['kind']
  const geomStart = optionalPoint(e['start'], 'start')
  switch (kind) {
    case 'line': {
      w.u8(EdgeKind.line)
      const start = geomStart ?? [0, 0]
      writePoint(w, start)
      const end = optionalPoint(e['end'], 'line.end') ?? start
      writePoint(w, end)
      break
    }
    case 'arc': {
      w.u8(EdgeKind.arc)
      const center = point(e['center'], 'arc.center')
      const radius = e['radius'] === undefined ? 0 : num(e['radius'], 'arc.radius')
      const a0 = e['angle_start_deg'] === undefined ? 0 : num(e['angle_start_deg'], 'arc.angle_start_deg')
      const a1 = e['angle_end_deg'] === undefined ? 0 : num(e['angle_end_deg'], 'arc.angle_end_deg')
      const at = (deg: number): [number, number] => {
        const a = (deg * Math.PI) / 180
        return [center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)]
      }
      writePoint(w, center)
      w.f64(radius)
      w.f64(a0)
      w.f64(a1)
      w.u8(bool(e['ccw'], true) ? 1 : 0)
      writePoint(w, geomStart ?? at(a0))
      writePoint(w, optionalPoint(e['end'], 'arc.end') ?? at(a1))
      break
    }
    case 'ellipse_arc': {
      w.u8(EdgeKind.ellipse_arc)
      const center = point(e['center'], 'ellipse_arc.center')
      const a = e['a'] === undefined ? 0 : num(e['a'], 'ellipse_arc.a')
      const b = e['b'] === undefined ? 0 : num(e['b'], 'ellipse_arc.b')
      const theta = e['theta'] === undefined ? 0 : num(e['theta'], 'ellipse_arc.theta')
      const a0 = e['angle_start_deg'] === undefined ? 0 : num(e['angle_start_deg'], 'ellipse_arc.angle_start_deg')
      const a1 = e['angle_end_deg'] === undefined ? 0 : num(e['angle_end_deg'], 'ellipse_arc.angle_end_deg')
      const th = (theta * Math.PI) / 180
      const at = (deg: number): [number, number] => {
        const phi = (deg * Math.PI) / 180
        const ax = a * Math.cos(phi)
        const ay = b * Math.sin(phi)
        return [
          center[0] + ax * Math.cos(th) - ay * Math.sin(th),
          center[1] + ax * Math.sin(th) + ay * Math.cos(th),
        ]
      }
      writePoint(w, center)
      w.f64(a)
      w.f64(b)
      w.f64(theta)
      w.f64(a0)
      w.f64(a1)
      w.u8(bool(e['ccw'], true) ? 1 : 0)
      writePoint(w, geomStart ?? at(a0))
      writePoint(w, optionalPoint(e['end'], 'ellipse_arc.end') ?? at(a1))
      break
    }
    case 'spline': {
      w.u8(EdgeKind.spline)
      const start = point(e['start'], 'spline.start')
      writePoint(w, start)
      writePoint(w, point(e['c1'], 'spline.c1'))
      writePoint(w, point(e['c2'], 'spline.c2'))
      writePoint(w, point(e['end'], 'spline.end'))
      break
    }
    case 'fit_spline': {
      w.u8(EdgeKind.fit_spline)
      const poles = e['poles']
      const knots = e['knots']
      if (!Array.isArray(poles)) fail('fit_spline.poles is not an array')
      if (!Array.isArray(knots)) fail('fit_spline.knots is not an array')
      w.u32(poles.length)
      for (let i = 0; i < poles.length; i++) writePoint(w, point(poles[i], `fit_spline.poles[${i}]`))
      w.u32(knots.length)
      for (let i = 0; i < knots.length; i++) w.f64(num(knots[i], `fit_spline.knots[${i}]`))
      break
    }
    case 'ellipse': {
      w.u8(EdgeKind.ellipse)
      const center = point(e['center'], 'ellipse.center')
      const a = e['a'] === undefined ? 0 : num(e['a'], 'ellipse.a')
      const b = e['b'] === undefined ? 0 : num(e['b'], 'ellipse.b')
      const theta = e['theta'] === undefined ? 0 : num(e['theta'], 'ellipse.theta')
      writePoint(w, center)
      w.f64(a)
      w.f64(b)
      w.f64(theta)
      break
    }
    default:
      fail(`unknown edge kind ${String(kind)}`)
  }
  // The dict's explicit start, trailing every kind: the polygon reader pushes
  // it and nothing else, so an absent key is "no push".
  w.u8(geomStart === null ? 0 : 1)
  if (geomStart !== null) writePoint(w, geomStart)
}

/** Encode one op request. `aux` is the sample count, `loops` one or more
 *  polygon loops, and `pt` the probe of `pointInLoop`. */
export function encodeProfileLoops(
  op: ProfileLoopOpCode,
  aux: number,
  loops: LoopEdge[][],
  pt?: number[],
): Uint8Array {
  const w = new ByteWriter()
  w.u32(PROFILE_LOOPS_MAGIC_IN)
  w.u8(PROFILE_LOOPS_VERSION)
  w.u8(op)
  w.u32(aux)
  if (op === ProfileLoopOp.pointInLoop) writePoint(w, point(pt, 'pointInLoop.point'))
  w.u32(loops.length)
  for (const loop of loops) {
    w.u32(loop.length)
    for (const e of loop) writeEdge(w, e)
  }
  return w.done()
}

/** A reader over one response, with the header already checked. */
export class ProfileLoopsReply {
  private r: ByteReader

  constructor(buf: Uint8Array) {
    this.r = new ByteReader(buf)
    const magic = this.r.u32()
    if (magic !== PROFILE_LOOPS_MAGIC_OUT) fail(`bad output magic ${magic.toString(16)}`)
    const version = this.r.u8()
    if (version !== PROFILE_LOOPS_VERSION) fail(`unsupported output version ${version}`)
  }

  points(): number[][] {
    const n = this.r.u32()
    const out: number[][] = []
    for (let i = 0; i < n; i++) out.push([this.r.f64(), this.r.f64()])
    return out
  }

  f64(): number {
    return this.r.f64()
  }

  bool(): boolean {
    return this.r.u8() !== 0
  }

  point(): number[] {
    return [this.r.f64(), this.r.f64()]
  }

  u32(): number {
    return this.r.u32()
  }
}
