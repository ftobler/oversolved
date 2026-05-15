import { useMemo } from 'react'
import { buildCommandEntries } from '@/pages/commandEntries'
import { useCommandRegistration } from '@/pages/hooks/useCommandRegistration'
import { executeCommand } from '@/stores/commandRegistry'

export function usePartCommands(
  handleUndo: () => void,
  handleRedo: () => void,
  handleDeleteSelectedFeatures: () => void,
  handleToggleSketchPlaneVisibility: () => void,
  handleAddFeature: (kind: string, extra?: Record<string, unknown>) => void,
) {
  const commands = useMemo(
    () => buildCommandEntries(handleUndo, handleRedo, handleDeleteSelectedFeatures, handleToggleSketchPlaneVisibility,
      () => handleAddFeature('extrude', { sketchQuery: '', distance: 10 }),
      () => handleAddFeature('hole'),
      () => handleAddFeature('transform'),
    ),
    [handleUndo, handleRedo, handleDeleteSelectedFeatures, handleToggleSketchPlaneVisibility, handleAddFeature],
  )
  useCommandRegistration(commands)
  return { executeCommand }
}
