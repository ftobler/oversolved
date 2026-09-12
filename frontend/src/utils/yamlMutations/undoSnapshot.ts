import type { PartDoc } from '@/types/cad'

// A snapshot for the undo stack. The document holds references now, never an
// import payload, so a plain deep clone is the correct and cheap snapshot.
export function cloneDocForUndo(doc: PartDoc): PartDoc {
  return structuredClone(doc)
}
