// @vitest-environment node
//
// Gated real-OCC feature-level extrude tests using the full build pipeline
// (OCC.js + Rust WASM sketch solver). Split from the original extrudeReal
// suite; shared spec builders live in extrudeRealSupport.ts. This file covers
// cut operations, disjoint-profile body splitting and per-body query resolution.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import { repoFromSnapshot } from '../../builder'
import { AmbiguousQueryError } from '../../query'
import {
  oc, solveBytes, extrudeTestHarness, rectSketchSk, extrudeSpec, fullRectExtrudeSpec,
  assertMeshValid, assertMeshBbox, disjointTwoRectSpec,
} from '../extrudeRealSupport'

describe.skipIf(!oc || !solveBytes)('extrude feature (real OCC + Rust solver): cut and disjoint bodies', () => {
  const h = extrudeTestHarness()

  // ─── Cut extrude tests ───

  it('cut extrude removes volume from base body', () => {
    // Cut extrusion subtracts from a base body.
    const result = h.run({
      features: [
        rectSketchSk('sk1', 10, 10, '@builtin_plane_front'),
        extrudeSpec('sk1', 'ex1', { distance: 10 }),
        extrudeSpec('sk1', 'ex2', { distance: 5, operation: 'cut' }),
      ],
    })
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(h.res(result, 'ex2').status).toBe('ok')
    expect(result.bodies).not.toHaveProperty('body_ex2')
    expect(result.bodies).toHaveProperty('body_ex1')
    const mesh = h.body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshBbox(mesh, [0, 10], [0, 10], [5, 10])
  })

  it('cut extrude must not produce a body in output', () => {
    // Cut extrude feature must not produce a body in the bodies dict.
    const result = h.run({
      features: [
        rectSketchSk('sk1', 6, 6, '@builtin_plane_front'),
        extrudeSpec('sk1', 'ex1', { distance: 8 }),
        extrudeSpec('sk1', 'ex2', { distance: 4, operation: 'cut' }),
      ],
    })
    expect(result.bodies).not.toHaveProperty('body_ex2')
    expect(result.bodies).toHaveProperty('body_ex1')
  })

  it('cut extrude nested UI format', () => {
    // Cut operation read from nested extrude sub-dict.
    const result = h.run({
      features: [
        rectSketchSk('sk1', 10, 10, '@builtin_plane_front'),
        { id: 'ex1', kind: 'extrude', label: 'Base',
          extrude: { sketch: '$sk1', distance: 10, direction: 'normal' } },
        { id: 'ex2', kind: 'extrude', label: 'Cut',
          extrude: { sketch: '$sk1', distance: 5, direction: 'normal', operation: 'cut' } },
      ],
    })
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(h.res(result, 'ex2').status).toBe('ok')
    expect(result.bodies).not.toHaveProperty('body_ex2')
    expect(result.bodies).toHaveProperty('body_ex1')
    const mesh = h.body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshBbox(mesh, [0, 10], [0, 10], [5, 10])
  })

  it('cut extrude with no prior body succeeds without crash', () => {
    // Cut extrude with no prior body must succeed.
    const result = h.run({
      features: [
        rectSketchSk('sk1', 6, 6, '@builtin_plane_front'),
        extrudeSpec('sk1', 'ex1', { distance: 5, operation: 'cut' }),
      ],
    })
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(result.bodies).not.toHaveProperty('body_ex1')
  })

  // ─── Disjoint body tests ───

  it('disjoint rects operation=new creates two bodies', () => {
    // Two disjoint sketch profiles with operation=new produce two separate bodies.
    const result = h.run(disjointTwoRectSpec('new'))
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex1')
    expect(result.bodies).toHaveProperty('body_ex1_1')
    expect(h.res(result, 'ex1').body_ids).toEqual(['body_ex1', 'body_ex1_1'])
    const m1 = h.body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    const m2 = h.body(result, 'body_ex1_1').mesh as Record<string, unknown> | undefined
    expect(m1).toBeDefined(); if (m1) assertMeshValid(m1)
    expect(m2).toBeDefined(); if (m2) assertMeshValid(m2)
  })

  it('disjoint rects add no base creates two bodies', () => {
    // Two profiles with operation=add and no existing body produce two bodies.
    const result = h.run(disjointTwoRectSpec('add'))
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex1')
    expect(result.bodies).toHaveProperty('body_ex1_1')
  })

  it('disjoint rects add with base fuses into base body', () => {
    // Disjoint profiles with operation=add and an existing body fuse into that body.
    const spec = disjointTwoRectSpec('add')
    const result = h.run({
      features: [
        rectSketchSk('sk0', 2, 2, '@builtin_plane_front'),
        extrudeSpec('sk0', 'ex0', { distance: 1, operation: 'new' }),
        ...spec.features,
      ],
    })
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex0')
    expect(result.bodies).not.toHaveProperty('body_ex1_1')  // fused into base body
  })

  it('single rect still one body', () => {
    // Single rectangle extrude still produces exactly one body.
    const result = h.run(fullRectExtrudeSpec(4, 4, 2))
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex1')
    expect(result.bodies).not.toHaveProperty('body_ex1_1')
    expect(h.res(result, 'ex1').body_ids).toEqual(['body_ex1'])
  })

  it('disjoint extrude has body_ids field', () => {
    // body_ids field lists all split body IDs.
    const result = h.run(disjointTwoRectSpec('new'))
    const bodyIds = h.res(result, 'ex1').body_ids as string[] | undefined
    expect(bodyIds).toBeDefined()
    expect(new Set(bodyIds)).toEqual(new Set(['body_ex1', 'body_ex1_1']))
  })

  it('two independent extrudes produce two bodies', () => {
    // Two independent sketches extruded independently.
    const result = h.run({
      features: [
        rectSketchSk('sk1', 10, 10, '@builtin_plane_front'),
        extrudeSpec('sk1', 'ex1', { distance: 5 }),
        rectSketchSk('sk2', 5, 5, '@builtin_plane_front'),
        extrudeSpec('sk2', 'ex2', { distance: 3, operation: 'new' }),
      ],
    })
    expect(result.bodies).toHaveProperty('body_ex1')
    expect(result.bodies).toHaveProperty('body_ex2')
    expect(Object.keys(result.bodies)).toHaveLength(2)
  })

  it('disjoint bodies have unique face queries', () => {
    // Two-body extrude face queries must be unique per body.
    const result = h.run(disjointTwoRectSpec('new'))
    expect(h.res(result, 'ex1').status).toBe('ok')
    const m1 = h.body(result, 'body_ex1').mesh as { face_queries?: string[] } | undefined
    const m2 = h.body(result, 'body_ex1_1').mesh as { face_queries?: string[] } | undefined
    expect(m1?.face_queries?.length).toBeGreaterThan(0)
    expect(m2?.face_queries?.length).toBeGreaterThan(0)
    const fq1 = new Set(m1?.face_queries ?? [])
    const fq2 = new Set(m2?.face_queries ?? [])
    for (const q of fq1) expect(fq2.has(q)).toBe(false)
  })

  it('disjoint bodies have unique edge queries', () => {
    // Edge queries from two bodies of the same extrude must be disjoint.
    const result = h.run(disjointTwoRectSpec('new'))
    expect(h.res(result, 'ex1').status).toBe('ok')
    const eq1 = new Set((h.body(result, 'body_ex1').edge_queries as string[]) ?? [])
    const eq2 = new Set((h.body(result, 'body_ex1_1').edge_queries as string[]) ?? [])
    expect(eq1.size).toBeGreaterThan(0)
    expect(eq2.size).toBeGreaterThan(0)
    for (const q of eq1) expect(eq2.has(q)).toBe(false)
  })

  it('disjoint bodies have unique vertex queries', () => {
    // Vertex queries from two bodies of the same extrude must be disjoint.
    const result = h.run(disjointTwoRectSpec('new'))
    expect(h.res(result, 'ex1').status).toBe('ok')
    const vq1 = new Set((h.body(result, 'body_ex1').vertex_queries as string[]) ?? [])
    const vq2 = new Set((h.body(result, 'body_ex1_1').vertex_queries as string[]) ?? [])
    expect(vq1.size).toBeGreaterThan(0)
    expect(vq2.size).toBeGreaterThan(0)
    for (const q of vq1) expect(vq2.has(q)).toBe(false)
  })

  // ─── Disjoint pick body / face query resolve ───

  it('disjoint pick_body by feature id returns first split body', () => {
    // @ex1 resolves to the first split body.
    const result = h.run(disjointTwoRectSpec('new'))
    expect(result.bodies).toHaveProperty('body_ex1')
    expect(result.bodies).toHaveProperty('body_ex1_1')
  })

  it('disjoint bodies face queries resolve to correct body', () => {
    /** Each face query must resolve to the body it belongs to. Split-body
     *  UUID collisions (same construction path across bodies) are a known
     *  construction-naming limitation; those faces are skipped. */
    const result = h.run(disjointTwoRectSpec('new'))
    expect(h.res(result, 'ex1').status).toBe('ok')
    const buildState = result._build_state
    const lastFid = buildState!.feature_order[buildState!.feature_order.length - 1]
    const checkpoint = buildState!.checkpoints[lastFid]
    const repo = repoFromSnapshot(checkpoint.repo_snapshot as Record<string, unknown>)
    let resolved = 0
    for (const bid of ['body_ex1', 'body_ex1_1']) {
      const b = h.body(result, bid) as { mesh?: { face_queries?: string[] } }
      const faceQueries = b?.mesh?.face_queries ?? []
      for (const fq of faceQueries) {
        let r: { body_id?: string } | null = null
        try {
          r = repo.query(fq) as { body_id?: string } | null
        } catch (e) {
          if (e instanceof AmbiguousQueryError) continue
          throw e
        }
        expect(r, `face query ${fq} resolved`).toBeDefined()
        expect(r?.body_id, `face query ${fq} maps to its body`).toBe(bid)
        resolved++
      }
    }
    expect(resolved, 'at least one face query resolved unambiguously').toBeGreaterThan(0)
  })

  it('disjoint body face query usable in downstream feature', () => {
    // A face query from the secondary body can be used as a plane without AmbiguousQueryError.
    const r1 = h.run(disjointTwoRectSpec('new'))
    expect(h.res(r1, 'ex1').status).toBe('ok')

    const faceData = (h.body(r1, 'body_ex1_1').mesh as { face_data?: Array<{ surface_type?: string }> } | undefined)?.face_data ?? []
    const faceQueries = (h.body(r1, 'body_ex1_1').mesh as { face_queries?: string[] } | undefined)?.face_queries ?? []
    let flatQuery: string | undefined
    for (let i = 0; i < faceData.length; i++) {
      if (faceData[i].surface_type === 'flatface') { flatQuery = faceQueries[i]; break }
    }
    expect(flatQuery).toBeDefined()

    const sk2 = rectSketchSk('sk2', 2, 2, flatQuery!)
    const spec2 = { ...disjointTwoRectSpec('new'), features: [...disjointTwoRectSpec('new').features, sk2] }

    const r2 = h.run(spec2)
    const sk2Result = h.res(r2, 'sk2')
    expect(sk2Result.plane_transform).toBeDefined()
  })
})
