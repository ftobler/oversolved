// The value-dialog front ends for the part commands. They are UI only: the
// command bodies take the parsed number as data, so a headless caller never
// needs the dialog. They read the sketch UI store directly because opening a
// dialog is UI state, not a document mutation.
import { useSketchUiStore } from '@/stores/sketchEditorStore'
import { refusalText } from '@/utils/core/statusMark'
import { cannotEvaluate } from '@/utils/core/valueRules'
import { parsePatternInput } from '@/session/partCommandSpecs'

function dialogPoint(): [number, number] {
  const cx = typeof window !== 'undefined' ? window.innerWidth / 2 : 200
  const cy = typeof window !== 'undefined' ? window.innerHeight / 2 : 200
  return [cx, cy]
}

// The value-dialog front end for fillet_corners. Programmatic callers pass the
// parsed radius straight to execute; the toolbar button takes this path.
export function openFilletDialog(onRadius: (radius: number) => void): void {
  const st = useSketchUiStore.getState()
  st.openDialog({
    position: dialogPoint(),
    label: 'Fillet radius',
    defaultValue: '5',
    quantity: 'length',
    validate: (input) => refusalText('Value', isNaN(parseFloat(input)) ? cannotEvaluate(input) : null),
    onConfirm: (input) => {
      onRadius(parseFloat(input))
      st.closeDialog()
    },
    onCancel: () => st.closeDialog(),
  })
}

// The value-dialog front end for pattern_entities, like openOffsetDialog.
export function openPatternDialog(onValues: (count: number, pitch: number) => void): void {
  const st = useSketchUiStore.getState()
  st.openDialog({
    position: dialogPoint(),
    label: 'Pattern count and pitch along X',
    defaultValue: '3 10',
    validate: (input) => {
      const parsed = parsePatternInput(input)
      return refusalText('Value', 'reason' in parsed ? parsed.reason : null)
    },
    onConfirm: (input) => {
      const parsed = parsePatternInput(input)
      if ('reason' in parsed) return
      onValues(parsed.count, parsed.pitch)
      st.closeDialog()
    },
    onCancel: () => st.closeDialog(),
  })
}

// The value-dialog front end for apply_offset. Programmatic callers pass the
// parsed distance straight to execute; this is the path the toolbar button
// takes, so the user experience is unchanged.
export function openOffsetDialog(onDistance: (distance: number) => void): void {
  const st = useSketchUiStore.getState()
  st.openDialog({
    position: dialogPoint(),
    label: 'Offset distance',
    defaultValue: '5',
    quantity: 'length',
    validate: (input) => refusalText('Value', isNaN(parseFloat(input)) ? cannotEvaluate(input) : null),
    onConfirm: (input) => {
      onDistance(parseFloat(input))
      st.closeDialog()
    },
    onCancel: () => st.closeDialog(),
  })
}
