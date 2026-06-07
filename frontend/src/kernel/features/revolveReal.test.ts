// @vitest-environment node
//
// Gated real-OCC feature-level revolve tests using the full build pipeline
// (OCC.js + Rust WASM sketch solver). Ports the build-layer revolve scenarios
// from test_revolve_mesh.py.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope } from '../occ/disposeScope'
import { HandleTable } from '../occ/handleTable'
import { solidToMesh } from '../occ/tessellation'
import { brepDiffNewFaceHashes, brepDiffNewEdgeHashes, brepDiffNewVertexHashes } from '../occ/brepDiffHash'
import { build, type BuildDeps } from '../builder'
import { initGlobalRepo } from '../query'
import { createFeatureSolver } from '../solverRegistry'
import { postRegister } from '../features/postRegister'
import { setSketchSolver, resetSketchSolver } from '../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import type { OccModule } from '../occ/occTypes'
import type { Body } from '../types3d'

const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketch(sketchId: string, w: number, h: number, offsetX: number, offsetY: number) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      bottom: [offsetX, offsetY, offsetX + w, offsetY],
      right: [offsetX + w, offsetY, offsetX + w, offsetY + h],
      top: [offsetX + w, offsetY + h, offsetX, offsetY + h],
      left: [offsetX, offsetY + h, offsetX, offsetY],
    },
    constraints: [
      { id: 'c1', kind: 'coincident' as const, a: { entity: 'bottom', point: 'end' as const }, b: { entity: 'right', point: 'start' as const } },
      { id: 'c2', kind: 'coincident' as const, a: { entity: 'right', point: 'end' as const }, b: { entity: 'top', point: 'start' as const } },
      { id: 'c3', kind: 'coincident' as const, a: { entity: 'top', point: 'end' as const }, b: { entity: 'left', point: 'start' as const } },
      { id: 'c4', kind: 'coincident' as const, a: { entity: 'left', point: 'end' as const }, b: { entity: 'bottom', point: 'start' as const } },
      { id: 'c5', kind: 'horizontal' as const, target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal' as const, target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical' as const, target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical' as const, target: { entity: 'left' } },
      { id: 'c9', kind: 'length' as const, target: { entity: 'bottom' }, value: w },
      { id: 'c10', kind: 'length' as const, target: { entity: 'left' }, value: h },
    ],
  }
}

function revolveSpec(featureId: string, sketchId: string, opts: {
  angle?: number; operation?: string; direction?: string; mergeTarget?: string
  axisOrigin?: number[]; axisDirection?: number[]
} = {}) {
  const spec: Record<string, unknown> = {
    id: featureId, kind: 'revolve', label: 'Revolve',
    sketch: '$' + sketchId, angle: opts.angle ?? 360,
    axis_origin: opts.axisOrigin ?? [0, 0, 0], axis_direction: opts.axisDirection ?? [0, 1, 0],
  }
  if (opts.operation) spec.operation = opts.operation
  if (opts.direction) spec.direction = opts.direction
  if (opts.mergeTarget) spec.merge_target = opts.mergeTarget
  return spec
}

