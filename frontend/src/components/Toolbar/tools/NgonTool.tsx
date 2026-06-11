import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { executeCommand } from '@/stores/commandRegistry'
import ToolbarButton from '@/components/Toolbar/ToolbarButton'
import toolbarNgonIcon from '@/assets/icons/toolbar-ngon.svg'

export default function NgonTool() {
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const ngonSides = useSketchEditorStore(s => s.ngonSides)
  const setNgonSides = useSketchEditorStore(s => s.setNgonSides)
  const isActive = activeTool === 'ngon'

  return (
    <>
      <ToolbarButton
        title={`N-gon, ${ngonSides} sides (regular polygon)`}
        icon={toolbarNgonIcon}
        onClick={() => executeCommand('set_tool_ngon')}
        active={isActive}
      />
      {/* Side-count control: only while the n-gon tool is active. Changing it
          updates the live preview and the next polygon drawn. */}
      {isActive && (
        <input
          type="number"
          min={3}
          max={64}
          value={ngonSides}
          title="Number of sides"
          onChange={(e) => setNgonSides(parseInt(e.target.value, 10))}
          onPointerDown={(e) => e.stopPropagation()}
          style={{ width: 40, height: 24, marginLeft: 2, textAlign: 'center' }}
        />
      )}
    </>
  )
}
