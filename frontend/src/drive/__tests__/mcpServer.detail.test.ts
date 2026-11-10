// @vitest-environment node
//
// The `detail` switch on assembly replies: the shapes of summary and changed,
// full staying byte-identical to the untrimmed reply, the size budget a
// six-bolt-stack call must stay under, and the `mutations` family, type and
// detail filters. All pure: the kernel is replaced by hand-built solve state.

import { describe, it, expect } from 'vitest'
import type { AssemblyDoc, Transform3D } from '@/types/cad'
import type { AssemblySolveStatus } from '@/kernel/solveAssembly'
import { instancePoses, type MateFrame, type MateProblem } from '../assemblyOutcome'
import { movedInstances, shapeAssemblyExport, shapeAssemblyMeasures, shapeAssemblyState, touchedMateIds, type AssemblyDetailState, type AssemblyExportState } from '../assemblyDetail'
import { assemblyRunReply } from '../mcpDocRef'
import { DocHandleStore } from '../docHandleStore'
import { emptyDriveAssemblyDoc } from '../headlessAssembly'
import { createMcpServer, type McpCadOps } from '../mcpServer'
import { filterMutationCatalog, mutationCatalogPayload } from '../mutationCatalogPayload'

const identity = (tx: number): Transform3D => ({ tx, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 })

// One fixed plate plus `stacks` bolt instances, each mated by one fixed mate.
function flangeDoc(stacks: number, editedMate?: string): AssemblyDoc {
  const doc = emptyDriveAssemblyDoc()
  const features = doc.features!
  features.push({
    id: 'plate', kind: 'part_instance',
    instance: { handle: 'plate', doc_id: 'plate', doc_rev: 1, transform: identity(0), fixed: true },
  } as never)
  for (let i = 0; i < stacks; i++) {
    features.push({
      id: `bolt${i}`, kind: 'part_instance',
      instance: { handle: `bolt${i}`, doc_id: 'bolt', doc_rev: 1, transform: identity(i) },
    } as never)
    features.push({
      id: `m${i}`, kind: 'mate',
      mate: {
        kind: 'fixed',
        ref_a: { part: 'plate', anchor: `hole${i}` },
        ref_b: { part: `bolt${i}`, anchor: 'head' },
        ...(editedMate === `m${i}` && { flip: true }),
      },
    } as never)
  }
  return doc
}

function solveOf(doc: AssemblyDoc, dof = 0): AssemblySolveStatus {
  const mates: AssemblySolveStatus['mates'] = {}
  for (const feature of doc.features ?? []) if (feature.kind === 'mate') mates[feature.id] = { residual: 1e-9 }
  return { verdict: 'fully_constrained', residualNorm: 1e-9, rank: 6, dof, iters: 4, mates, parts: {} }
}

function stateOf(doc: AssemblyDoc, move?: string): AssemblyDetailState {
  const transforms: Record<string, Transform3D> = { plate: identity(0) }
  for (const feature of doc.features ?? []) {
    if (feature.kind === 'part_instance') transforms[feature.instance!.handle] = identity(feature.instance!.transform.tx)
  }
  if (move !== undefined) transforms[move] = identity(99)
  const frames: Record<string, MateFrame> = {}
  for (const feature of doc.features ?? []) {
    if (feature.kind !== 'mate') continue
    frames[feature.id] = {
      ref_a: { anchor: 'a', kind: 'cylinder', point: [1, 2, 3], axis: [0, 0, 1] },
      ref_b: { anchor: 'b', kind: 'cylinder', point: [1, 2, 3], axis: [0, 0, 1] },
      residual: 1e-9,
    }
  }
  return {
    solve: solveOf(doc),
    mates: [],
    parts: [],
    instances: instancePoses(doc, transforms),
    mateFrames: frames,
    summary: 'instances: ...; mates: ...; verdict: underconstrained (dof 30)',
  }
}

