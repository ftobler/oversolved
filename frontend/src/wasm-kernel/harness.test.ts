/**
 * WASM kernel migration: dual-run harness (Phase 0).
 *
 * Loads the regression baseline produced by the Python kernel and validates its
 * structure.  In later phases this file will also run the TS/WASM kernel and
 * diff results against the baseline.
 */
import { describe, it, expect } from 'vitest'
import baseline from './regression-baseline.json'

interface BodyEntry {
  id: string
  created_by: string
  modified_by: string[]
  mesh: { vertices: number[][]; faces: number[][] }
  face_count: number
  edge_count: number
  face_hashes: string[]
  edge_hashes: string[]
  mesh_error?: string
}

interface FeatureResult {
  status: string
  geometry?: Record<string, number[]>
  projected?: Record<string, number[]>
  features?: Record<string, { status: string }>
  plane?: Record<string, unknown>
  error?: string
}

interface RegressionEntry {
  label: string
  ok: boolean
  error: string | null
  result: Record<string, FeatureResult>
  bodies: Record<string, BodyEntry>
}

const entries = baseline as RegressionEntry[]

describe('WASM kernel regression baseline', () => {
  it('has entries', () => {
    expect(entries.length).toBeGreaterThan(0)
  })

  it('all entries have required fields', () => {
    for (const entry of entries) {
      expect(entry).toHaveProperty('label')
      expect(entry).toHaveProperty('ok')
      expect(entry).toHaveProperty('result')
      expect(entry).toHaveProperty('bodies')
      expect(typeof entry.label).toBe('string')
      expect(typeof entry.ok).toBe('boolean')
    }
  })

  it('all entries report ok=true (no kernel crashes)', () => {
    const failures = entries.filter(e => !e.ok)
    if (failures.length > 0) {
      const labels = failures.map(f => `${f.label}: ${f.error}`).join(', ')
      expect(failures, `Failed: ${labels}`).toEqual([])
    }
  })

  it('mesh structures are valid', () => {
    for (const entry of entries) {
      for (const [, body] of Object.entries(entry.bodies)) {
        const mesh = body.mesh
        if (!mesh) continue
        // Every mesh has vertices and faces arrays
        expect(Array.isArray(mesh.vertices)).toBe(true)
        expect(Array.isArray(mesh.faces)).toBe(true)
        // Face indices are triplets within vertex range
        const n = mesh.vertices.length
        for (const face of mesh.faces) {
          expect(Array.isArray(face)).toBe(true)
          expect(face.length).toBe(3)
          for (const idx of face) {
            expect(idx).toBeGreaterThanOrEqual(0)
            expect(idx).toBeLessThan(n)
          }
        }
      }
    }
  })

  it('face_hashes match face_count', () => {
    for (const entry of entries) {
      for (const [, body] of Object.entries(entry.bodies)) {
        expect(body.face_hashes.length).toBe(body.face_count)
      }
    }
  })

  it('edge_hashes match edge_count', () => {
    for (const entry of entries) {
      for (const [, body] of Object.entries(entry.bodies)) {
        expect(body.edge_hashes.length).toBe(body.edge_count)
      }
    }
  })

  it('cover sketch, extrude, revolve, hole, fillet, chamfer, boolean, array, mirror, plane', () => {
    const labels = entries.map(e => e.label)
    expect(labels.some(l => l.startsWith('rect_sketch'))).toBe(true)
    expect(labels.some(l => l.startsWith('box_extrude'))).toBe(true)
    expect(labels.some(l => l.startsWith('revolve'))).toBe(true)
    expect(labels.some(l => l.startsWith('box_with_hole'))).toBe(true)
    expect(labels.some(l => l.startsWith('box_with_fillet'))).toBe(true)
    expect(labels.some(l => l.startsWith('box_with_chamfer'))).toBe(true)
    expect(labels.some(l => l.startsWith('boolean'))).toBe(true)
    expect(labels.some(l => l.startsWith('array'))).toBe(true)
    expect(labels.some(l => l.startsWith('mirror'))).toBe(true)
    expect(labels.some(l => l.startsWith('plane'))).toBe(true)
  })
})
