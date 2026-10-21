// The drive surface: the JSON-safe object installed as `window.__oversolved`
// by the editor page when the build gate allows it. It is a thin facade over
// the command registry, the session and the scene probe, with every method
// returning plain JSON-shaped values and every failure returned as a Result,
// never thrown across the bridge. The page supplies the live getters, so this
// module imports no UI store and stays testable headlessly.

import type { Mutation } from '@/types/cad'
import type { CommandResult } from '@/utils/core/commandSpec'
import type { Result } from '@/session/result'
import {
  getSceneHandles, getSceneProbe, probeHitTest, worldToScreen,
  type ProbeCamera, type ProbeHandle, type ProbeHit,
} from '@/picking'
import { runScript, type ScriptFailure, type ScriptRunOutcome, type ScriptStep } from './scriptRunner'
import { validateMutation } from './mutationCatalog'
import type { JournalEntry, ReproPayload } from './journal'

// The registry failures plus the bridge's own guard for an executor that
// throws: a bug in a command body must still come back as a Result.
export type DriveExecuteResult = CommandResult | ScriptFailure

// The registry view the bridge needs, with string ids: the command union is
// closed at the spec table, but the bridge is the external vocabulary, so an
// unknown id must reach the registry and come back as its unknown-command
// Result rather than be a type error at the call site. CommandRegistry
// satisfies this structurally (its methods are bivariant in their id).
export interface DriveCommandTable {
  enabled(id: string): true | string
  execute(id: string, params?: unknown): CommandResult
}

export interface DriveCommandInfo {
  id: string
  label: string
  shortcut?: string
  // true, or the reason the command is currently disabled.
  enabled: true | string
}

// The live editor-state subset the bridge reports. Structural, not the store's
// type, so the page passes whatever the store holds and the mapping stays pure.
export interface DriveEditorStateLike {
  normalSelection: ReadonlySet<string>
  hoveredSelectionId: string | null
  hoveredVertexId: string | null
  activeTool: string | null
  activeFeatureId: string | null
  editingFeatureId: string | null
  rollbackPosition: number | null
  drawPoints: readonly unknown[]
  dimensionPicks: readonly unknown[]
  activePickField: { featureId: string; field: string } | null
}

export interface DriveEditorFacts {
  normalSelection: string[]
  hoveredSelectionId: string | null
  hoveredVertexId: string | null
  activeTool: string | null
  activeFeatureId: string | null
  editingFeatureId: string | null
  rollbackPosition: number | null
  drawPointCount: number
  dimensionPickCount: number
  activePickField: { featureId: string; field: string } | null
}

export interface DriveSessionFacts {
  docId: string | null
  dirty: boolean
  featureCount: number
  rollback: number | null
  editingFeatureId: string | null
  history: { undo: string[]; redo: string[] }
  transactions: { id: string; kind: string }[]
  solve: { generation: number; pending: boolean; running: boolean; lastError: string | null }
  validation: { level: number; passed: boolean; fp_only?: boolean } | null
  bodies: { count: number; ids: string[] } | null
}

export interface DriveProbeFacts {
  revision: number
  canvas: { width: number; height: number }
  camera: ProbeCamera | null
  pickableCount: number
  // The full handle set: GL pickables plus DOM controls carrying
  // data-oversolved-handle. The handles themselves stay behind handles().
  handleCount: number
}

export interface DriveInspection {
  session: DriveSessionFacts
  editor: DriveEditorFacts
  probe: DriveProbeFacts
}

export interface DriveHitOptions {
  windowSize?: number
  // Layer names to restrict to; converted to the probe's Set form here so the
  // bridge input stays JSON-shaped too.
  allowedLayers?: readonly string[]
}

// The session inspection the page hands in, shaped exactly like
// DocSession.inspect(). The bodies and validation slots may carry typed arrays
// (mesh data), so summarizeInspection reduces them to countable facts.
export interface DriveSessionInspectionLike {
  docId: string | null
  dirty: boolean
  featureCount: number
  rollback: number | null
  editingFeatureId: string | null
  history: { undo: string[]; redo: string[] }
  transactions: readonly { id: string; kind: string }[]
  solve: { generation: number; pending: boolean; running: boolean; lastError: string | null }
  validation?: unknown
  bodies?: unknown
}