const problem: MateProblem = { id: 'm2', kind: 'fixed', status: 'residual', message: 'residual 0.3' }

describe('shapeAssemblyState', () => {
  const input = flangeDoc(6)
  const output = flangeDoc(6, 'm3')
  const baseline = stateOf(input).instances

  it('full returns the state untouched', () => {
    const state = stateOf(output)
    expect(shapeAssemblyState(state, 'full', output, { inputDoc: input, baseline })).toBe(state)
  })

  it('summary keeps the verdict and the problems and drops poses, frames and per-mate rows', () => {
    const state = { ...stateOf(output), mates: [problem] }
    const shaped = shapeAssemblyState(state, 'summary', output, { inputDoc: input, baseline })
    expect(shaped.instances).toBeUndefined()
    expect(shaped.mateFrames).toBeUndefined()
    expect(shaped.mates).toEqual([problem])
    expect(shaped.solve).toMatchObject({ verdict: 'fully_constrained', dof: 0, iters: 4 })
    expect(shaped.solve).not.toHaveProperty('mates')
    expect(shaped.summary).toContain('dof 30')
  })

  it('changed lists the moved instance, the edited mate frame and the problem mate frame only', () => {
    const state = { ...stateOf(output, 'bolt1'), mates: [problem] }
    const shaped = shapeAssemblyState(state, 'changed', output, { inputDoc: input, baseline })
    expect((shaped.instances ?? []).map(pose => pose.handle)).toEqual(['bolt1'])
    expect(Object.keys(shaped.mateFrames ?? {}).sort()).toEqual(['m2', 'm3'])
    expect(Object.keys((shaped.solve as AssemblySolveStatus).mates)).toEqual(['m2'])
  })

  it('changed with nothing moved and nothing edited lists no instance and no frame', () => {
    const shaped = shapeAssemblyState(stateOf(input), 'changed', input, { inputDoc: input, baseline })
    expect(shaped.instances).toEqual([])
    expect(shaped.mateFrames).toEqual({})
  })
})

describe('shapeAssemblyExport', () => {
  const state: AssemblyExportState = {
    solve: solveOf(flangeDoc(2)),
    mates: [problem],
    parts: [],
    instances: instancePoses(flangeDoc(2), { plate: identity(0), bolt0: identity(0), bolt1: identity(1) }),
    summary: 'instances: plate (plate, fixed), bolt0 (bolt), bolt1 (bolt)',
  }

  it('full keeps the export state as it is', () => {
    expect(shapeAssemblyExport(state, 'full')).toBe(state)
  })

  it('summary drops the poses and strips the solve record maps', () => {
    const shaped = shapeAssemblyExport(state, 'summary') as Record<string, unknown>
    expect(shaped.instances).toBeUndefined()
    expect(shaped.solve).not.toHaveProperty('mates')
    expect(shaped.solve).not.toHaveProperty('parts')
    expect(shaped.mates).toEqual([problem])
    expect(shaped.summary).toBe(state.summary)
  })

  it('changed is the same key set as summary, not the run changed arm', () => {
    expect(Object.keys(shapeAssemblyExport(state, 'changed') as object).sort())
      .toEqual(Object.keys(shapeAssemblyExport(state, 'summary') as object).sort())
    expect((shapeAssemblyExport(state, 'changed') as Record<string, unknown>).instances).toBeUndefined()
  })
})

