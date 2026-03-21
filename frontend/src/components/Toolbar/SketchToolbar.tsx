import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import ToolbarButton from './ToolbarButton'

import toolbarLineIcon from '../../assets/icons/toolbar-line.svg'
import toolbarRectangleIcon from '../../assets/icons/toolbar-rectangle.svg'
import toolbarCircleIcon from '../../assets/icons/toolbar-circle.svg'
import toolbarArcIcon from '../../assets/icons/toolbar-arc.svg'
import toolbarPointIcon from '../../assets/icons/toolbar-point.svg'
import toolbarHorizontalIcon from '../../assets/icons/constraint-horizontal.svg'
import toolbarVerticalIcon from '../../assets/icons/constraint-vertical.svg'
import toolbarCoincidentIcon from '../../assets/icons/constraint-coincident.svg'
import toolbarConcentricIcon from '../../assets/icons/constraint-concentric.svg'
import toolbarEqualIcon from '../../assets/icons/constraint-equal.svg'
import toolbarFixedIcon from '../../assets/icons/constraint-fixed.svg'
import toolbarMidpointIcon from '../../assets/icons/constraint-midpoint.svg'
import toolbarNormalIcon from '../../assets/icons/constraint-normal.svg'
import toolbarParallelIcon from '../../assets/icons/constraint-parallel.svg'
import toolbarPerpendicularIcon from '../../assets/icons/constraint-square.svg'
import toolbarTangentIcon from '../../assets/icons/constraint-tangent.svg'
import toolbarCollinearIcon from '../../assets/icons/constraint-colinear.svg'
import toolbarDimensionIcon from '../../assets/icons/constraint-dimension.svg'
import toolbarLineSwapIcon from '../../assets/icons/constraint-line-swap.svg'
import viewportResetIcon from '../../assets/icons/viewport-reset.svg'

interface SketchToolbarProps {
  onResetViewport: () => void
}

export default function SketchToolbar({ onResetViewport }: SketchToolbarProps) {
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const setActiveTool = useSketchEditorStore(s => s.setActiveTool)
  const applyConstraint = useSketchEditorStore(s => s.applyConstraint)

  return (
    <>
      <ToolbarButton title="Reset Viewport" icon={viewportResetIcon} onClick={onResetViewport} />

      <div className="toolbar-separator" />

      <ToolbarButton
        title="Dimension (D)"
        icon={toolbarDimensionIcon}
        onClick={() => setActiveTool('dimension')}
        active={activeTool === 'dimension'}
      />

      <ToolbarButton
        title="Line"
        icon={toolbarLineIcon}
        onClick={() => setActiveTool('line')}
        active={activeTool === 'line'}
      />
      <ToolbarButton
        title="Rectangle"
        icon={toolbarRectangleIcon}
        onClick={() => setActiveTool('rect')}
        active={activeTool === 'rect'}
      />
      <ToolbarButton
        title="Circle"
        icon={toolbarCircleIcon}
        onClick={() => setActiveTool('circle')}
        active={activeTool === 'circle'}
      />
      <ToolbarButton
        title="Arc"
        icon={toolbarArcIcon}
        onClick={() => setActiveTool('arc')}
        active={activeTool === 'arc'}
      />
      <ToolbarButton
        title="Point"
        icon={toolbarPointIcon}
        onClick={() => setActiveTool('point')}
        active={activeTool === 'point'}
      />
      <ToolbarButton title="Line Swap" icon={toolbarLineSwapIcon} onClick={() => applyConstraint('colinear')} />

      <div className="toolbar-separator" />

      <ToolbarButton title="Horizontal (H)" icon={toolbarHorizontalIcon} onClick={() => applyConstraint('horizontal')} />
      <ToolbarButton title="Vertical (V)" icon={toolbarVerticalIcon} onClick={() => applyConstraint('vertical')} />
      <ToolbarButton title="Coincident" icon={toolbarCoincidentIcon} onClick={() => applyConstraint('coincident')} />
      <ToolbarButton title="Concentric" icon={toolbarConcentricIcon} onClick={() => applyConstraint('concentric')} />
      <ToolbarButton title="Equal" icon={toolbarEqualIcon} onClick={() => applyConstraint('equal_length')} />
      <ToolbarButton title="Fixed" icon={toolbarFixedIcon} onClick={() => applyConstraint('fixed')} />
      <ToolbarButton title="Midpoint" icon={toolbarMidpointIcon} onClick={() => applyConstraint('midpoint')} />
      <ToolbarButton title="Normal" icon={toolbarNormalIcon} onClick={() => applyConstraint('normal')} />
      <ToolbarButton title="Parallel" icon={toolbarParallelIcon} onClick={() => applyConstraint('parallel')} />
      <ToolbarButton title="Perpendicular" icon={toolbarPerpendicularIcon} onClick={() => applyConstraint('perpendicular')} />
      <ToolbarButton title="Tangent" icon={toolbarTangentIcon} onClick={() => applyConstraint('tangent')} />
      <ToolbarButton title="Collinear" icon={toolbarCollinearIcon} onClick={() => applyConstraint('collinear')} />
    </>
  )
}
