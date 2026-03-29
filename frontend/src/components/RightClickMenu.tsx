import { useEffect, useRef } from 'react'
import { useSketchEditorStore } from '../stores/sketchEditorStore'
import './RightClickMenu.css'

export default function RightClickMenu() {
  const contextMenu = useSketchEditorStore(s => s.contextMenu)
  const closeContextMenu = useSketchEditorStore(s => s.closeContextMenu)
  const onRebuild = useSketchEditorStore(s => s.onRebuild)
  const onExitSketch = useSketchEditorStore(s => s.onExitSketch)
  const activeFeatureId = useSketchEditorStore(s => s.activeFeatureId)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!contextMenu) return
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeContextMenu()
      }
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [contextMenu, closeContextMenu])

  if (!contextMenu) return null

  const [x, y] = contextMenu
  const inSketch = activeFeatureId !== null

  const handleRebuild = () => {
    onRebuild?.()
    closeContextMenu()
  }

  const handleExitSketch = () => {
    onExitSketch?.()
    closeContextMenu()
  }

  return (
    <div
      ref={menuRef}
      className="right-click-menu"
      style={{ left: x, top: y }}
      onMouseDown={e => e.stopPropagation()}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      <div className="right-click-menu-item" onClick={handleRebuild}>
        Rebuild
      </div>
      {inSketch && (
        <div className="right-click-menu-item right-click-menu-item--exit" onClick={handleExitSketch}>
          Exit Sketch
        </div>
      )}
    </div>
  )
}
