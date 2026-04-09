import {
  DragTool,
  ResetViewportTool,
  DimensionTool,
  EntityTools,
  RectangleTool,
  CenterRectangleTool,
  ConstructionToggleTool,
  ConstraintTools,
} from './tools'

interface SketchToolbarProps {
  onResetViewport: () => void
}

export default function SketchToolbar({ onResetViewport }: SketchToolbarProps) {
  return (
    <>
      <DragTool />

      <ResetViewportTool onResetViewport={onResetViewport} />

      <div className="toolbar-separator" />

      <DimensionTool />

      {/* Drawing tools — derived from entity registry */}
      <EntityTools />

      {/* Rectangle is a composite tool, not a single entity */}
      <RectangleTool />
      <CenterRectangleTool />

      <ConstructionToggleTool />

      <div className="toolbar-separator" />

      {/* Constraint buttons — derived from constraint registry */}
      <ConstraintTools />
    </>
  )
}
