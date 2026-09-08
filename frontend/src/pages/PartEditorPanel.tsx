import { type ReactNode } from 'react'
import Viewport, { type ViewportHandle } from '@/components/Viewport'
import SketchToolbar from '@/components/Toolbar/SketchToolbar'
import LoadingOverlay from '@/components/dialogs/LoadingOverlay'
import { ErrorBanner } from '@/components/shared/ErrorBanner'

import featureExtrudeIcon from '@/assets/icons/feature-extrude.svg'
import featureRevolveIcon from '@/assets/icons/feature-revolve.svg'
import featureSweepIcon from '@/assets/icons/feature-sweep.svg'
import featureFilletIcon from '@/assets/icons/feature-fillet.svg'
import featureChamferIcon from '@/assets/icons/feature-chamfer.svg'
import featureBooleanIcon from '@/assets/icons/feature-boolean.svg'
import featureArrayIcon from '@/assets/icons/feature-array.svg'
import featureCircularArrayIcon from '@/assets/icons/feature-circular-array.svg'
import featureDeleteBodyIcon from '@/assets/icons/feature-delete-body.svg'
import featureHoleIcon from '@/assets/icons/feature-hole.svg'
import featureTransformIcon from '@/assets/icons/feature-transform.svg'
import featureMirrorIcon from '@/assets/icons/feature-mirror.svg'
import featureVariableIcon from '@/assets/icons/feature-variable.svg'
import featureSketchIcon from '@/assets/icons/feature-sketch.svg'
import featurePartIcon from '@/assets/icons/feature-part.svg'
import featureAddPlaneIcon from '@/assets/icons/feature-add-plane.svg'
import featureImportIcon from '@/assets/icons/icon-upload.svg'
import featureExportIcon from '@/assets/icons/icon-download.svg'

interface PartEditorPanelProps {
  children: ReactNode
  rightPanel?: ReactNode
  mode: 'sketch' | 'feature'
  setMode: (newMode: 'sketch' | 'feature') => void
  solveError: string | null
  setSolveError: (v: string | null) => void
  error: string | null
  setError: (v: string | null) => void
  loading: boolean
  planeSelectionFeatureId: string | null
  handleAddFeature: (kind: string, extra?: Record<string, unknown>) => void
  handleAddSketch: () => void
  handleAddPlane: () => void
  handleImportStep: () => void
  handleExportStep: () => void
  viewportRef: React.RefObject<ViewportHandle | null>
  handleRightClick: (pos: [number, number], targetId?: string) => void
  // Bottom-right in-viewport overlay (the measurement readout).
  viewportHud?: ReactNode
}

export default function PartEditorPanel({
  children,
  rightPanel,
  mode, setMode,
  solveError, setSolveError,
  error, setError,
  loading,
  planeSelectionFeatureId,
  handleAddFeature,
  handleAddSketch,
  handleAddPlane,
  handleImportStep,
  handleExportStep,
  viewportRef,
  handleRightClick,
  viewportHud,
}: PartEditorPanelProps) {
  return (
    <div className="doc-container">
      {children}

      <div className="doc-editor">
        <div className="editor-toolbar">
          <div className="mode-selector">
            <button className={`mode-btn ${mode === 'sketch' ? 'active' : ''}`} onClick={() => setMode('sketch')} title="Sketch mode">
              <img src={featureSketchIcon} alt="Sketch" />
            </button>
            <button className={`mode-btn ${mode === 'feature' ? 'active' : ''}`} onClick={() => setMode('feature')} title="Feature mode">
              <img src={featurePartIcon} alt="Feature" />
            </button>
          </div>
          <div className="toolbar-separator" />
          {mode === 'sketch' && <SketchToolbar onResetViewport={() => viewportRef.current?.autoZoomToFit(true)} />}
          {mode === 'feature' && (
            <>
              <button className={`editor-btn ${planeSelectionFeatureId ? 'active' : ''}`} title="Sketch" onClick={handleAddSketch}><img src={featureSketchIcon} alt="Sketch" /></button>
              <button className="editor-btn" title="Add plane" onClick={handleAddPlane}><img src={featureAddPlaneIcon} alt="Add plane" /></button>

              <div className="toolbar-separator" />

              <button className="editor-btn" title="Add Extrude (E)" onClick={() => handleAddFeature('extrude', { sketchQuery: '', distance: 10 })}><img src={featureExtrudeIcon} alt="Add Extrude" /></button>
              <button className="editor-btn" title="Add Revolve" onClick={() => handleAddFeature('revolve', { sketchQuery: '', angle: 360 })}><img src={featureRevolveIcon} alt="Add Revolve" /></button>
              <button className="editor-btn" title="Add Sweep" onClick={() => handleAddFeature('sweep', { sketchQuery: '', pathQuery: '' })}><img src={featureSweepIcon} alt="Add Sweep" /></button>
              <button className="editor-btn" title="Add Fillet" onClick={() => handleAddFeature('fillet')}><img src={featureFilletIcon} alt="Add Fillet" /></button>
              <button className="editor-btn" title="Add Chamfer" onClick={() => handleAddFeature('chamfer')}><img src={featureChamferIcon} alt="Add Chamfer" /></button>
              <button className="editor-btn" title="Add Hole" onClick={() => handleAddFeature('hole')}><img src={featureHoleIcon} alt="Add Hole" /></button>
              <button className="editor-btn" title="Add Boolean" onClick={() => handleAddFeature('boolean')}><img src={featureBooleanIcon} alt="Add Boolean" /></button>
              <button className="editor-btn" title="Add Transform" onClick={() => handleAddFeature('transform')}><img src={featureTransformIcon} alt="Add Transform" /></button>
              <button className="editor-btn" title="Add Mirror" onClick={() => handleAddFeature('mirror')}><img src={featureMirrorIcon} alt="Add Mirror" /></button>
              <button className="editor-btn" title="Add Array" onClick={() => handleAddFeature('array')}><img src={featureArrayIcon} alt="Add Array" /></button>
              <button className="editor-btn" title="Add Circular Array" onClick={() => handleAddFeature('circular_array')}><img src={featureCircularArrayIcon} alt="Add Circular Array" /></button>
              <button className="editor-btn" title="Delete Body" onClick={() => handleAddFeature('delete_body')}><img src={featureDeleteBodyIcon} alt="Delete Body" /></button>
              <button className="editor-btn" title="Add Variable" onClick={() => handleAddFeature('variable')}><img src={featureVariableIcon} alt="Add Variable" /></button>

              <div className="toolbar-separator" />

              <button className="editor-btn" title="Import STEP" onClick={handleImportStep}><img src={featureImportIcon} alt="Import STEP" /></button>
              <button className="editor-btn" title="Export" onClick={handleExportStep}><img src={featureExportIcon} alt="Export" /></button>
            </>
          )}
        </div>

        {(solveError || error) && (
          <ErrorBanner
            message={solveError ? `Solver error: ${solveError}` : `Error: ${error}`}
            onDismiss={() => { setSolveError(null); setError(null) }}
          />
        )}
        <div style={{ position: 'relative', width: '100%', flex: 1 }}>
          <Viewport ref={viewportRef} onRightClick={(pos) => handleRightClick(pos)} hud={viewportHud} />
          <LoadingOverlay isDocumentLoading={loading} />
        </div>
      </div>
      {rightPanel}
    </div>
  )
}
