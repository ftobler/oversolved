import { vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { IDBFactory } from 'fake-indexeddb'
import { resetBundleDbConnection } from './bundleCache'
import { anchorIdFor, BUNDLE_SCHEMA, type Anchor, type PartBundle } from './partBundle'
import type { Transform3D } from '../types/cad'
import type { RelayService } from './worker/solverProtocol'

// Shared fixtures for the solveAssembly suites: a fake relay, fake solver
// functions that run on the main thread, and bundle builders. Split out so each
// suite file stays under the size limit without duplicating the scaffolding.

export function freshDb(): void {
  globalThis.indexedDB = new IDBFactory()
  resetBundleDbConnection()
}

/**
 * The shared mate-wire fixture (tests/fixtures/mate_wire.txt), also read by the
 * Rust wire tests. Magic and stride drift between the two languages fails here
 * instead of silently mis-solving.
 */
export function readMateWireFixture(): Record<string, number> {
  // Derived from this module's own location, the way loadPkgNode.ts finds its
  // build artifacts, not from the process cwd. A `new URL(relative,
  // import.meta.url)` here is rewritten by Vite's asset handling and does not
  // survive as a file URL for a path outside the frontend root.
  const here = path.dirname(fileURLToPath(import.meta.url))
  const text = readFileSync(path.resolve(here, '../../../tests/fixtures/mate_wire.txt'), 'utf8')
  const out: Record<string, number> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    out[key] = value.startsWith('0x') ? parseInt(value, 16) : Number(value)
  }
  return out
}

export function identityTransform(): Transform3D {
  return { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
}

export function translationTransform(tx: number, ty: number, tz: number): Transform3D {
  return { tx, ty, tz, qx: 0, qy: 0, qz: 0, qw: 1 }
}

export function makeBundle(doc_id: string, content_hash: string, overrides?: Partial<PartBundle>): PartBundle {
  return {
    doc_id,
    content_hash,
    schema: BUNDLE_SCHEMA,
    bodies: [
      {
        mesh: {
          vertices: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 10, 10, 0]),
          indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
          faceIdsPerTriangle: new Uint32Array([0, 0]),
        },
        edges: [],
        entityAnchors: { faces: [], edges: [], vertices: [] },
      },
    ],
    anchors: {
      a1: {
        kind: 'point',
        point: [0, 0, 0],
        axis: [0, 0, 1],
        geom_hash: '@gdf|0.000|0.000|0.000|0.000|0.000|1.000',
        created_by: 'feat1',
      },
      a2: {
        kind: 'point',
        point: [10, 0, 0],
        axis: [0, 0, 1],
        geom_hash: '@gdf|10.000|0.000|0.000|0.000|0.000|1.000',
        created_by: 'feat1',
      },
    },
    ...overrides,
  }
}

// A bundle whose anchor ids are the deterministic shortHash(geom_hash + kind),
// standing in for a bundle built by the post-deterministic-id production code.
export function makeDeterministicBundle(doc_id: string, content_hash: string): PartBundle {
  const bundle = makeBundle(doc_id, content_hash)
  const anchors: Record<string, Anchor> = {}
  for (const a of Object.values(bundle.anchors)) {
    anchors[anchorIdFor(a.geom_hash, a.kind)] = a
  }
  return { ...bundle, anchors }
}

// A bundle whose a1 carries a real axis (a plane), for the wire tests that
// exercise an axis-reading mate. `makeBundle`'s a1 is a vertex, whose axis is
// the placeholder [0, 0, 1] the solve now refuses for an axis reader.
export function makeAxialBundle(doc_id: string, content_hash: string): PartBundle {
  return makeBundle(doc_id, content_hash, {
    anchors: {
      a1: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1], geom_hash: '@gdf|a1', created_by: 'feat1' },
      a2: { kind: 'point', point: [10, 0, 0], axis: [0, 0, 1], geom_hash: '@gdf|a2', created_by: 'feat1' },
    },
  })
}

