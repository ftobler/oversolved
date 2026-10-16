// @vitest-environment node
//
// User repros of the area builder: every `sketch-repros/*.json` recorded with
// `window.__oversolved.downloadRepro()` is replayed through the same headless
// path `npm run drive -- replay` uses (replayJournal + one DocSession over the
// real kernel), and every sketch's final geometry is then judged by the Rust
// area-builder oracle (`check_topology_violations`, built with
// `--features fuzz`; see the fixtures README for the recording workflow).
//
// The headless session runs the area builder on its own: `solveSketch` always
// calls `solveTopology`, so the final document's baked `initial` geometry is
// exactly what the builder saw. The oracle is run again here from that baked
// geometry so its input is the document the user saw, independent of the solve
// result object.
//
// Skips when OCC.js or the node Rust solver is absent (a fresh checkout that
// has not run `just wasm`). A pkg-node that IS present but was built without
// `--features fuzz` is a misbuild, not an absence, and fails the file loudly:
// the past "skip silently" behaviour hid the oracle from every CI run. The
// directory may legitimately hold zero repros; the suite then passes and only
// reports what it scanned.

import { beforeAll, describe, it, expect } from 'vitest'
import { setOccLoader } from '../solveLocally'
import { loadOcc } from '../occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setSketchSolver, setSketchTopology } from '../features/sketch'
import { loadPkgNodeExport, pkgNodeExists } from '@/wasm-kernel/loadPkgNode'
import { createHeadlessPart } from '@/drive/headlessPart'
import { replayJournal } from '@/drive/replay'
import { loadPartDoc } from '@/persistence/docSchema'
import { enrichSketchEntity } from '../features/postRegister'
import type { ReproPayload } from '@/drive/journal'
import type { PartDoc, SketchFeature } from '@/types/cad'

/** The oracle's JSON row shape (see `oracle::violations_json`). */
interface OracleViolation {
  class: string
  reason: string
  known: string | null
  text: string
}

/** The sidecar a user writes next to a repro. */
interface ReproExpectation {
  sketch?: string
  status?: string
  areas?: number
}

type OracleCheck = (input: Uint8Array) => Uint8Array

const modules = import.meta.glob('../__fixtures__/sketch-repros/*.json', { eager: true }) as Record<
  string,
  { default?: unknown }
>
const reproEntries = Object.entries(modules).filter(([path]) => !path.endsWith('.expect.json'))
const expectations = new Map<string, ReproExpectation>(
  Object.entries(modules)
    .filter(([path]) => path.endsWith('.expect.json'))
    .map(([path, mod]) => [path.replace(/\.expect\.json$/, ''), (mod.default ?? {}) as ReproExpectation]),
)

const oc = await loadOcc()
const topology = loadTopology()
const checkTopology = loadPkgNodeExport<OracleCheck>('check_topology_violations')

// The oracle export lives behind the `fuzz` cargo feature, which `just wasm`
// and CI add to the nodejs-target build only (the web/pkg build stays
// feature-free). A package without it was built by hand without the feature:
// fail rather than skip, because a skip here means no CI run ever exercises
// the repro oracle.
if (pkgNodeExists() && !checkTopology) {
  throw new Error(
    'sketch-solver/pkg-node lacks check_topology_violations: rebuild it with the fuzz ' +
      'feature (`just wasm`, or wasm-pack build --target nodejs --release -- --features fuzz)',
  )
}

/**
 * The enriched geometry of one solved sketch, in the same shape and entity
 * order `solveSketch` builds before calling the area builder. Entities the doc
 * never solved (a point, or one without baked params) are skipped.
 */
function richGeomOf(feature: SketchFeature): Record<string, Record<string, unknown>> {
  const geom: Record<string, Record<string, unknown>> = {}
  for (const entity of feature.entities ?? []) {
    const params = feature.initial?.[entity.id]
    if (!params || entity.kind === 'point') continue
    geom[entity.id] = {
      ...enrichSketchEntity(entity.kind, params),
      ...(entity.construction ? { construction: true } : {}),
    }
  }
  return geom
}