describe('shapeAssemblyMeasures', () => {
  const measures = {
    bodies: 2,
    volume: 6000,
    area: 1200,
    centroid: [1, 2, 3] as [number, number, number],
    bbox: [0, 0, 0, 100, 60, 10] as [number, number, number, number, number, number],
    faces: 12,
    edges: 36,
    vertices: 24,
    perBody: [
      { id: 'plate/body_ex1', volume: 5000, area: 900, centroid: [1, 2, 3] as [number, number, number], bbox: [0, 0, 0, 100, 60, 10] as [number, number, number, number, number, number], faces: 6, edges: 12, vertices: 8 },
      { id: 'pin/body_ex1', volume: 1000, area: 300, centroid: [1, 2, 3] as [number, number, number], bbox: [0, 0, 0, 10, 10, 20] as [number, number, number, number, number, number], faces: 6, edges: 24, vertices: 16 },
    ],
  }

  it('full keeps the per-body table', () => {
    expect(shapeAssemblyMeasures(measures, 'full')).toBe(measures)
  })

  it('summary and changed drop perBody but keep the aggregate numbers', () => {
    for (const detail of ['summary', 'changed'] as const) {
      const shaped = shapeAssemblyMeasures(measures, detail) as Record<string, unknown>
      expect(shaped.perBody, detail).toBeUndefined()
      expect(shaped).toMatchObject({ bodies: 2, volume: 6000, area: 1200, faces: 12, edges: 36, vertices: 24 })
    }
  })
})

describe('movedInstances and touchedMateIds', () => {
  it('compare at the document rounding, and a new instance counts as moved', () => {
    const doc = flangeDoc(1)
    const before = instancePoses(doc, { plate: identity(0), bolt0: identity(0) })
    const nudged = instancePoses(doc, { plate: identity(0), bolt0: identity(1e-9) })
    expect(movedInstances(nudged, before)).toEqual([])
    expect(movedInstances(nudged, before.slice(0, 1)).map(p => p.handle)).toEqual(['bolt0'])
    expect(movedInstances(nudged, null)).toEqual([])
  })

  it('an added mate and an edited mate are touched; an untouched one is not', () => {
    const touched = touchedMateIds(flangeDoc(2), flangeDoc(3, 'm0'))
    expect([...touched].sort()).toEqual(['m0', 'm2'])
    expect([...touchedMateIds(null, flangeDoc(2))].sort()).toEqual(['m0', 'm1'])
  })
})

describe('assemblyRunReply', () => {
  const doc = flangeDoc(6, 'm5')
  const source = () => {
    const state = stateOf(doc, 'bolt5')
    return {
      ok: true,
      outcome: { steps: Array.from({ length: 48 }, (_, index) => ({ index, kind: 'mutation', id: 'add_part', ok: true, createdIds: [`i${index}`] })) },
      doc,
      binding: new Map(),
      solve: state.solve,
      mates: state.mates,
      partProblems: state.parts,
      instances: state.instances,
      mateFrames: state.mateFrames,
      summary: state.summary,
    }
  }

  it('full without shaping is today\'s reply, key order included', () => {
    const reply = assemblyRunReply(source(), false, new DocHandleStore())
    expect(Object.keys(reply)).toEqual(['ok', 'kind', 'steps', 'docHash', 'solve', 'mates', 'parts', 'instances', 'mateFrames', 'summary'])
    expect((reply.steps as unknown[]).length).toBe(48)
  })

  it('changed collapses accepted steps and keeps a refused one whole', () => {
    const src = source()
    ;(src.outcome.steps[47] as { ok: boolean }).ok = false
    const reply = assemblyRunReply(src, false, new DocHandleStore(), {
      detail: 'changed',
      context: { inputDoc: flangeDoc(6), baseline: stateOf(flangeDoc(6)).instances },
    })
    expect(reply.stepsAccepted).toBe(47)
    expect((reply.steps as Array<{ index: number }>).map(s => s.index)).toEqual([47])
  })

  // A rotating capture's seed roll lives only in the step report, never in
  // the document, so the edited-delta level must not collapse it away.
  it('changed keeps an accepted step that carries a captured report; summary does not', () => {
    const src = source()
    ;(src.outcome.steps[3] as { captured?: unknown }).captured = { flip: false, roll: 80 }
    const context = { inputDoc: flangeDoc(6), baseline: stateOf(flangeDoc(6)).instances }
    const changed = assemblyRunReply(src, false, new DocHandleStore(), { detail: 'changed', context })
    expect(changed.stepsAccepted).toBe(48)
    expect(changed.steps).toEqual([expect.objectContaining({ index: 3, ok: true, captured: { flip: false, roll: 80 } })])
    const summary = assemblyRunReply(src, false, new DocHandleStore(), { detail: 'summary', context })
    expect(summary.stepsAccepted).toBe(48)
    expect(summary.steps).toBeUndefined()
  })

  // The six-stack flange call returned about 40 kB; a later field must not
  // creep back into the compact reply.
  it('the six-stack changed reply stays under 6 kB', () => {
    const reply = assemblyRunReply(source(), false, new DocHandleStore(), {
      detail: 'changed',
      context: { inputDoc: flangeDoc(6), baseline: stateOf(flangeDoc(6)).instances },
    })
    const size = JSON.stringify(reply).length
    expect(size).toBeLessThan(6000)
    const full = JSON.stringify(assemblyRunReply(source(), false, new DocHandleStore())).length
    expect(full).toBeGreaterThan(size * 3)
  })
})

