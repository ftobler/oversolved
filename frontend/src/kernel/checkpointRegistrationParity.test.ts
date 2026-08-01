// Equivalence gate for `double-registration-pass`: the post-loop checkpoint pass
// (`_snapshotWithBrepGeometry`) may skip a body the feature loop already registered into
// the very snapshot the pass is rehydrating, but only if what a checkpoint OFFERS stays
// identical. Element ids move (module-global counter), so equivalence is stated
// semantically via `repoSemanticFingerprint`, never by byte comparison.
//
// The harness is deliberately OCC-free: `fakeMeta` stands in for both the render
// tessellation and the mesh-free metadata extractor, so both registration paths see
// byte-identical geometry and any fingerprint drift is the builder's doing.

import { describe, it, expect } from 'vitest'
import { build, bodiesNeedingCheckpointRegistration, bodyVersion, type BuildDeps, type FeatureResult } from './builder'
import { Repository } from './query'
import { faceGeometryHash, edgeGeometryHash } from './geomHash'
import { repoSemanticFingerprint, checkpointFingerprints } from './repoFingerprintTestUtil'
import type { Body, BuildState } from './types3d'

// ─── fake geometry ───

// A body's whole geometry is a pure function of its shape handle, so a modification
// (which mints a new handle) is visible in every registered payload.
function faceData(shape: number): Array<Record<string, unknown>> {
  return [
    { centroid: [0, 0, shape], normal: [0, 0, 1], surface_type: 'flatface', classifiers: ['cls_planar'] },
    { centroid: [shape, 0, 0], normal: [1, 0, 0], surface_type: 'flatface', classifiers: [] },
  ]
}

function edgesOf(shape: number): Array<Record<string, unknown>> {
  return [
    { kind: 'line', start: [0, 0, 0], end: [shape, 0, 0] },
    { kind: 'circle', center: [0, 0, shape], radius: 2, axis: [0, 0, 1], x_axis: [1, 0, 0] },
  ]
}

function verticesOf(shape: number): number[][] {
  return [[0, 0, 0], [shape, 0, 0]]
}

function fakeMeta(body: Body, isFallback = false): Record<string, unknown> {
  const shape = Number(body.shape)
  return {
    mesh: {
      vertices: [], faces: [], triangle_to_face: [], face_queries: [],
      face_data: faceData(shape),
      is_fallback: isFallback,
    },
    edges: edgesOf(shape),
    edge_queries: ['@eq0', '@eq1'],
    vertices: verticesOf(shape),
    vertex_queries: ['@vq0', '@vq1'],
    vertex_uuids: [`u_${body.id}_v0`, null],
  }
}

// Construction UUIDs are keyed by the in-build geom hash, so they follow the shape.
function refreshNames(body: Body): void {
  const shape = Number(body.shape)
  body.face_names = Object.fromEntries(
    faceData(shape).map((f, i) => [
      faceGeometryHash(f.centroid as number[], f.normal as number[]), `u_${body.id}_f${i}`,
    ]),
  )
  body.edge_names = Object.fromEntries(
    edgesOf(shape).map((e, i) => [edgeGeometryHash(e), `u_${body.id}_e${i}`]),
  )
}

// ─── stub build deps ───

// Shape handles must be a pure function of the document, never of a counter: the fake
// payloads encode the handle, so a rebuild has to reproduce the exact same handles or a
// cold-build fingerprint could not be compared against a partial-rebuild one. (This is
// not about `bodyVersion`, which is never compared across builds.)
const SHAPE_SEED: Record<string, number> = { f1: 100, f2: 200, f6: 600, heavy: 900 }

function shapeOf(n: number): Body['shape'] {
  return n as unknown as Body['shape']
}

function makeBody(fid: string, seed: number): Body {
  const body: Body = {
    id: 'body_' + fid,
    created_by: fid,
    modified_by: [],
    shape: shapeOf(seed),
    sketch_id: 'sk_' + fid,
    brep_diff: null,
    profile_queries: ['@profile_' + fid],
  }
  refreshNames(body)
  return body
}