// The journal side of the bridge: reading the ring and writing a repro file.
// Absent in a caller that only wants the command/probe surface.
export interface DriveJournalDeps {
  repro(): ReproPayload | null
  // Overridable so tests (and a future non-DOM host) can capture the text
  // instead of triggering a browser download.
  download?: (filename: string, text: string) => void
}

export interface DriveSurfaceDeps {
  registry: DriveCommandTable
  // The registered spec table; the registry itself cannot enumerate labels.
  specs: readonly { id: string; label: string; shortcut?: string }[]
  inspectSession: () => DriveSessionInspectionLike
  editorState: () => DriveEditorStateLike
  idle: () => Promise<void>
  // The mutation path a script's mutation steps take. Absent means mutation
  // steps fail as bridge errors rather than throwing.
  executeMutation?: (mutation: Mutation) => Result | null
  screenshot?: () => Promise<string | null>
  journal?: DriveJournalDeps
}

export type DriveDownloadResult =
  | { ok: true; filename: string; bytes: number }
  | ScriptFailure

export interface DriveSurface {
  commands(): DriveCommandInfo[]
  execute(id: string, params?: unknown): DriveExecuteResult
  script(steps: readonly ScriptStep[]): Promise<ScriptRunOutcome>
  inspect(): DriveInspection
  idle(): Promise<void>
  hitTest(x: number, y: number, opts?: DriveHitOptions): ProbeHit[]
  handles(prefix?: string): ProbeHandle[]
  worldToScreen(points: ReadonlyArray<readonly [number, number, number]>): ([number, number] | null)[]
  screenshot(): Promise<string | null>
  journal(): JournalEntry[]
  repro(): ReproPayload | null
  downloadRepro(filename?: string): DriveDownloadResult
}

declare global {
  interface Window {
    __oversolved?: DriveSurface
  }
}

/** The live-state subset the bridge reports, extracted pure for tests. */
export function pickEditorFacts(state: DriveEditorStateLike): DriveEditorFacts {
  return {
    normalSelection: [...state.normalSelection],
    hoveredSelectionId: state.hoveredSelectionId,
    hoveredVertexId: state.hoveredVertexId,
    activeTool: state.activeTool,
    activeFeatureId: state.activeFeatureId,
    editingFeatureId: state.editingFeatureId,
    rollbackPosition: state.rollbackPosition,
    drawPointCount: state.drawPoints.length,
    dimensionPickCount: state.dimensionPicks.length,
    activePickField: state.activePickField
      ? { featureId: state.activePickField.featureId, field: state.activePickField.field }
      : null,
  }
}

/**
 * Reduce the session's inspection to JSON-safe, bounded facts. Bodies and
 * validation are summarized rather than copied: a body's mesh holds typed
 * arrays, and the full geometry belongs to screenshot and the probe, not to a
 * state readout.
 */
export function summarizeInspection(inspection: DriveSessionInspectionLike): DriveSessionFacts {
  const validation = inspection.validation as { level?: unknown; passed?: unknown; fp_only?: unknown } | null | undefined
  const bodies = inspection.bodies as Record<string, unknown> | null | undefined
  return {
    docId: inspection.docId,
    dirty: inspection.dirty,
    featureCount: inspection.featureCount,
    rollback: inspection.rollback,
    editingFeatureId: inspection.editingFeatureId,
    history: { undo: [...inspection.history.undo], redo: [...inspection.history.redo] },
    transactions: inspection.transactions.map(t => ({ id: t.id, kind: t.kind })),
    solve: {
      generation: inspection.solve.generation,
      pending: inspection.solve.pending,
      running: inspection.solve.running,
      lastError: inspection.solve.lastError,
    },
    validation: validation
      ? {
          level: typeof validation.level === 'number' ? validation.level : 0,
          passed: validation.passed === true,
          ...(validation.fp_only === true && { fp_only: true }),
        }
      : null,
    bodies: bodies
      ? { count: Object.keys(bodies).length, ids: Object.keys(bodies).sort() }
      : null,
  }
}

