import { useState } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { executeCommand } from '@/utils/core/commandRegistry'
import ToolbarButton from '@/components/Toolbar/ToolbarButton'
import toolbarNgonIcon from '@/assets/icons/toolbar-ngon.svg'

export default function NgonTool() {
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const ngonSides = useSketchEditorStore(s => s.ngonSides)
  const setNgonSides = useSketchEditorStore(s => s.setNgonSides)
  const isActive = activeTool === 'ngon'
  // Raw text while the field owns the cursor. Committing every keystroke
  // round-trips through the store clamp, so typing "12" collapses to 3 then
  // jumps to 32 and values like 10 are unreachable by keyboard. The draft is
  // display-only: the store (and with it the live preview) only ever sees
  // committed, clamped values.
  const [draft, setDraft] = useState<string | null>(null)

  function commit(text: string) {
    setNgonSides(parseInt(text, 10))
    setDraft(null)
  }

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
          value={draft ?? ngonSides}
          title="Number of sides"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(e.currentTarget.value) }}
          onPointerDown={(e) => e.stopPropagation()}
          style={{ width: 40, height: 24, marginLeft: 2, textAlign: 'center' }}
        />
      )}
    </>
  )
}