function encodeGeom(geom: Record<string, Record<string, unknown>>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(Object.entries(geom)))
}

function decodeViolations(bytes: Uint8Array): OracleViolation[] {
  return JSON.parse(new TextDecoder().decode(bytes)) as OracleViolation[]
}

function areaCount(bytes: Uint8Array): number {
  const out = JSON.parse(new TextDecoder().decode(bytes)) as { surfaces?: unknown[] }
  return out.surfaces?.length ?? 0
}

/** `under_constrained` and `underconstrained` are the same verdict. */
function normaliseStatus(status: string | undefined): string | undefined {
  return status?.replace(/_/g, '').toLowerCase()
}

function statusOf(part: { solveStatuses(): Record<string, string> }, id: string): string | undefined {
  return part.solveStatuses()[id]
}

describe.skipIf(!oc || !topology || !checkTopology)('sketch repros', () => {
  beforeAll(() => {
    // The headless session solves through solveLocally, whose node seam is the
    // nodejs OCC loader (the browser default is the DOM loader). The solver is
    // wired here too: an unwired solver makes every solve throw, which leaves
    // the document byte-identical across a settled step and diverges the
    // replay at the next entry's before-hash.
    setOccLoader(loadOcc)
    setSketchSolver(loadSolver())
    setSketchTopology(loadTopology())
  })

  it('scans the repro directory', () => {
    // The directory ships with a README only; zero repros is a legitimate
    // state this wave. This test exists so an empty scan is visible in the log
    // rather than an absent suite.
    expect(reproEntries.length).toBeGreaterThanOrEqual(0)
    expect(checkTopology).not.toBeNull()
  })

  for (const [path, mod] of reproEntries) {
    const file = path.split('/').pop() ?? path
    it(`replays and judges ${file}`, async () => {
      const payload = mod.default as ReproPayload
      expect(payload?.kind, `${file}: not an oversolved repro payload`).toBe('oversolved-repro')
      expect(payload.journal?.length ?? 0, `${file}: empty journal`).toBeGreaterThan(0)

      const baseline = loadPartDoc(payload.doc, { name: file })
      expect(baseline.ok, `${file}: baseline does not load`).toBe(true)
      if (!baseline.ok) return

      const part = createHeadlessPart({ doc: baseline.doc as PartDoc, docId: 'repro' })
      const outcome = await replayJournal(payload, part.session, () => part.idle())
      const divergence = outcome.steps.find(s => !s.ok)
      expect(
        outcome.ok,
        `${file}: replay diverged: ${JSON.stringify(divergence ?? { baseline: outcome.baselineHash })}`,
      ).toBe(true)

      const doc = part.getDoc()
      expect(doc, `${file}: replay produced no document`).not.toBeNull()
      const sketches = (doc!.features ?? []).filter(
        (f): f is SketchFeature => f.kind === 'sketch',
      )
      expect(sketches.length, `${file}: replay produced no sketch`).toBeGreaterThan(0)

      const expectation = expectations.get(path.replace(/\.json$/, ''))
      if (expectation?.sketch !== undefined) {
        expect(
          sketches.map(s => s.id),
          `${file}: sidecar names an unknown sketch ${expectation.sketch}`,
        ).toContain(expectation.sketch)
      }
      for (const sketch of sketches) {
        const geom = richGeomOf(sketch)
        const bytes = encodeGeom(geom)
        const pending = decodeViolations(checkTopology!(bytes)).filter(v => v.known === null)
        expect(
          pending,
          `${file} sketch ${sketch.id}: ${pending.map(v => v.text).join(' | ')}`,
        ).toEqual([])

        if (expectation && (expectation.sketch === undefined || expectation.sketch === sketch.id)) {
          if (expectation.status !== undefined) {
            expect(
              normaliseStatus(statusOf(part, sketch.id)),
              `${file} sketch ${sketch.id} status`,
            ).toBe(normaliseStatus(expectation.status))
          }
          if (expectation.areas !== undefined) {
            expect(areaCount(topology!(bytes)), `${file} sketch ${sketch.id} areas`).toBe(
              expectation.areas,
            )
          }
        }
      }
    })
  }
})