const solve = (
  feature: Record<string, unknown>,
  _repo: Repository,
  bodyStore: Record<string, Body>,
): FeatureResult => {
  const fid = String(feature.id ?? '')
  if (feature.kind === 'make') {
    bodyStore['body_' + fid] = makeBody(fid, SHAPE_SEED[fid] ?? 1000)
  } else if (feature.kind === 'modify') {
    const body = bodyStore[String(feature.target)]
    if (body) {
      body.shape = shapeOf(Number(body.shape) + 1)
      body.modified_by = [...body.modified_by, fid]
      refreshNames(body)
    }
  }
  return { status: 'ok' }
}

interface HarnessOptions {
  /** Body ids whose mesh comes back flagged as a fallback (no real B-rep behind it). */
  fallbackBodies?: string[]
  /** Body ids the METADATA extractor drops while tessellation still succeeds, mimicking
   *  `extractBrepMetadata`'s per-body failure exit (it logs and omits the body). */
  metaOmits?: string[]
  /** Body ids whose blob carries edges/vertices but no `edge_queries`/`vertex_queries`. */
  queryless?: string[]
}

class Harness {
  /** One entry per face-ancestry registration pass, in call order. Both the loop pass and
   *  the checkpoint pass go through `brepDiffNewFaceHashes`, so this counts registrations. */
  faceRegistrations: string[] = []
  edgeRegistrations: string[] = []

  readonly options: HarnessOptions

  constructor(options: HarnessOptions = {}) {
    this.options = options
  }

  private meta = (
    bodyStore: Record<string, Body>,
    isMetadataPath: boolean,
  ): Record<string, Record<string, unknown>> =>
    Object.fromEntries(
      Object.entries(bodyStore)
        .filter(([bid, body]) => body.shape != null
          && !(isMetadataPath && (this.options.metaOmits?.includes(bid) ?? false)))
        .map(([bid, body]) => {
          const blob = fakeMeta(body, this.options.fallbackBodies?.includes(bid) ?? false)
          if (this.options.queryless?.includes(bid)) {
            delete blob.edge_queries
            delete blob.vertex_queries
          }
          return [bid, blob]
        }),
    )

  deps(): BuildDeps {
    return {
      trySolveFeature: solve,
      postRegister: () => {},
      initGlobalRepo: () => new Repository(),
      tessellateBodies: (store) => this.meta(store, false),
      extractBrepMetadata: (store) => this.meta(store, true),
      brepDiffNewFaceHashes: (body) => { this.faceRegistrations.push(body.id); return new Set() },
      brepDiffNewEdgeHashes: (body) => { this.edgeRegistrations.push(body.id); return new Set() },
      brepDiffNewVertexHashes: () => new Set(),
    }
  }

  run(spec: Record<string, unknown>, prevState?: BuildState | null) {
    return build(spec, { prevState: prevState ?? null }, this.deps())
  }

  countFaces(bodyId: string): number {
    return this.faceRegistrations.filter((b) => b === bodyId).length
  }
}

// A stack that covers every registration path: two created bodies, a modification of
// each, a suppressed feature mid-stack, and a body created after the suppression.
const DOC_FEATURES: Array<Record<string, unknown>> = [
  { id: 'f1', kind: 'make' },
  { id: 'f2', kind: 'make' },
  { id: 'f3', kind: 'modify', target: 'body_f2' },
  { id: 'f4', kind: 'note', suppressed: true },
  { id: 'f5', kind: 'modify', target: 'body_f1' },
  { id: 'f6', kind: 'make' },
]

const doc = (edit?: Record<string, unknown>) => ({
  features: DOC_FEATURES.map((f) => (edit && f.id === edit.id ? { ...f, ...edit } : { ...f })),
})

