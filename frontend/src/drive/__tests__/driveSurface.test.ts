// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createDriveSurface, installDriveSurface, pickEditorFacts, summarizeInspection,
  type DriveCommandTable, type DriveEditorStateLike, type DriveSessionInspectionLike, type DriveSurfaceDeps,
} from '../driveSurface'
import { okResult, type Result } from '@/session/result'
import type { Mutation } from '@/types/cad'
import {
  publishProbeCamera, publishProbeCanvas, replaceProbeSource, resetSceneProbeStore,
} from '@/picking'
import type { ProbeCamera } from '@/picking'

// Maps world x in [-400, 400], y in [-300, 300] onto the 800x600 canvas, the
// same fixture the probe store suite uses.
const CAMERA: ProbeCamera = {
  position: [0, 0, 0],
  orientation: [0, 0, 0, 1],
  zoom: 1,
  projectionMatrix: [
    1 / 400, 0, 0, 0,
    0, 1 / 300, 0, 0,
    0, 0, -1 / 500, 0,
    0, 0, 0, 1,
  ],
}

function editorState(overrides: Partial<DriveEditorStateLike> = {}): DriveEditorStateLike {
  return {
    normalSelection: new Set<string>(),
    hoveredSelectionId: null,
    hoveredVertexId: null,
    activeTool: null,
    activeFeatureId: null,
    editingFeatureId: null,
    rollbackPosition: null,
    drawPoints: [],
    dimensionPicks: [],
    activePickField: null,
    ...overrides,
  }
}

function sessionInspection(overrides: Partial<DriveSessionInspectionLike> = {}): DriveSessionInspectionLike {
  return {
    docId: 'doc-1',
    dirty: false,
    featureCount: 2,
    rollback: null,
    editingFeatureId: null,
    history: { undo: ['add rect'], redo: [] },
    transactions: [],
    solve: { generation: 3, pending: false, running: false, lastError: null },
    ...overrides,
  }
}

function fakeRegistry(): DriveCommandTable {
  return {
    enabled: (id) => (id === 'fail' ? 'not enabled in test' : true),
    execute: (id) => {
      if (id === 'boom') throw new Error('executor blew up')
      if (id === 'fail') return { ok: false, code: 'unknown-command', message: 'nope' }
      return okResult(['created-1'])
    },
  }
}

function deps(overrides: Partial<DriveSurfaceDeps> = {}): DriveSurfaceDeps {
  return {
    registry: fakeRegistry(),
    specs: [
      { id: 'ok', label: 'Okay' },
      { id: 'fail', label: 'Failing', shortcut: 'x' },
    ],
    inspectSession: () => sessionInspection(),
    editorState: () => editorState(),
    idle: () => Promise.resolve(),
    ...overrides,
  }
}

beforeEach(() => {
  resetSceneProbeStore()
})