export function makeRelay(): { relay: RelayService; partDocs: Map<string, Record<string, unknown>> } {
  const partDocs = new Map<string, Record<string, unknown>>()
  return {
    relay: {
      requestPartDoc: vi.fn().mockImplementation(async (doc_id: string) => {
        const doc = partDocs.get(doc_id)
        if (!doc) throw new Error(`part doc not found: ${doc_id}`)
        return doc
      }),
      requestBuildBundle: vi.fn().mockImplementation(async (doc_id: string, content_hash: string, _spec: Record<string, unknown>) => {
        return makeBundle(doc_id, content_hash)
      }),
    },
    partDocs,
  }
}

/** Build a no-op solver that echoes the input transforms unchanged. */
export function makeEchoSolver(): (input: Uint8Array) => Uint8Array {
  return (input: Uint8Array): Uint8Array => {
    // Decode the input to get the initial params.
    // The input header is: magic(4) + n_bodies(4) + n_params(4) + n_mates(4) + n_fixed(4)
    // Then n_bodies * 4 bytes of body indices, then paramsInitial.
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
    const nBodies = view.getUint32(4, true)
    const nParams = nBodies * 7
    const paramsOffset = 20 + nBodies * 4
    const params: number[] = []
    for (let i = 0; i < nParams; i++) {
      params.push(view.getFloat32(paramsOffset + i * 4, true))
    }

    // Build output: magic(4) + n_params(4) + status(1) + params(nParams*4) + diagnostics(28)
    const outSize = 4 + 4 + 1 + nParams * 4 + 4 + 28  // +4 for the n_mates header
    const outBuf = new ArrayBuffer(outSize)
    const out = new DataView(outBuf)
    let pos = 0
    out.setUint32(pos, 0x3252544D, true); pos += 4  // MATE_MAGIC_OUT
    out.setUint32(pos, nParams, true); pos += 4
    out.setUint8(pos, 0); pos += 1  // fully constrained
    for (let i = 0; i < nParams; i++) {
      out.setFloat32(pos, params[i], true); pos += 4
    }
    out.setUint32(pos, 0, true); pos += 4  // n_mates
    out.setFloat64(pos, 0.0, true); pos += 8  // residual_norm
    out.setUint32(pos, 13, true); pos += 4  // rank
    out.setUint32(pos, 1, true); pos += 4  // dof
    out.setUint32(pos, 1, true); pos += 4  // iters
    out.setFloat64(pos, 0.001, true); pos += 8  // ms
    return new Uint8Array(outBuf)
  }
}

/** Build a solver that translates body1 by (dx,0,0). */
export function makeTranslateSolver(dx: number): (input: Uint8Array) => Uint8Array {
  return (input: Uint8Array): Uint8Array => {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
    const nBodies = view.getUint32(4, true)
    const nParams = nBodies * 7
    const paramsOffset = 20 + nBodies * 4
    const params: number[] = []
    for (let i = 0; i < nParams; i++) {
      params.push(view.getFloat32(paramsOffset + i * 4, true))
    }
    // Translate the second body (indices 7-13)
    if (nBodies >= 2) {
      params[7] += dx
    }

    const outSize = 4 + 4 + 1 + nParams * 4 + 4 + 28  // +4 for the n_mates header
    const outBuf = new ArrayBuffer(outSize)
    const out = new DataView(outBuf)
    let pos = 0
    out.setUint32(pos, 0x3252544D, true); pos += 4
    out.setUint32(pos, nParams, true); pos += 4
    out.setUint8(pos, 0); pos += 1
    for (let i = 0; i < nParams; i++) {
      out.setFloat32(pos, params[i], true); pos += 4
    }
    out.setUint32(pos, 0, true); pos += 4  // n_mates
    out.setFloat64(pos, 0.0, true); pos += 8
    out.setUint32(pos, 13, true); pos += 4
    out.setUint32(pos, 1, true); pos += 4
    out.setUint32(pos, 1, true); pos += 4
    out.setFloat64(pos, 0.001, true); pos += 8
    return new Uint8Array(outBuf)
  }
}

/**
 * An echo solver that scales `bodyIndex`'s whole quaternion by `scale` before
 * returning it -- standing in for the soft unit-norm residual only holding
 * |q| to within LM's tolerance, not exactly (Stage C).
 */