describe('checkpoint registration parity', () => {
  it('a cold build registers every body it snapshots', () => {
    const h = new Harness()
    const r = h.run(doc())
    for (const fid of ['f1', 'f2', 'f3', 'f5', 'f6']) {
      expect((r.result as Record<string, Record<string, unknown>>)[fid].status).toBe('ok')
    }
    const fps = checkpointFingerprints(r._build_state.checkpoints)
    // Every checkpoint offers the bodies alive at that point, with their geometry.
    expect(fps.f1).toContain('body_f1')
    expect(fps.f1).not.toContain('body_f2')
    expect(fps.f6).toContain('body_f6')
  })

  it('a fully-clean rebuild offers byte-identical checkpoints', () => {
    const h = new Harness()
    const cold = h.run(doc())
    const clean = h.run(doc(), cold._build_state)
    expect(clean._build_state.feature_order).toEqual(cold._build_state.feature_order)
    expect(checkpointFingerprints(clean._build_state.checkpoints))
      .toEqual(checkpointFingerprints(cold._build_state.checkpoints))
  })

  it('a partial rebuild offers the same checkpoints as a cold build', () => {
    const h = new Harness()
    const cold = h.run(doc())
    // A cosmetic edit on f5: dirties the tail (f5, f6) without changing any geometry,
    // so the rebuilt checkpoints must be indistinguishable from the cold ones.
    const partial = h.run(doc({ id: 'f5', label: 'renamed' }), cold._build_state)
    expect(checkpointFingerprints(partial._build_state.checkpoints))
      .toEqual(checkpointFingerprints(cold._build_state.checkpoints))
  })

  it('a rebuild dirty from the first feature offers the same checkpoints', () => {
    const h = new Harness()
    const cold = h.run(doc())
    const full = h.run(doc({ id: 'f1', label: 'renamed' }), cold._build_state)
    expect(checkpointFingerprints(full._build_state.checkpoints))
      .toEqual(checkpointFingerprints(cold._build_state.checkpoints))
  })

  it('a modified body re-registers at the checkpoint where it changed', () => {
    const h = new Harness()
    const cold = h.run(doc())
    const fps = checkpointFingerprints(cold._build_state.checkpoints)
    // body_f2 is created at f2 (shape 200) and modified at f3 (shape 201). The skip must
    // not be so eager that f3 keeps offering the pre-modification geometry.
    // The fingerprint nests JSON inside JSON, so payload keys arrive escaped; match on
    // the shape-derived coordinates alone.
    expect(fps.f2).toContain('[200,0,0]')
    expect(fps.f2).not.toContain('[201,0,0]')
    expect(fps.f3).toContain('[201,0,0]')
    expect(fps.f3).not.toContain('[200,0,0]')
    expect(fps.f2).not.toEqual(fps.f3)
  })

  it('a suppressed feature offers exactly what the feature before it offered', () => {
    const h = new Harness()
    const cold = h.run(doc())
    const fps = checkpointFingerprints(cold._build_state.checkpoints)
    // f4 is suppressed: it snapshots without solving and without registering, so its
    // checkpoint must carry the f3 world unchanged.
    expect(fps.f4).toEqual(fps.f3)
  })

  it('the fingerprint is not vacuous: a mutated payload changes it', () => {
    // Red-green proof for the gate itself. Without this, a fingerprint that silently
    // dropped every payload would make the whole parity suite pass by construction.
    const h = new Harness()
    const cold = h.run(doc())
    const snapshot = cold._build_state.checkpoints.f3.repo_snapshot as Record<string, unknown>
    const before = repoSemanticFingerprint(snapshot)
    const elements = snapshot.elements as Record<string, Record<string, unknown>>
    const victim = Object.keys(elements).find((eid) => elements[eid]?.type === 'flatface')
    expect(victim).toBeDefined()
    elements[victim!] = { ...elements[victim!], centroid: [7, 7, 7] }
    expect(repoSemanticFingerprint(snapshot)).not.toEqual(before)
  })

  it('the fingerprint sees a payload disappear', () => {
    const h = new Harness()
    const cold = h.run(doc())
    const snapshot = cold._build_state.checkpoints.f3.repo_snapshot as Record<string, unknown>
    const before = repoSemanticFingerprint(snapshot)
    const elements = snapshot.elements as Record<string, Record<string, unknown>>
    const victim = Object.keys(elements).find((eid) => elements[eid]?.type === 'vertex')
    expect(victim).toBeDefined()
    delete elements[victim!]
    expect(repoSemanticFingerprint(snapshot)).not.toEqual(before)
  })

  it('the fingerprint ignores redundant re-registration of an identical payload', () => {
    // The property that makes "unchanged fingerprint" the right equivalence: a duplicate
    // under one key is collapsed by `repoFromSnapshot` before any consumer sees it.
    const h = new Harness()
    const cold = h.run(doc())
    const snapshot = cold._build_state.checkpoints.f3.repo_snapshot as Record<string, unknown>
    const before = repoSemanticFingerprint(snapshot)
    const elements = snapshot.elements as Record<string, unknown>
    const ancestral = snapshot.ancestral as Record<string, { set: string[]; eids: string[] }>
    const key = Object.keys(ancestral)[0]
    const source = ancestral[key].eids[0]
    elements['el_clone'] = JSON.parse(JSON.stringify(elements[source]))
    ancestral[key].eids.push('el_clone')
    expect(repoSemanticFingerprint(snapshot)).toEqual(before)
  })
})

