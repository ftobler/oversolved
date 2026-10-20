import { useCallback, useEffect } from 'react'
import { usePickField } from '@/hooks/usePickField'
import { livePickContext, reportPick, useBugReportStore } from '@/stores/bugReportStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

/**
 * One selection set's pick chip. It is a plain pick-field consumer with a
 * non-feature id (`bug-report:<setId>`): no `features` means no build-order
 * rule, and no `validatePick` means any query is reportable, including sketch
 * entities and bodies.
 *
 * The pick snapshot is taken here, at the instant the click arrives, rather
 * than derived from whatever the bar shows later. That is what makes the picks
 * rollback-independent: moving the bar cannot invalidate a record it did not
 * produce.
 */
export function useBugReportPick(setId: string) {
  const addPick = useBugReportStore(s => s.addPick)
  const removePick = useBugReportStore(s => s.removePick)
  const featureId = `bug-report:${setId}`

  const onPick = useCallback((query: string) => {
    addPick(setId, reportPick(query, livePickContext()))
  }, [addPick, setId])

  const onUnpick = useCallback((query: string) => {
    removePick(setId, query)
  }, [removePick, setId])

  // A set row can vanish while its chip is armed: the panel closes, the set is
  // removed, or a part/page switch unmounts the editor. The store-owned field
  // would otherwise stay armed, and later clicks would pile into
  // normalSelection for a pick nobody is showing any more. Disarm only our own
  // field, so an unrelated chip armed at the same moment is left alone.
  useEffect(() => () => {
    const store = useSketchEditorStore.getState()
    const active = store.activePickField
    if (active?.featureId === featureId && active.field === 'picks') {
      store.setActivePickField(null)
    }
  }, [featureId])

  return usePickField(featureId, 'picks', onPick, {
    multi: true,
    onUnpick,
  })
}
