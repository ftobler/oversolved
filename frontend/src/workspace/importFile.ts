import { importBag, readZipBag, stemOf, type ImportBag, type ImportResult } from './import'
import { addStepAssembly, STEP_NO_SOLIDS } from './stepPart'
import { getWorkspaceStore, type WorkspaceStore } from './store'
import { splitStepViaWorker, type StepSplitReply } from '@/kernel/worker/solverClient'
import {
  importsIntoAssembly, isStepFileName, needsSolidSplit, type StepImportMode,
} from './stepImportMode'

// One file the user picked, adopted the way every import is: a zip or an
// `.oversolved` archive unpacks into its entries, anything else is a one-item
// bag the classifier sorts into a document, a STEP plus the part that imports
// it, or a plain file entry. `into` joins an open workspace; without it the
// file becomes a new one.
//
// A STEP picked with an assembly step mode does not go through the bag at all:
// `addStepAssembly` writes the part (or one part per solid) and the assembly
// that holds it, and a fresh workspace is created first so the assembly has
// somewhere to land. A zip always keeps today's adoption, mode A: an archive is
// a workspace restore, not a STEP import.
//
// The picker hands out no handle, so the picked bytes are read once and the
// source is forgotten: the entries are a plain copy and nothing links them back
// to the file.
export interface PickedFileOptions {
  into?: string
  // How a picked STEP file lands. 'part' (the default) is adoption's own pair;
  // the assembly modes go to `addStepAssembly`.
  stepMode?: StepImportMode
}

export async function importPickedFile(
  file: File,
  opts: PickedFileOptions = {},
  store: WorkspaceStore = getWorkspaceStore(),
): Promise<ImportResult> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const isArchive = /\.(zip|oversolved)$/i.test(file.name)
  const stepMode = opts.stepMode ?? 'part'
  if (!isArchive && importsIntoAssembly(stepMode) && isStepFileName(file.name)) {
    return importStepAssembly(file.name, bytes, stepMode, opts.into, store)
  }
  const bag: ImportBag = isArchive
    ? await readZipBag(bytes)
    : { items: [{ path: file.name, bytes }] }
  return importBag(bag, opts.into !== undefined ? { into: opts.into } : {}, store)
}

// A STEP's assembly landing. The split runs before the workspace is created, so
// a file with nothing to split is refused without leaving an empty workspace
// behind; the workspace purge in the catch is the same best-effort cleanup
// adoption's create path does.
async function importStepAssembly(
  fileName: string,
  bytes: Uint8Array,
  mode: StepImportMode,
  into: string | undefined,
  store: WorkspaceStore,
): Promise<ImportResult> {
  const split = needsSolidSplit(mode) ? await splitStepForImport(bytes) : null
  if (split !== null && split.solids.length === 0) throw new Error(STEP_NO_SOLIDS)
  const created = into === undefined
  const workspace = into ?? (await store.create(stemOf(fileName), { docKind: 'assembly' })).workspace
  try {
    const imported = await addStepAssembly(workspace, bytes, {
      fileName,
      mode: split === null ? 'assembly_one_part' : 'assembly_split',
      ...(split !== null && { solids: split.solids.map(solid => solid.bytes) }),
      // A fresh workspace's seed document becomes the assembly, so the
      // workspace holds one assembly rather than an empty row beside it.
      ...(created && { assemblyId: workspace }),
    }, store)
    return {
      workspace,
      mode: created ? 'new' : 'join',
      documents: imported.parts.length + 1,
      files: imported.fileIds.length,
      synthesizedParts: imported.parts.length,
      skippedReserved: 0,
      unattached: [],
      unknownFiles: [],
      missingPayloads: [],
      step: {
        assemblyId: imported.assemblyId,
        partIds: imported.parts.map(part => part.id),
        fileIds: imported.fileIds,
        leftovers: split?.leftovers ?? 0,
      },
    }
  } catch (e) {
    if (created) await store.purge(workspace).catch(() => {})
    throw e
  }
}

// Splitting needs the kernel. A missing Worker is not a fallback to mode A: the
// user picked per-solid parts, and a silent one-part import would be a
// different document than the one they asked for.
async function splitStepForImport(bytes: Uint8Array): Promise<StepSplitReply> {
  const split = await splitStepViaWorker(bytes)
  if (split === null) {
    throw new Error('STEP splitting needs the local kernel; reload the page and try again')
  }
  return split
}