describe('bodiesNeedingCheckpointRegistration', () => {
  const body = (id: string, shape: number, modifiedBy: string[] = []): Body => ({
    id, created_by: 'f1', modified_by: modifiedBy, shape: shapeOf(shape),
    sketch_id: '', brep_diff: null, profile_queries: [],
  })

  it('skips a body whose registered version still matches', () => {
    const b = body('body_a', 1)
    const registered = new Map([['body_a', bodyVersion(b)]])
    expect(bodiesNeedingCheckpointRegistration({ body_a: b }, registered)).toEqual(new Set())
  })

  it('registers a body whose shape handle moved', () => {
    const registered = new Map([['body_a', bodyVersion(body('body_a', 1))]])
    expect(bodiesNeedingCheckpointRegistration({ body_a: body('body_a', 2) }, registered))
      .toEqual(new Set(['body_a']))
  })

  it('registers a body whose modified_by grew', () => {
    const registered = new Map([['body_a', bodyVersion(body('body_a', 1))]])
    expect(bodiesNeedingCheckpointRegistration({ body_a: body('body_a', 1, ['f2']) }, registered))
      .toEqual(new Set(['body_a']))
  })

  it('registers a body absent from the map', () => {
    expect(bodiesNeedingCheckpointRegistration({ body_a: body('body_a', 1) }, new Map()))
      .toEqual(new Set(['body_a']))
  })

  it('ignores a registered body that is absent from the checkpoint', () => {
    const registered = new Map([['body_gone', 'body_gone|f1|1|0']])
    expect(bodiesNeedingCheckpointRegistration({}, registered)).toEqual(new Set())
  })
})

describe('checkpoint registration cost', () => {
  // The win, stated as a count. An untouched body used to be re-registered into every
  // dirty checkpoint behind it, so the cost of one edit grew with the depth of the stack.
  function untouchedPlusTail(tailLength: number): Record<string, unknown> {
    const features: Array<Record<string, unknown>> = [{ id: 'heavy', kind: 'make' }]
    for (let i = 0; i < tailLength; i++) {
      features.push({ id: 'n' + i, kind: 'make' })
      features.push({ id: 'm' + i, kind: 'modify', target: 'body_n' + i })
    }
    return { features }
  }

  it('registers an untouched body once regardless of how many features sit behind it', () => {
    const short = new Harness()
    short.run(untouchedPlusTail(2))
    const long = new Harness()
    long.run(untouchedPlusTail(6))
    expect(short.countFaces('body_heavy')).toBe(1)
    expect(long.countFaces('body_heavy')).toBe(1)
  })

  it('still registers a body once per version it reaches', () => {
    // The counterweight to the test above: a body that actually changes must be
    // registered again, or a checkpoint would offer stale geometry.
    const h = new Harness()
    h.run(doc())
    // body_f2: created at f2, modified at f3 -> two versions, one registration each.
    expect(h.countFaces('body_f2')).toBe(2)
    // body_f1: created at f1, modified at f5.
    expect(h.countFaces('body_f1')).toBe(2)
  })
})

