import { useMemo } from 'react'
import { buildCommandEntries, type ShowMessagePayload } from '@/pages/commandEntries'
import { useCommandRegistration } from '@/pages/hooks/useCommandRegistration'
import { executeCommand } from '@/utils/core/commandRegistry'

export function usePartCommands(
  handleUndo: () => void,
  handleRedo: () => void,
  handleDeleteSelectedFeatures: () => void,
  handleToggleSketchPlaneVisibility: () => void,
  handleTogglePlaneVisibility: () => void,
  handleAddFeature: (kind: string, extra?: Record<string, unknown>) => void,
  showMessage: (payload: ShowMessagePayload) => void,
) {
  const commands = useMemo(
    () => buildCommandEntries(handleUndo, handleRedo, handleDeleteSelectedFeatures, handleToggleSketchPlaneVisibility, handleTogglePlaneVisibility,
      () => handleAddFeature('extrude', { sketchQuery: '', distance: 10 }),
      () => handleAddFeature('hole'),
      () => handleAddFeature('transform'),
      showMessage,
    ),
    [handleUndo, handleRedo, handleDeleteSelectedFeatures, handleToggleSketchPlaneVisibility, handleTogglePlaneVisibility, handleAddFeature, showMessage],
  )
  useCommandRegistration(commands)
  return { executeCommand }
}
