/**
 * The worker side of the MCP kernel host (kernelHost.ts): boots the headless
 * kernel in this thread and serves one op per request through the shared
 * headless operations, posting a progress mark before every feature it solves.
 *
 * Replies are structured clones, so they carry data only: `run` drops the live
 * session (`part`), and an error crosses as its name and message plus, for a
 * KernelFault, whether its modules were already replaced (the flag the host
 * respawns on).
 */

import { setOccLoader, kernelReloadRequired } from '@/kernel/solveLocally'
import { loadOcc, resetOcc } from '@/kernel/occ/loadOcc'
import { loadSolverFresh } from '@/wasm-kernel/loadSolver'
import { loadPkgNodeExport, PKG_MATE } from '@/wasm-kernel/loadPkgNode'
import { setSketchSolverLoader } from '@/kernel/features/sketch'
import { onFeatureStart } from '@/kernel/featureProgress'
import { KernelFault } from '@/kernel/errors'
import { setMateSolver } from '@/drive/headlessAssembly'
import type { AssemblyDoc, PartDoc } from '@/types/cad'
import type { Selector } from '@/kernel/select'
import type { TranslationReference } from '@/translations/corpus'
import type { ScriptStep } from '@/drive/scriptRunner'
import { createDriveJournal } from '@/drive/journal'
import { runHeadless, measureHeadless, compareHeadless, exportHeadless, selectHeadless, runAssemblyHeadless, measureAssemblyHeadless, compareAssemblyHeadless, exportAssemblyHeadless } from '@/drive/headlessOps'
import type { AssemblyScriptStep } from '@/drive/headlessAssembly'
import type { KernelErrorShape, KernelFaultState, KernelHostMessage, KernelRequest } from '@/drive/kernelHost'

/** The headless OCC loader, the nodejs solver builds and the mate solver;
 *  without them every solve reports the kernel unavailable. A missing mate
 *  package leaves the slot null, which the assembly reply reports as the
 *  `unavailable` verdict rather than a crash.
 *
 *  The sketch module is installed as a LOADER, not as bytes: a trap in its wasm
 *  heap has to be replaced by a new module instance, and only a loader can
 *  produce one (bug-headless-sketch-trap-reload). */
export function bootHeadlessKernel(): void {
  setOccLoader(loadOcc, resetOcc)
  setSketchSolverLoader(loadSolverFresh)
  setMateSolver(loadPkgNodeExport<(input: Uint8Array) => Uint8Array>('solve_mate_bytes', PKG_MATE))
}

/** The `worker_threads` parentPort surface this module needs. */
export interface KernelPort {
  postMessage(msg: KernelHostMessage): void
  on(event: 'message', cb: (msg: KernelRequest) => void): void
}

interface DocArgs {
  doc: PartDoc
  docId: string
  files?: ReadonlyMap<string, Uint8Array>
}

export interface KernelRunArgs extends DocArgs {
  steps: ScriptStep[]
  featureDeltas?: 'all'
  frames?: 'all'
}
export type KernelMeasureArgs = DocArgs
export interface KernelCompareArgs extends DocArgs {
  reference: TranslationReference
}
export interface KernelExportArgs extends DocArgs {
  format: 'step' | 'stl'
  bodyId: string | null
}
export interface KernelSelectArgs extends DocArgs {
  selector: Selector
}

interface AssemblyDocArgs {
  doc: AssemblyDoc
  parts: Record<string, PartDoc>
  files?: ReadonlyMap<string, Uint8Array>
}
export interface KernelAssemblyRunArgs extends AssemblyDocArgs {
  steps: AssemblyScriptStep[]
  // Also solve the starting document, for a reply that lists only moved poses.
  baseline?: boolean
}
export interface KernelAssemblyExportArgs extends AssemblyDocArgs {
  format: 'step' | 'stl'
  bodyId: string | null
}