/** The browser download the repro path defaults to. */
function defaultDownload(filename: string, text: string): void {
  if (typeof document === 'undefined') throw new Error('no document available for a download')
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function createDriveSurface(deps: DriveSurfaceDeps): DriveSurface {
  const execute = (id: string, params?: unknown): DriveExecuteResult => {
    try {
      return deps.registry.execute(id, params)
    } catch (e) {
      return {
        ok: false,
        code: 'bridge-error',
        message: e instanceof Error ? e.message : String(e),
      }
    }
  }

  const executeMutation = (raw: unknown): DriveExecuteResult => {
    // Both external surfaces validate at the same boundary, so the bridge and
    // the headless runner refuse an untyped mutation identically.
    const validated = validateMutation(raw)
    if (!validated.ok) {
      return { ok: false, code: validated.error.code, message: validated.error.message }
    }
    if (!deps.executeMutation) {
      return { ok: false, code: 'bridge-error', message: 'mutation steps are not supported by this surface' }
    }
    try {
      const result = deps.executeMutation(validated.mutation)
      // The adapter's no-document no-op reads as success: nothing was wrong
      // with the step, there was simply no document to apply it to.
      return result ?? { ok: true, createdIds: [] }
    } catch (e) {
      return {
        ok: false,
        code: 'bridge-error',
        message: e instanceof Error ? e.message : String(e),
      }
    }
  }

  return {
    commands: () => deps.specs.map(spec => ({
      id: spec.id,
      label: spec.label,
      ...(spec.shortcut !== undefined && { shortcut: spec.shortcut }),
      enabled: deps.registry.enabled(spec.id),
    })),
    execute,
    script: (steps) => runScript(
      steps,
      step => ('command' in step ? execute(step.command, step.params) : executeMutation(step.mutation)),
      () => deps.idle(),
    ),
    inspect: () => {
      const probe = getSceneProbe()
      return {
        session: summarizeInspection(deps.inspectSession()),
        editor: pickEditorFacts(deps.editorState()),
        probe: {
          revision: probe.revision,
          canvas: { width: probe.canvas.width, height: probe.canvas.height },
          camera: probe.camera,
          pickableCount: probe.pickables.length,
          handleCount: getSceneHandles().length,
        },
      }
    },
    idle: () => deps.idle(),
    hitTest: (x, y, opts) => probeHitTest(x, y, opts
      ? {
          ...(opts.windowSize !== undefined && { windowSize: opts.windowSize }),
          ...(opts.allowedLayers !== undefined && { allowedLayers: new Set(opts.allowedLayers) }),
        }
      : undefined),
    handles: prefix => getSceneHandles(prefix),
    worldToScreen: points => worldToScreen(getSceneProbe(), points),
    screenshot: () => deps.screenshot?.() ?? Promise.resolve(null),
    journal: () => deps.journal?.repro()?.journal ?? [],
    repro: () => deps.journal?.repro() ?? null,
    downloadRepro: (filename = 'oversolved-repro.json') => {
      const repro = deps.journal?.repro() ?? null
      if (!repro) return { ok: false, code: 'bridge-error', message: 'the journal is empty; nothing to reproduce' }
      const text = JSON.stringify(repro, null, 1) + '\n'
      const download = deps.journal?.download ?? defaultDownload
      try {
        download(filename, text)
      } catch (e) {
        return { ok: false, code: 'bridge-error', message: e instanceof Error ? e.message : String(e) }
      }
      // UTF-8 byte length, not code units: a repro carries user labels, so the
      // count must match the bytes actually written.
      return { ok: true, filename, bytes: new TextEncoder().encode(text).byteLength }
    },
  }
}

export interface DriveTarget {
  __oversolved?: DriveSurface
}

/**
 * Install the surface on `target` (the page passes window; tests pass a plain
 * object). Returns an uninstall that only clears the slot while it still holds
 * this install, so a stale unmount cannot delete its successor's surface.
 */
export function installDriveSurface(
  deps: DriveSurfaceDeps,
  target: DriveTarget = globalThis as unknown as DriveTarget,
): () => void {
  const surface = createDriveSurface(deps)
  target.__oversolved = surface
  return () => {
    if (target.__oversolved === surface) delete target.__oversolved
  }
}
