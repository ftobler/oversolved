/**
 * WASM kernel migration: baseline structure check (Phase 0).
 *
 * Loads the regression baseline (a frozen golden snapshot of the now-removed
 * Python kernel) and validates its structure.  The live TS/WASM-kernel-vs-baseline
 * diff lives in occ/__tests__/fullDocParity.test.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  spec: Record<string, unknown>
}

let entries: RegressionEntry[]

beforeAll(() => {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const raw = readFileSync(resolve(__dirname, '../regression-baseline.json'), 'utf-8')
  entries = JSON.parse(raw) as RegressionEntry[]
})

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

  it('mesh structures are valid', { timeout: 30000 }, () => {
    const errors: string[] = []
    for (const entry of entries) {
      for (const [bodyId, body] of Object.entries(entry.bodies)) {
        const mesh = body.mesh
        if (!mesh) continue
        if (!Array.isArray(mesh.vertices)) {
          errors.push(`${entry.label}/${bodyId}: vertices not an array`)
        }
        if (!Array.isArray(mesh.faces)) {
          errors.push(`${entry.label}/${bodyId}: faces not an array`)
        }
        if (!Array.isArray(mesh.vertices) || !Array.isArray(mesh.faces)) continue
        const n = mesh.vertices.length
        for (let fi = 0; fi < mesh.faces.length; fi++) {
          const face = mesh.faces[fi]
          if (!Array.isArray(face)) {
            errors.push(`${entry.label}/${bodyId}: face[${fi}] not an array`)
            continue
          }
          if (face.length !== 3) {
            errors.push(`${entry.label}/${bodyId}: face[${fi}] length ${face.length} !== 3`)
            continue
          }
          for (let vi = 0; vi < 3; vi++) {
            const idx = face[vi]
            if (typeof idx !== 'number' || idx < 0 || idx >= n) {
              errors.push(`${entry.label}/${bodyId}: face[${fi}][${vi}]=${idx} out of range [0,${n})`)
            }
          }
        }
      }
    }
    expect(errors).toEqual([])
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

// The projection tier guards the corpus itself: projection was the one solver
// path with zero full-doc regression coverage (see feature/projection-corpus).
// These entries must stay in the manifest and every one must actually carry a
// `source` query on a sketch entity -- otherwise the tier is cosmetic and the
// parity gate cannot catch a projection-lowering break (red-green proven).
describe('WASM kernel projection corpus', () => {
  interface ManifestCase { feature_kind: string; query_tier: string; ok: boolean }
  const manifest = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../corpus-manifest.json'), 'utf-8')) as {
    summary: { by_tier: Record<string, number> }
    coverage: Record<string, string[]>
    cases: Record<string, ManifestCase>
  }

  const projectionLabels = (): string[] =>
    Object.entries(manifest.cases)
      .filter(([, c]) => c.query_tier === 'projection')
      .map(([label]) => label)

  it('reports a projection tier in the coverage summary', () => {
    expect(manifest.summary.by_tier.projection).toBeGreaterThan(0)
    const labels = projectionLabels()
    expect(labels.length).toBe(manifest.summary.by_tier.projection)
    for (const label of labels) {
      expect(manifest.coverage[`${manifest.cases[label].feature_kind}/${manifest.cases[label].query_tier}`]).toContain(label)
    }
  })

  it('every projection case has a sketch entity carrying a source query', () => {
    const labels = projectionLabels()
    expect(labels.length).toBeGreaterThan(0)
    const missing: string[] = []
    for (const label of labels) {
      const entry = entries.find(e => e.label === label)
      if (!entry) { missing.push(`${label}: no baseline entry`); continue }
      const hasSource = (entry.spec.features as Array<{ entities?: Array<{ source?: string }> }>)
        .some(f => (f.entities ?? []).some(e => e.source))
      if (!hasSource) missing.push(`${label}: no source query on any sketch entity`)
    }
    expect(missing).toEqual([])
  })
})