async function runOp(req: KernelRequest, port: KernelPort): Promise<unknown> {
  switch (req.op) {
    case 'run': {
      const a = req.args as KernelRunArgs
      // The journal derives its id seed from the starting document, so a repeat
      // of the same document and script mints the same ids and hashes the same
      // document, while a call chained by docHash draws a fresh sequence.
      const { part: _part, ...result } = await runHeadless({
        doc: a.doc,
        steps: a.steps,
        docId: a.docId,
        files: a.files,
        journal: createDriveJournal(a.doc),
        ...(a.featureDeltas !== undefined && { featureDeltas: a.featureDeltas }),
        ...(a.frames !== undefined && { frames: a.frames }),
        // Each settled step's state crosses to the host so a stall in the next
        // step can answer with the accepted prefix instead of a bare timeout.
        onStepSettled: (checkpoint) => {
          port.postMessage({ kind: 'checkpoint', id: req.id, ...checkpoint })
        },
      })
      return result
    }
    case 'measure': {
      const a = req.args as KernelMeasureArgs
      return measureHeadless(a.doc, { docId: a.docId, files: a.files })
    }
    case 'compare': {
      const a = req.args as KernelCompareArgs
      return compareHeadless(a.doc, a.reference, { docId: a.docId, files: a.files })
    }
    case 'export': {
      const a = req.args as KernelExportArgs
      return exportHeadless(a.doc, { format: a.format, bodyId: a.bodyId, docId: a.docId, files: a.files })
    }
    case 'select': {
      const a = req.args as KernelSelectArgs
      return selectHeadless(a.doc, a.selector, { docId: a.docId, files: a.files })
    }
    case 'assemblyRun': {
      const a = req.args as KernelAssemblyRunArgs
      // The live session holds a History and a command registry, neither of
      // which is structured-cloneable; the reply is the data-only half.
      const { session: _session, ...result } = await runAssemblyHeadless({
        doc: a.doc,
        parts: new Map(Object.entries(a.parts)),
        steps: a.steps,
        ...(a.baseline === true && { baseline: true }),
        ...(a.files && { files: a.files }),
      })
      return result
    }
    case 'assemblyMeasure': {
      const a = req.args as AssemblyDocArgs
      return measureAssemblyHeadless(a.doc, new Map(Object.entries(a.parts)), a.files ? { files: a.files } : {})
    }
    case 'assemblyCompare': {
      const a = req.args as AssemblyDocArgs & { reference: TranslationReference }
      return compareAssemblyHeadless(a.doc, new Map(Object.entries(a.parts)), a.reference, a.files ? { files: a.files } : {})
    }
    case 'assemblyExport': {
      const a = req.args as KernelAssemblyExportArgs
      return exportAssemblyHeadless(a.doc, new Map(Object.entries(a.parts)), {
        format: a.format,
        bodyId: a.bodyId,
        ...(a.files && { files: a.files }),
      })
    }
  }
}

/** Serve kernel requests on `port`. The host posts one at a time. */
export function serveKernel(port: KernelPort): void {
  onFeatureStart((featureId) => port.postMessage({ kind: 'progress', featureId }))
  port.on('message', (req) => {
    const fail = (e: unknown): void => {
      // A fault carries whether its modules were replaced: the host respawns a
      // worker on `reloaded: false` rather than matching the message text.
      const error: KernelErrorShape = e instanceof Error
        ? { name: e.name, message: e.message, ...(e instanceof KernelFault && { reloaded: e.reloaded }) }
        : { name: 'Error', message: String(e) }
      port.postMessage({ kind: 'reply', id: req.id, ok: false, error })
    }
    runOp(req, port).then(
      (value) => {
        // A reply that cannot be structured-cloned must answer as an error: an
        // unhandled throw here would kill the worker and lose the call.
        try {
          // A run keeps its trap on `solve.lastError` instead of throwing, so
          // the kernel state travels beside the value; the host drops this
          // thread on an unrecovered reload (see kernelHost.ts).
          const fault: KernelFaultState | undefined = kernelReloadRequired()
            ? { name: 'KernelFault', reloaded: false }
            : undefined
          port.postMessage({ kind: 'reply', id: req.id, ok: true, value, ...(fault && { fault }) })
        } catch (e) {
          fail(e)
        }
      },
      fail,
    )
  })
}
