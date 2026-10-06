// @vitest-environment node
//
// Gated real-OCC feature-level extrude tests using the full build pipeline
// (OCC.js + Rust WASM sketch solver). Split from the original extrudeReal
// suite; shared spec builders live in extrudeRealSupport.ts. This file covers
// extrudes whose profile is a B-rep face query, including after a fillet has
// reshaped the body topology.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import { makeAncestryQuery } from '../../query'
import {
  oc, solveBytes, extrudeTestHarness, rectSketchSk, extrudeSpec, fullRectExtrudeSpec, assertMeshValid,
} from '../extrudeRealSupport'

describe.skipIf(!oc || !solveBytes)('extrude feature (real OCC + Rust solver): body face profiles', () => {
  const h = extrudeTestHarness()

  // ─── Slash query extrude ───

  it('extrude from slash-style brep face query (@feature/face/N)', () => {
    // Slash-style B-rep face IDs resolve as extrude profiles.
    const result = h.run({
      features: [
        rectSketchSk('sk1', 10, 10, '@builtin_plane_front'),
        extrudeSpec('sk1', 'ex1', { distance: 5 }),
        { id: 'ex2', kind: 'extrude', sketch: '@ex1/face/0', distance: 3, direction: 'normal', operation: 'new' },
      ],
    })
    expect(h.res(result, 'ex2').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex2')
    // A blind face-profile extrude anchors its distance handle on the swept face
    // (usingFaces handle path), not only the sketch-loop path.
    expect(h.res(result, 'ex2').handle).toBeDefined()
    const mesh2 = h.body(result, 'body_ex2').mesh as { vertices: number[][] } | undefined
    expect(mesh2).toBeDefined()
    if (mesh2) {
      const xs = mesh2.vertices.map((v) => v[0])
      const ys = mesh2.vertices.map((v) => v[1])
      const zs = mesh2.vertices.map((v) => v[2])
      const spans = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), Math.max(...zs) - Math.min(...zs)]
      expect(spans.some((s) => Math.abs(s - 3) < 0.25)).toBe(true)
    }
  })

  it('two non-coplanar body faces picked together are refused', () => {
    // Extrude sweeps every picked face along face 0's normal; a second face on a
    // different plane would grow out of its own plane, so the pick is refused by
    // name instead of silently building the wrong solid. The top face and a
    // front/back side face of one box are perpendicular, so their normals differ.
    const first = h.run(fullRectExtrudeSpec(10, 10, 5))
    expect(h.res(first, 'ex1').status).toBe('ok')
    const faceQ = (q: string) => makeAncestryQuery([q, '@ex1', '@body_ex1'], 'flatface')
    const mesh = h.body(first, 'body_ex1').mesh as
      | { face_data?: Array<{ normal: number[]; surface_type?: string }> }
      | undefined
    const fd = mesh?.face_data ?? []
    const topIdx = fd.findIndex((f) => f.normal[2] > 0.9 && f.surface_type === 'flatface')
    const sideIdx = fd.findIndex((f) => Math.abs(f.normal[1]) > 0.9 && f.surface_type === 'flatface')
    expect(topIdx).toBeGreaterThanOrEqual(0)
    expect(sideIdx).toBeGreaterThanOrEqual(0)
    const result = h.run({
      features: [
        rectSketchSk('sk1', 10, 10, '@builtin_plane_front'),
        extrudeSpec('sk1', 'ex1', { distance: 5 }),
        {
          id: 'ex2', kind: 'extrude',
          extrude: {
            sketch: [faceQ(`@body_ex1/face${topIdx}`), faceQ(`@body_ex1/face${sideIdx}`)],
            distance: 3, direction: 'normal', operation: 'new',
          },
        },
      ],
    })
    expect(h.res(result, 'ex2').status).toBe('exception')
    expect(String(h.res(result, 'ex2').exception)).toContain('not coplanar')
  })

  // ─── Fillet + extrude chain (face query after fillet topology change) ───

  it('extrude from brep face after fillet', () => {
    /**
     * Extrude uses a face query from a body that was modified by a fillet. Regression: after
     * fillet changes body topology, face index ordering in face-loop extraction must match
     * solid_to_mesh.
     */
    const d = 5
    // Step 1: build extrude-only to find edge queries and a flat side face
    const r1 = h.run({
      features: [
        rectSketchSk('sk1', 10, 10, '@builtin_plane_front'),
        extrudeSpec('sk1', 'ex1', { distance: d }),
      ],
    })
    expect(h.res(r1, 'ex1').status).toBe('ok')

    // Find a flat side face (centroid z ~ d/2) and build a 3-tag query.
    const mesh1 = h.body(r1, 'body_ex1').mesh as {
      face_data?: Array<{ centroid: number[]; surface_type?: string }>
    } | undefined
    let bestQ: string | undefined
    if (mesh1?.face_data) {
      for (let idx = 0; idx < mesh1.face_data.length; idx++) {
        const fd = mesh1.face_data[idx]
        if (Math.abs(fd.centroid[2] - d / 2) < 0.1 && fd.surface_type === 'flatface') {
          bestQ = makeAncestryQuery([`@body_ex1/face${idx}`, '@ex1', '@body_ex1'], 'flatface')
          break
        }
      }
    }
    expect(bestQ).toBeDefined()

    // Step 2: full build with extrude + fillet + extrude from face.
    const eq = (h.body(r1, 'body_ex1').edge_queries as string[]) ?? []
    const spec2 = {
      features: [
        rectSketchSk('sk1', 10, 10, '@builtin_plane_front'),
        extrudeSpec('sk1', 'ex1', { distance: d }),
        { id: 'fil1', kind: 'fillet', edges: [eq[0], eq[1]], radius: 0.5 },
        { id: 'ex2', kind: 'extrude', sketch: bestQ!, distance: 3, direction: 'normal', operation: 'new' },
      ],
    }
    const r2 = h.run(spec2)
    expect(h.res(r2, 'ex2').status).toBe('ok')
    expect(r2.bodies).toHaveProperty('body_ex2')
    const m2 = h.body(r2, 'body_ex2').mesh as Record<string, unknown> | undefined
    expect(m2).toBeDefined()
    if (m2) assertMeshValid(m2)
  })
})