export function makeScaledQwSolver(bodyIndex: number, scale: number): (input: Uint8Array) => Uint8Array {
  return (input: Uint8Array): Uint8Array => {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
    const nBodies = view.getUint32(4, true)
    const nParams = nBodies * 7
    const paramsOffset = 20 + nBodies * 4
    const params: number[] = []
    for (let i = 0; i < nParams; i++) {
      params.push(view.getFloat32(paramsOffset + i * 4, true))
    }
    for (let c = 3; c < 7; c++) params[bodyIndex * 7 + c] *= scale

    const outSize = 4 + 4 + 1 + nParams * 4 + 4 + 28  // +4 for the n_mates header
    const outBuf = new ArrayBuffer(outSize)
    const out = new DataView(outBuf)
    let pos = 0
    out.setUint32(pos, 0x3252544D, true); pos += 4
    out.setUint32(pos, nParams, true); pos += 4
    out.setUint8(pos, 0); pos += 1
    for (let i = 0; i < nParams; i++) {
      out.setFloat32(pos, params[i], true); pos += 4
    }
    out.setUint32(pos, 0, true); pos += 4  // n_mates
    out.setFloat64(pos, 0.0, true); pos += 8
    out.setUint32(pos, 13, true); pos += 4
    out.setUint32(pos, 1, true); pos += 4
    out.setUint32(pos, 1, true); pos += 4
    out.setFloat64(pos, 0.001, true); pos += 8
    return new Uint8Array(outBuf)
  }
}

export interface DecodedMateRecord {
  kindCode: number
  bodyA: number
  bodyB: number
  anchorKindA: number
  anchorKindB: number
  pointA: [number, number, number]
  axisA: [number, number, number]
  pointB: [number, number, number]
  axisB: [number, number, number]
  offset: [number, number, number]
  angle: number
  weight: number
}

export interface DecodedInput {
  nBodies: number
  fixedMask: number[]
  mates: DecodedMateRecord[]
}

/** Decode a mate-solver input buffer far enough to inspect bodies + mate records. */
export function decodeInput(input: Uint8Array): DecodedInput {
  const v = new DataView(input.buffer, input.byteOffset, input.byteLength)
  const nBodies = v.getUint32(4, true)
  const nParams = v.getUint32(8, true)
  const nMates = v.getUint32(12, true)
  let pos = 20 + nBodies * 4 + nParams * 4
  const maskLen = Math.ceil(nBodies / 8)
  const fixedMask: number[] = []
  for (let i = 0; i < maskLen; i++) fixedMask.push(v.getUint8(pos + i))
  pos += maskLen
  const readVec = (): [number, number, number] => {
    const out: [number, number, number] = [
      v.getFloat32(pos, true), v.getFloat32(pos + 4, true), v.getFloat32(pos + 8, true),
    ]
    pos += 12
    return out
  }
  const mates: DecodedMateRecord[] = []
  for (let i = 0; i < nMates; i++) {
    const kindCode = v.getUint8(pos); pos += 1
    const bodyA = v.getUint32(pos, true); pos += 4
    const bodyB = v.getUint32(pos, true); pos += 4
    const anchorKindA = v.getUint8(pos); pos += 1
    const anchorKindB = v.getUint8(pos); pos += 1
    const pointA = readVec()
    const axisA = readVec()
    const pointB = readVec()
    const axisB = readVec()
    pos += 1  // flags
    const offset = readVec()
    pos += 4 + 4  // ratio + radius
    const angle = v.getFloat32(pos, true); pos += 4
    pos += 24  // perp_a (3 f32) + perp_b (3 f32)
    const weight = v.getFloat32(pos, true); pos += 4
    mates.push({ kindCode, bodyA, bodyB, anchorKindA, anchorKindB, pointA, axisA, pointB, axisB, offset, angle, weight })
  }
  return { nBodies, fixedMask, mates }
}

/** An echo solver that also captures the decoded input for inspection. */
export function makeCaptureSolver(): { solver: (input: Uint8Array) => Uint8Array; captured: { input?: DecodedInput } } {
  const echo = makeEchoSolver()
  const captured: { input?: DecodedInput } = {}
  return {
    solver: (input: Uint8Array) => {
      captured.input = decodeInput(input)
      return echo(input)
    },
    captured,
  }
}
