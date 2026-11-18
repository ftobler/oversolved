// How a picked STEP file should land: the pure decision the import dialog
// hands to the workspace writer. Kept dependency-free so a page, a dialog and a
// workspace function can share the vocabulary without pulling the store in.
//
// A is today's behaviour (one part document holding one body per solid); B1 is
// that same part inside a new assembly; B2 is an assembly with a part document
// per solid. The step that splits the file runs in the kernel, so the mode
// value is all that crosses the seam.

export type StepImportMode = 'part' | 'assembly_one_part' | 'assembly_split'

/** Whether a picked file is a STEP source rather than an archive or a document. */
export function isStepFileName(name: string): boolean {
  return /\.(step|stp)$/i.test(name)
}

/** Whether the mode imports into an assembly rather than one bare part. */
export function importsIntoAssembly(mode: StepImportMode): boolean {
  return mode !== 'part'
}

/** Whether the mode needs the kernel to split the file into per-solid STEP files. */
export function needsSolidSplit(mode: StepImportMode): boolean {
  return mode === 'assembly_split'
}
