import { FeatureTree } from '@/components/layout/FeatureTree'
import { BodyPartsList } from '@/components/layout/BodyPartsList'
import { useSplitDrag } from '@/hooks/useSplitDrag'

// The part editor's own navigator: FeatureTree over BodyPartsList, with the
// drag splitter it always had. The wrapper is the flex column that used to be
// the aside, so the percentage-height bands and the splitter rect resolve
// exactly as before; extracting it lets Sidebar host both this stack and the
// assembly tree without either knowing about the other.
export function PartDocumentPanel() {
  const { splitPercent, containerRef, handleMouseDown, handleKeyDown, min, max } = useSplitDrag()

  return (
    <div className="document-panel" ref={containerRef}>
      <FeatureTree splitPercent={splitPercent} />
      <div
        className="resize-handle"
        onMouseDown={handleMouseDown}
        onKeyDown={handleKeyDown}
        title="Drag to resize"
        role="slider"
        tabIndex={0}
        aria-label="Resize part panes"
        aria-orientation="vertical"
        aria-valuenow={Math.round(splitPercent)}
        aria-valuemin={min}
        aria-valuemax={max}
      />
      <BodyPartsList splitPercent={splitPercent} />
    </div>
  )
}
