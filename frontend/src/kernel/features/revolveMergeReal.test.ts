// @vitest-environment node
//
// Revolve merge target tests using the OCC.js + Rust WASM build pipeline with
// a persistent HandleTable. Ports the merge_target scenarios from
// test_revolve_merge_target.py.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { SharedHarness } from '../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from './sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketchAt(sketchId: string, w: number, h: number, offsetX: number, plane = '@builtin_plane_front') {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane,
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      bottom: [offsetX, 0, offsetX + w, 0],
      right: [offsetX + w, 0, offsetX + w, h],
      top: [offsetX + w, h, offsetX, h],
      left: [offsetX, h, offsetX, 0],
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

function revolveSpec(sketchId: string, revId: string, opts: { angle?: number; operation?: string; mergeTarget?: string } = {}) {
  const r: Record<string, unknown> = {
    id: revId, kind: 'revolve', label: 'Revolve',
    revolve: { sketch: ['$' + sketchId], angle: opts.angle ?? 360,
      axis_origin: [0, 0, 0], axis_direction: [0, 1, 0], operation: opts.operation ?? 'add' },
  }
  if (opts.mergeTarget) (r.revolve as Record<string, unknown>).merge_target = opts.mergeTarget
  return r
}

function bodyA() {
  return { features: [
    rectSketchAt('sk0', 2, 1, 1),
    revolveSpec('sk0', 'rev0', { operation: 'new' }),
  ]}
}

function twoBodies() {
  return { features: [
    rectSketchAt('sk0', 2, 1, 1),
    revolveSpec('sk0', 'rev0', { operation: 'new' }),
    rectSketchAt('sk1', 2, 1, 10),
    revolveSpec('sk1', 'rev1', { operation: 'new' }),
  ]}
}

describe.skipIf(!oc || !solveBytes)('revolve merge target (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })

  it('add with merge_target fuses to specific body', () => {
    /** Port of test_revolve_add_with_merge_target_fuses_to_specific_body. */
    const doc = twoBodies()
    doc.features.push(rectSketchAt('sk2', 2, 1, 2))
    doc.features.push(revolveSpec('sk2', 'rev2', { operation: 'add', mergeTarget: '@body_rev0' }))
    const r = h.run(doc)
    expect(h.res(r, 'rev2').status).toBe('ok')
    expect(h.res(r, 'rev2').operation).toBe('add')
    expect(h.res(r, 'rev2').body_id).toBe('body_rev0')
    expect(r.bodies).toHaveProperty('body_rev1')
  })

  it('add fail with island shape when merge_target set', () => {
    /** Non-overlapping revolve with merge_target fails with island error.
     *  Port of test_revolve_add_fails_with_island_shape_when_merge_target_set. */
    const doc = bodyA()
    doc.features.push(rectSketchAt('sk2', 2, 1, 20))
    doc.features.push(revolveSpec('sk2', 'rev2', { operation: 'add', mergeTarget: '@body_rev0' }))
    const r = h.run(doc)
    expect(h.res(r, 'rev2').status).toBe('exception')
    expect(String(h.res(r, 'rev2').exception ?? '')).toContain('island')
  })

  it('add with nonexistent merge_target fails', () => {
    /** Port of test_revolve_add_with_merge_target_nonexistent_body_fails. */
    const doc = bodyA()
    doc.features.push(rectSketchAt('sk2', 2, 1, 2))
    doc.features.push(revolveSpec('sk2', 'rev2', { operation: 'add', mergeTarget: '@body_nonexistent' }))
    const r = h.run(doc)
    expect(h.res(r, 'rev2').status).toBe('exception')
  })

  it('cut with merge_target cuts specific body', () => {
    /** Port of test_revolve_cut_with_merge_target_cuts_specific_body. */
    const doc = twoBodies()
    doc.features.push(rectSketchAt('sk2', 2, 0.5, 1))
    doc.features.push(revolveSpec('sk2', 'rev2', { operation: 'cut', mergeTarget: '@body_rev0' }))
    const r = h.run(doc)
    expect(h.res(r, 'rev2').status).toBe('ok')
    expect(h.res(r, 'rev2').operation).toBe('cut')
    expect(r.bodies).toHaveProperty('body_rev1')
  })

  it('cut with no intersection fails', () => {
    /** Port of test_revolve_cut_fails_when_no_intersection. */
    const doc = twoBodies()
    doc.features.push(rectSketchAt('sk2', 2, 1, 50))
    doc.features.push(revolveSpec('sk2', 'rev2', { operation: 'cut' }))
    const r = h.run(doc)
    expect(h.res(r, 'rev2').status).toBe('exception')
  })

  it('cut with nonexistent merge_target fails', () => {
    /** Port of test_revolve_cut_merge_target_nonexistent_body_fails. */
    const doc = twoBodies()
    doc.features.push(rectSketchAt('sk2', 2, 0.5, 1))
    doc.features.push(revolveSpec('sk2', 'rev2', { operation: 'cut', mergeTarget: '@body_nonexistent' }))
    const r = h.run(doc)
    expect(h.res(r, 'rev2').status).toBe('exception')
  })

  it('new creates independent body', () => {
    /** Port of test_revolve_new_creates_independent_body. */
    const r = h.run(bodyA())
    expect(h.res(r, 'rev0').status).toBe('ok')
    expect(h.res(r, 'rev0').operation).toBe('new')
  })

  it('merge_target preserved in feature spec', () => {
    /** Port of test_revolve_merge_target_preserved_across_rebuild. */
    const doc = bodyA()
    doc.features.push(rectSketchAt('sk2', 1, 1, 2))
    doc.features.push(revolveSpec('sk2', 'rev2', { operation: 'add', mergeTarget: '@body_rev0' }))
    const r = h.run(doc)
    expect(h.res(r, 'rev2').status).toBe('ok')
    const feat = doc.features.find((f) => f.id === 'rev2') as Record<string, Record<string, unknown>>
    expect(feat.revolve.merge_target).toBe('@body_rev0')
  })
})