describe('drive surface', () => {
  it('lists the spec table with the live enabled verdict', () => {
    const surface = createDriveSurface(deps())
    expect(surface.commands()).toEqual([
      { id: 'ok', label: 'Okay', enabled: true },
      { id: 'fail', label: 'Failing', shortcut: 'x', enabled: 'not enabled in test' },
    ])
  })

  it('returns Results from execute and never throws', () => {
    const surface = createDriveSurface(deps())
    expect(surface.execute('ok')).toEqual({ ok: true, createdIds: ['created-1'] })
    expect(surface.execute('fail')).toEqual({ ok: false, code: 'unknown-command', message: 'nope' })
    const boom = surface.execute('boom')
    expect(boom.ok).toBe(false)
    expect(boom).toMatchObject({ code: 'bridge-error' })
  })

  it('runs a script through the registry, settling after each step', async () => {
    const idle = vi.fn(() => Promise.resolve())
    const surface = createDriveSurface(deps({ idle }))
    const outcome = await surface.script([{ command: 'ok' }, { command: 'fail' }])
    expect(idle).toHaveBeenCalledTimes(2)
    expect(outcome.ok).toBe(false)
    expect(outcome.steps.map(s => s.id)).toEqual(['ok', 'fail'])
  })

  it('routes mutation steps to the mutation executor', async () => {
    const seen: Mutation[] = []
    const surface = createDriveSurface(deps({
      executeMutation: (m) => { seen.push(m); return okResult(['m1']) as Result },
    }))
    const outcome = await surface.script([{ mutation: { type: 'set_rollback', position: null } }])
    expect(outcome.ok).toBe(true)
    expect(seen).toEqual([{ type: 'set_rollback', position: null }])
    expect(outcome.steps[0].createdIds).toEqual(['m1'])
  })

  it('fails mutation steps when no mutation executor was wired', async () => {
    const surface = createDriveSurface(deps())
    const outcome = await surface.script([{ mutation: { type: 'set_rollback', position: null } }])
    expect(outcome.ok).toBe(false)
    expect(outcome.steps[0].error?.code).toBe('bridge-error')
  })

  it('summarizes the session inspection and drops the mesh payload', () => {
    const summary = summarizeInspection(sessionInspection({
      bodies: { b1: { mesh: new Float32Array([1, 2]) }, b2: {} },
      validation: { level: 2, passed: true, fp_only: true, diffs: { x: 1 } },
    }))
    expect(summary.bodies).toEqual({ count: 2, ids: ['b1', 'b2'] })
    expect(summary.validation).toEqual({ level: 2, passed: true, fp_only: true })
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary)
  })

  it('inspects session, editor and probe facts as one JSON-safe object', () => {
    publishProbeCamera(CAMERA)
    publishProbeCanvas(800, 600)
    replaceProbeSource('test', [{
      pickKey: 'vertex:F1:e1:start',
      entityKey: 'vertex:F1:e1:start',
      layer: 'sketchVertex',
      kind: 'point',
      points: [[0, 0, 0]],
    }])
    const surface = createDriveSurface(deps({
      editorState: () => editorState({
        normalSelection: new Set(['entity:F1:e1']),
        activeTool: 'rect',
        drawPoints: [1, 2],
        activePickField: { featureId: 'F1', field: 'plane' },
      }),
    }))
    const inspection = surface.inspect()
    expect(inspection.session.featureCount).toBe(2)
    expect(inspection.editor.normalSelection).toEqual(['entity:F1:e1'])
    expect(inspection.editor.drawPointCount).toBe(2)
    expect(inspection.editor.activePickField).toEqual({ featureId: 'F1', field: 'plane' })
    expect(inspection.probe.canvas).toEqual({ width: 800, height: 600 })
    expect(inspection.probe.pickableCount).toBe(1)
    // The whole readout round-trips through JSON unchanged.
    expect(JSON.parse(JSON.stringify(inspection))).toEqual(inspection)
  })

  it('answers hitTest, handles and worldToScreen from the live probe', () => {
    publishProbeCamera(CAMERA)
    publishProbeCanvas(800, 600)
    replaceProbeSource('test', [{
      pickKey: 'vertex:F1:e1:start',
      entityKey: 'vertex:F1:e1:start',
      layer: 'sketchVertex',
      kind: 'point',
      points: [[0, 0, 0]],
    }])
    const surface = createDriveSurface(deps())
    // World origin projects to the canvas centre (400, 300).
    expect(surface.worldToScreen([[0, 0, 0]])).toEqual([[400, 300]])
    expect(surface.hitTest(400, 300).map(h => h.pickKey)).toEqual(['vertex:F1:e1:start'])
    expect(surface.hitTest(10, 10)).toEqual([])
    const handles = surface.handles('vertex:')
    expect(handles).toHaveLength(1)
    expect(handles[0]).toMatchObject({ kind: 'gl', handle: 'vertex:F1:e1:start' })
  })

  it('exposes the journal and writes a repro through the download seam', () => {
    const entry = { commandId: 'bump', params: null, docHashBefore: 'a', docHashAfter: 'b', at: 7 }
    const repro = { kind: 'oversolved-repro' as const, version: 1 as const, docHash: 'a', doc: { n: 0 }, journal: [entry] }
    const downloads: Array<{ filename: string; text: string }> = []
    const surface = createDriveSurface(deps({
      journal: {
        repro: () => repro,
        download: (filename, text) => downloads.push({ filename, text }),
      },
    }))
    expect(surface.journal()).toEqual([entry])
    expect(surface.repro()).toEqual(repro)
    const result = surface.downloadRepro('my-repro.json')
    expect(result).toEqual({ ok: true, filename: 'my-repro.json', bytes: downloads[0].text.length })
    expect(downloads).toHaveLength(1)
    expect(JSON.parse(downloads[0].text)).toEqual(repro)
  })

  it('reports an empty journal instead of downloading nothing', () => {
    const surface = createDriveSurface(deps({ journal: { repro: () => null } }))
    expect(surface.journal()).toEqual([])
    expect(surface.repro()).toBeNull()
    const result = surface.downloadRepro()
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ code: 'bridge-error' })
  })

  it('installs and uninstalls without stealing a successor surface', () => {
    const target: { __oversolved?: ReturnType<typeof createDriveSurface> } = {}
    const uninstall = installDriveSurface(deps(), target)
    const first = target.__oversolved
    expect(first).toBeDefined()
    const uninstallSecond = installDriveSurface(deps(), target)
    const second = target.__oversolved
    expect(second).not.toBe(first)
    // The stale uninstall must not clear the newer surface.
    uninstall()
    expect(target.__oversolved).toBe(second)
    uninstallSecond()
    expect(target.__oversolved).toBeUndefined()
  })
})

describe('pickEditorFacts', () => {
  it('extracts only the JSON-shaped subset', () => {
    const facts = pickEditorFacts(editorState({
      normalSelection: new Set(['a', 'b']),
      hoveredSelectionId: 'hover',
      dimensionPicks: [{}, {}],
    }))
    expect(facts).toEqual({
      normalSelection: ['a', 'b'],
      hoveredSelectionId: 'hover',
      hoveredVertexId: null,
      activeTool: null,
      activeFeatureId: null,
      editingFeatureId: null,
      rollbackPosition: null,
      drawPointCount: 0,
      dimensionPickCount: 2,
      activePickField: null,
    })
  })
})