describe('fallback meshes', () => {
  /** Ids of the face-ancestry elements a checkpoint carries for one body. */
  function faceElements(state: BuildState, fid: string, bodyId: string): string[] {
    const elements = (state.checkpoints[fid].repo_snapshot as Record<string, unknown>)
      .elements as Record<string, Record<string, unknown>>
    return Object.keys(elements).filter(
      (eid) => elements[eid]?.body_id === bodyId && elements[eid]?.face_index !== undefined,
    )
  }

  it('never register face ancestry, in either pass', () => {
    // The loop refuses to identify faces off a fallback mesh (there is no real B-rep
    // behind it, so the payloads would be fiction). The checkpoint pass must agree,
    // otherwise which pass ran last decides what a query resolves to.
    const h = new Harness({ fallbackBodies: ['body_f1'] })
    const r = h.run({ features: [{ id: 'f1', kind: 'make' }, { id: 'f2', kind: 'make' }] })
    const state = r._build_state
    for (const fid of ['f1', 'f2']) expect(faceElements(state, fid, 'body_f1')).toEqual([])
    expect(h.countFaces('body_f1')).toBe(0)
    // Control: the non-fallback body in the same build does register its faces, and
    // the fallback body still registers everything that does not come off the mesh.
    expect(faceElements(state, 'f2', 'body_f2').length).toBe(2)
    expect(checkpointFingerprints(state.checkpoints).f1).toContain('straightedge')
  })
})

describe('a body the solve loop could not identify', () => {
  /** Ids of the ancestry elements a checkpoint carries for one body, by payload field. */
  function elementsOf(state: BuildState, fid: string, bodyId: string, field: string): string[] {
    const elements = (state.checkpoints[fid].repo_snapshot as Record<string, unknown>)
      .elements as Record<string, Record<string, unknown>>
    return Object.keys(elements).filter(
      (eid) => elements[eid]?.body_id === bodyId && elements[eid]?.[field] !== undefined,
    )
  }

  // `extractBrepMetadata` fails per body and silently: it logs and omits that body from
  // its output. `tessellateBodies` is a different producer and may still succeed, which
  // is what makes the checkpoint pass a RECOVERY path rather than a duplicate of the
  // loop. Recording such a body as registered would skip the only pass that can save it.
  it('is still registered by the checkpoint pass, off the render mesh', () => {
    const h = new Harness({ metaOmits: ['body_f1'] })
    const r = h.run({ features: [{ id: 'f1', kind: 'make' }, { id: 'f2', kind: 'make' }] })
    const state = r._build_state
    // f2 is the final checkpoint, the one holding the render tessellation.
    expect(elementsOf(state, 'f2', 'body_f1', 'face_index').length).toBe(2)
    expect(elementsOf(state, 'f2', 'body_f1', 'edge_index').length).toBe(2)
    // Control: the body the metadata path CAN read is unaffected.
    expect(elementsOf(state, 'f2', 'body_f2', 'face_index').length).toBe(2)
  })

  // Both passes now share one registrar, so a blob with geometry but no query lists
  // registers with length-matched placeholders instead of being suppressed. The lists are
  // presence/length gates in the registrars; their content is never read.
  it('registers edges and vertices from a blob carrying no query lists', () => {
    const h = new Harness({ metaOmits: ['body_f1'], queryless: ['body_f1'] })
    const r = h.run({ features: [{ id: 'f1', kind: 'make' }, { id: 'f2', kind: 'make' }] })
    const state = r._build_state
    expect(elementsOf(state, 'f2', 'body_f1', 'edge_index').length).toBe(2)
    expect(elementsOf(state, 'f2', 'body_f1', 'vertex_index').length).toBe(2)
  })
})