describe('mutations family and kind filters', () => {
  const full = mutationCatalogPayload()

  it('no filter returns the whole catalog', () => {
    expect(filterMutationCatalog(full, {})).toEqual({ ok: true, payload: full })
  })

  it('a family returns that family only, with examples that use it', () => {
    const result = filterMutationCatalog(full, { family: 'features' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.payload.families!)).toEqual(['features'])
    expect(result.payload.assembly).toBeUndefined()
    const types = new Set(result.payload.families!.features!.map(entry => entry.type))
    for (const example of result.payload.examples!) {
      expect(example.steps.some(step => 'mutation' in step && types.has((step.mutation as { type: never }).type))).toBe(true)
    }
  })

  it('kind assembly returns the assembly slice alone, a family narrows it', () => {
    const kind = filterMutationCatalog(full, { kind: 'assembly' })
    expect(kind.ok && Object.keys(kind.payload)).toEqual(['assembly'])
    const family = filterMutationCatalog(full, { family: 'mates' })
    expect(family.ok && Object.keys(family.payload.assembly!.families)).toEqual(['mates'])
  })

  it('an unknown family is refused with the valid list', () => {
    const result = filterMutationCatalog(full, { family: 'nope' })
    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.error).toContain('sketch')
    expect(result.error).toContain('mates')
  })

  it('a family of the other kind is refused', () => {
    const result = filterMutationCatalog(full, { kind: 'part', family: 'mates' })
    expect(result).toMatchObject({ ok: false })
  })

  it('the tool call passes the filter through and maps a refusal to invalid params', async () => {
    const ops = {} as McpCadOps
    const server = createMcpServer(ops)
    const call = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mutations', arguments: { family: 'mates' } } })
    const text = (call as { result: { content: Array<{ text: string }> } }).result.content[0].text
    expect(Object.keys(JSON.parse(text).assembly.families)).toEqual(['mates'])
    const bad = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mutations', arguments: { family: 'nope' } } })
    expect(bad).toMatchObject({ error: { code: -32602 } })
  })
})

