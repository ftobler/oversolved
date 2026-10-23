// @vitest-environment node
//
// The bulk `add_chamfer` / `add_shell` forms: one call carrying the pick list and
// the parameter must land the same document as the old feature + pick + field
// sequence. The practice round paid 6 and 4 calls for what `add_fillet` already
// did in one.
//
// Also pins the shell sign note: thickness is a magnitude, `direction` carries
// the side, and CadQuery's signed thickness maps positive -> outward.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, measureHeadless, selectHeadless, seedBuiltins } from '../headlessOps'
import { MUTATION_EXAMPLES } from '../mutationExamples'
import { mutationInfoOf } from '../mutationCatalog'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import type { ScriptStep } from '../scriptRunner'

function occInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('opencascade.js/dist/opencascade.wasm.js')
    return true
  } catch {
    return false
  }
}

const oc = occInstalled()
const solveBytes = loadSolver()
if (oc && solveBytes) {
  setOccLoader(loadOcc)
  setSketchSolver(solveBytes)
  setSketchTopology(loadTopology())
}

function emptyDoc(): PartDoc {
  return seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc)
}

const ready = oc && solveBytes
const step = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

describe('add_chamfer / add_shell document shape and notes', () => {
  it('publishes the inline fields and the bulk note', () => {
    const chamfer = mutationInfoOf('add_chamfer')
    expect(chamfer.fields.edges).toBeDefined()
    expect(chamfer.fields.distance).toBeDefined()
    expect(chamfer.note).toContain('edges')
    expect(chamfer.note).toContain('distance')
    expect(chamfer.note).toContain('same step')

    const shell = mutationInfoOf('add_shell')
    expect(shell.fields.faces).toBeDefined()
    expect(shell.fields.thickness).toBeDefined()
    expect(shell.fields.direction).toBeDefined()
    expect(shell.note).toContain('faces')
    expect(shell.note).toContain('thickness')
    expect(shell.note).toContain('direction')
  })

  it('says the shell sign is the direction field, names inward as the default and maps CadQuery', () => {
    for (const type of ['add_shell', 'set_shell_field'] as const) {
      const note = mutationInfoOf(type).note
      expect(note, type).toBeDefined()
      expect(note, type).toContain('direction: inward|outward')
      expect(note, type).toContain('default is `inward`')
      expect(note, type).toContain('negative value is refused')
      expect(note, type).toContain('CadQuery')
      expect(note, type).toContain('positive -> `outward`')
      expect(note, type).toContain('negative -> `inward`')
    }
  })
})

describe.skipIf(!ready)('inline chamfer and shell (real OCC + Rust solver)', () => {
  it('one-call chamfer matches the feature + edge + field sequence by volume', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    const base = built.doc!
    const queries = (await selectHeadless(base, { kind: 'edge', where: { parallel: [0, 1, 0] } }))!.queries
    expect(queries.length).toBeGreaterThan(0)
    const edge = queries[0]

    const oneCall = await runHeadless({
      doc: structuredClone(base),
      steps: [step({ type: 'add_chamfer', featureId: 'ch1', label: 'Chamfer', edges: [edge], distance: 2 })],
    })
    const multi = await runHeadless({
      doc: structuredClone(base),
      steps: [
        step({ type: 'add_chamfer', featureId: 'ch1', label: 'Chamfer' }),
        step({ type: 'add_chamfer_edge', featureId: 'ch1', edgeQuery: edge }),
        step({ type: 'set_chamfer_field', featureId: 'ch1', field: 'distance', value: 2 }),
      ],
    })
    expect(oneCall.ok).toBe(true)
    expect(multi.ok).toBe(true)

    const oneFeature = oneCall.doc?.features?.find(feature => feature.id === 'ch1')
    const multiFeature = multi.doc?.features?.find(feature => feature.id === 'ch1')
    expect(oneFeature).toMatchObject({ kind: 'chamfer', chamfer: { edges: [edge], distance: 2 } })
    expect(multiFeature).toMatchObject({ kind: 'chamfer', chamfer: { edges: [edge], distance: 2 } })
    const one = await measureHeadless(oneCall.doc!)
    const many = await measureHeadless(multi.doc!)
    expect(one).not.toBeNull()
    expect(many).not.toBeNull()
    expect(one!.measures.volume).toBeCloseTo(many!.measures.volume, 9)
  }, 240_000)

  it('one-call shell matches the feature + face + field sequence by volume', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    const base = built.doc!
    const faces = (await selectHeadless(base, {
      kind: 'face',
      where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] },
    }))!.queries
    expect(faces).toHaveLength(1)
    const face = faces[0]

    const oneCall = await runHeadless({
      doc: structuredClone(base),
      steps: [step({ type: 'add_shell', featureId: 'sh1', label: 'Shell', faces: [face], thickness: 1, direction: 'inward' })],
    })
    const multi = await runHeadless({
      doc: structuredClone(base),
      steps: [
        step({ type: 'add_shell', featureId: 'sh1', label: 'Shell' }),
        step({ type: 'add_shell_face', featureId: 'sh1', faceQuery: face }),
        step({ type: 'set_shell_field', featureId: 'sh1', field: 'thickness', value: 1 }),
        step({ type: 'set_shell_field', featureId: 'sh1', field: 'direction', value: 'inward' }),
      ],
    })
    expect(oneCall.ok).toBe(true)
    expect(multi.ok).toBe(true)

    const oneFeature = oneCall.doc?.features?.find(feature => feature.id === 'sh1')
    const multiFeature = multi.doc?.features?.find(feature => feature.id === 'sh1')
    expect(oneFeature).toMatchObject({ kind: 'shell', shell: { faces: [face], thickness: 1, direction: 'inward' } })
    expect(multiFeature).toMatchObject({ kind: 'shell', shell: { faces: [face], thickness: 1, direction: 'inward' } })

    const one = await measureHeadless(oneCall.doc!)
    const many = await measureHeadless(multi.doc!)
    expect(one).not.toBeNull()
    expect(many).not.toBeNull()
    expect(one!.measures.volume).toBeCloseTo(many!.measures.volume, 9)
  }, 240_000)
})