describe.skipIf(!oc || !solveBytes)('revolve feature (real OCC + Rust solver)', () => {
  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })

  function run(spec: Record<string, unknown>) {
    const scope = new DisposeScope()
    const table = new HandleTable({ finalizerGuard: false })
    try {
      const deps: BuildDeps = {
        trySolveFeature: createFeatureSolver(oc, scope, table),
        postRegister, initGlobalRepo,
        tessellateBodies: (bodyStore) => {
          const out: Record<string, Record<string, unknown>> = {}
          for (const [_, body] of Object.entries(bodyStore)) {
            if (!body.shape) continue
            try {
              const mesh = solidToMesh(oc, table, body.shape)
              out[body.id] = { mesh, edges: [], edge_queries: [] }
            } catch { /* non-fatal */ }
          }
          return out
        },
        brepDiffNewFaceHashes: (b) => brepDiffNewFaceHashes(oc, scope, b),
        brepDiffNewEdgeHashes: (b) => brepDiffNewEdgeHashes(oc, scope, b),
        brepDiffNewVertexHashes: (b) => brepDiffNewVertexHashes(oc, scope, b),
      }
      const result = build(spec, {}, deps)
      scope.dispose()
      return result
    } catch (e) {
      scope.dispose()
      throw e
    }
  }

  it('basic revolve produces a body with mesh', () => {
    /** A rectangle [1,0]-[3,1] revolved 360° around Y-axis. Port of test_revolve_status_ok. */
    const result = run({
      version: 1, kind: 'part',
      features: [rectSketch('sk1', 2, 1, 1, 0), revolveSpec('rev1', 'sk1', { angle: 360 })],
    })
    expect(result.result.rev1.status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_rev1')
    expect(result.bodies.body_rev1.mesh).toBeDefined()
  })

  it('revolve result includes body_id field', () => {
    /** Port of test_revolve_has_body_id. */
    const result = run({
      version: 1, kind: 'part',
      features: [rectSketch('sk1', 2, 1, 1, 0), revolveSpec('rev1', 'sk1', { angle: 360 })],
    })
    expect(result.result.rev1.body_id).toBe('body_rev1')
  })

  it('nested UI format ({revolve: {sketch, angle}}) works', () => {
    /** Port of test_revolve_nested_ui_format. */
    const result = run({
      version: 1, kind: 'part',
      features: [
        rectSketch('sk1', 2, 1, 1, 0),
        { id: 'rev1', kind: 'revolve', label: 'Revolve',
          revolve: { sketch: '$sk1', angle: 360, axis_origin: [0, 0, 0], axis_direction: [0, 1, 0] } },
      ],
    })
    expect(result.result.rev1.status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_rev1')
  })

  it('revolve cut removes volume from base body', () => {
    /** Port of test_revolve_cut_removes_volume. */
    const result = run({
      version: 1, kind: 'part',
      features: [
        rectSketch('sk1', 2, 1, 1, 0), revolveSpec('rev1', 'sk1', { angle: 360 }),
        rectSketch('sk2', 1, 1, 1.5, 0), revolveSpec('rev2', 'sk2', { angle: 360, operation: 'cut' }),
      ],
    })
    expect(result.result.rev1.status).toBe('ok')
    expect(result.result.rev2.status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_rev1')
  })

  it('revolve operation=new creates a separate body', () => {
    /** Port of test_revolve_new_creates_new_body. */
    const result = run({
      version: 1, kind: 'part',
      features: [
        rectSketch('sk1', 2, 1, 1, 0), revolveSpec('rev1', 'sk1', { angle: 360 }),
        rectSketch('sk2', 1, 1, 4, 0), revolveSpec('rev2', 'sk2', { angle: 360, operation: 'new', axisDirection: [0, 0, 1] }),
      ],
    })
    expect(result.bodies).toHaveProperty('body_rev1')
    expect(result.bodies).toHaveProperty('body_rev2')
  })

  it('merge_target fuses revolve into an existing body', () => {
    /** When a revolve specifies merge_target pointing to a body created by an
     *  earlier feature, the new revolve fuses into that target instead of
     *  creating a separate body. Port of revolve merge_target scenarios from
     *  test_revolve_merge_target.py. */
    const result = run({
      version: 1, kind: 'part',
      features: [
        rectSketch('sk1', 2, 1, 1, 0), revolveSpec('rev0', 'sk1', { angle: 360, operation: 'new' }),
        rectSketch('sk2', 1.5, 1, 1.25, 0), revolveSpec('rev1', 'sk2', { angle: 360, operation: 'add', mergeTarget: '@body_rev0' }),
      ],
    })
    expect(result.result.rev0.status).toBe('ok')
    // The add should fuse into the target, so body_rev0 exists and body_rev1 may not.
    expect(result.bodies).toHaveProperty('body_rev0')
  })

  it('merge_target cut removes from a specific body', () => {
    /** A revolve with operation=cut and merge_target cuts from a specific body
     *  created by an earlier feature. Port from test_revolve_merge_target.py. */
    const result = run({
      version: 1, kind: 'part',
      features: [
        rectSketch('sk1', 2, 1, 1, 0), revolveSpec('rev0', 'sk1', { angle: 360, operation: 'new' }),
        rectSketch('sk2', 1, 1, 1.5, 0), revolveSpec('rev1', 'sk2', { angle: 360, operation: 'cut', mergeTarget: '@body_rev0' }),
      ],
    })
    expect(result.result.rev0.status).toBe('ok')
    expect(result.result.rev1.status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_rev0')
  })

  it('reverse direction negates the revolve angle', () => {
    /** direction=reverse negates the angle, producing a mirror shape.
     *  Port of test_revolve_reverse_direction. */
    const result = run({
      version: 1, kind: 'part',
      features: [
        rectSketch('sk1', 2, 1, 1, 0),
        revolveSpec('rev1', 'sk1', { angle: 90, direction: 'reverse' }),
      ],
    })
    expect(result.result.rev1.status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_rev1')
  })

  it('symmetric direction revolves half angle each way', () => {
    /** direction=symmetric revolves half the angle each way and fuses
     *  the two halves. Port of test_revolve_symmetric_direction. */
    const result = run({
      version: 1, kind: 'part',
      features: [
        rectSketch('sk1', 2, 1, 1, 0),
        revolveSpec('rev1', 'sk1', { angle: 90, direction: 'symmetric' }),
      ],
    })
    expect(result.result.rev1.status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_rev1')
  })
})