describe('mutations type and detail filters', () => {
  const full = mutationCatalogPayload()

  it('a type returns its one row and only the examples that use it', () => {
    const result = filterMutationCatalog(full, { type: 'add_shell' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.payload.families!)).toEqual(['features'])
    expect(result.payload.assembly).toBeUndefined()
    expect(result.payload.families!.features!.map(row => row.type)).toEqual(['add_shell'])
    // No served example runs add_shell today.
    expect(result.payload.examples).toEqual([])
  })

  it('an array of types keeps one row per type across families', () => {
    const result = filterMutationCatalog(full, { type: ['add_rect', 'add_hole'] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.payload.families!).sort()).toEqual(['features', 'sketch'])
    expect(result.payload.families!.sketch!.map(row => row.type)).toEqual(['add_rect'])
    expect(result.payload.families!.features!.map(row => row.type)).toEqual(['add_hole'])
    expect(result.payload.examples!.map(example => example.name)).toEqual(['box', 'filleted-box', 'tapered-block', 'projection', 'emboss-on-cylinder'])
  })

  it('an unknown type names the closest known type and its family', () => {
    const result = filterMutationCatalog(full, { type: 'add_shel' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('"add_shell"')
    expect(result.error).toContain('features')
  })

  it('a type of another family is refused', () => {
    const result = filterMutationCatalog(full, { type: 'add_shell', family: 'sketch' })
    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.error).toContain('family "sketch"')
  })

  it('a type of another kind is refused', () => {
    const result = filterMutationCatalog(full, { type: 'add_shell', kind: 'assembly' })
    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.error).toContain('kind "assembly"')
  })

  it('type and family agree when they name the same row', () => {
    const result = filterMutationCatalog(full, { type: 'add_shell', family: 'features' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.payload.families!)).toEqual(['features'])
    expect(result.payload.families!.features!.map(row => row.type)).toEqual(['add_shell'])
  })

  it('an empty type array is refused', () => {
    expect(filterMutationCatalog(full, { type: [] })).toMatchObject({ ok: false })
  })

  it('an assembly type lands under assembly.families', () => {
    const result = filterMutationCatalog(full, { type: 'add_mate' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.payload.families).toBeUndefined()
    expect(Object.keys(result.payload.assembly!.families)).toEqual(['mates'])
    expect(result.payload.assembly!.families.mates!.map(row => row.type)).toEqual(['add_mate'])
    expect(result.payload.assembly!.examples.length).toBeGreaterThan(0)
    for (const example of result.payload.assembly!.examples) {
      expect(example.steps.some(step => step.mutation.type === 'add_mate')).toBe(true)
    }
  })

  it('detail index keeps only type and summary per row and stays under 15 kB', () => {
    const result = filterMutationCatalog(full, { detail: 'index' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.payload.examples).toEqual([])
    expect(result.payload.assembly!.examples).toEqual([])
    const rows = [
      ...Object.values(result.payload.families!),
      ...Object.values(result.payload.assembly!.families),
    ].flat()
    expect(rows.length).toBeGreaterThan(100)
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['summary', 'type'])
    // A ratchet against notes or fields creeping back into the index.
    expect(JSON.stringify(result.payload).length).toBeLessThan(15000)
  })

  it('detail index composes with a family', () => {
    const result = filterMutationCatalog(full, { family: 'features', detail: 'index' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.payload.families!)).toEqual(['features'])
    expect(result.payload.assembly).toBeUndefined()
    const rows = result.payload.families!.features!
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['summary', 'type'])
    expect(result.payload.examples).toEqual([])
  })

  it('the tool accepts type and detail and refuses an unknown detail', async () => {
    const server = createMcpServer({} as McpCadOps)
    const call = await server.handle({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'mutations', arguments: { type: 'add_shell', detail: 'index' } },
    })
    const text = (call as { result: { content: Array<{ text: string }> } }).result.content[0].text
    const payload = JSON.parse(text) as { families: Record<string, Array<{ type: string; summary: string }>> }
    expect(payload.families.features).toEqual([{ type: 'add_shell', summary: expect.any(String) }])

    const badDetail = await server.handle({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'mutations', arguments: { detail: 'brief' } },
    })
    expect(badDetail).toMatchObject({ error: { code: -32602 } })

    const badType = await server.handle({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'mutations', arguments: { type: 'add_shel' } },
    })
    expect(badType).toMatchObject({ error: { code: -32602 } })
    expect((badType as { error: { message: string } }).error.message).toContain('add_shell')

    const badElement = await server.handle({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'mutations', arguments: { type: [1] } },
    })
    expect(badElement).toMatchObject({ error: { code: -32602 } })

    const empty = await server.handle({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'mutations', arguments: { type: [] } },
    })
    expect(empty).toMatchObject({ error: { code: -32602 } })
  })
})
