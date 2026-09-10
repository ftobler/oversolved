// The closed set of assembly undo step labels. Centralised so a new mutation
// path cannot ship a hand-written label: the funnels type their label parameter
// as AssemblyUndoLabel, so a literal outside this map fails tsc, and
// assemblyUndoLabels.test.ts pins the map against an explicit list.
export const ASSEMBLY_UNDO_LABELS = {
  addMate: 'Add mate',
  addPart: 'Add part',
  duplicatePart: 'Duplicate part',
  deletePart: 'Delete part',
  toggleVisibility: 'Toggle visibility',
  togglePlaneVisibility: 'Toggle plane visibility',
  fixUnfixPart: 'Fix/unfix part',
  setPosition: 'Set position',
  setRotation: 'Set rotation',
  editMate: 'Edit mate',
  pickMateReference: 'Pick mate reference',
  deleteMate: 'Delete mate',
  reorderPart: 'Reorder part',
  reorderMate: 'Reorder mate',
  renameMate: 'Rename mate',
  movePart: 'Move part',
} as const

export type AssemblyUndoLabel =
  typeof ASSEMBLY_UNDO_LABELS[keyof typeof ASSEMBLY_UNDO_LABELS]
