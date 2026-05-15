import { type ReactNode } from 'react'
import Viewport, { type ViewportHandle } from '@/components/Viewport'
import type { Feature, PartFeature, PartStyleEntry, BodyResult, Sketch, Mutation, SketchData } from '@/types/cad'
import SketchToolbar from '@/components/Toolbar/SketchToolbar'
import LoadingOverlay from '@/components/LoadingOverlay'
import PartDebugPanel from '@/pages/PartDebugPanel'
import type { BugReportAttachments } from '@/components/BugReporter'

import featureExtrudeIcon from '@/assets/icons/feature-extrude.svg'
import featureRevolveIcon from '@/assets/icons/feature-revolve.svg'
import featureFilletIcon from '@/assets/icons/feature-fillet.svg'
import featureChamferIcon from '@/assets/icons/feature-chamfer.svg'
import featureBooleanIcon from '@/assets/icons/feature-boolean.svg'
import featureArrayIcon from '@/assets/icons/feature-array.svg'
import featureDeleteBodyIcon from '@/assets/icons/feature-delete-body.svg'
import featureHoleIcon from '@/assets/icons/feature-hole.svg'
import featureTransformIcon from '@/assets/icons/feature-transform.svg'
import featureMirrorIcon from '@/assets/icons/feature-mirror.svg'
import featureSketchIcon from '@/assets/icons/feature-sketch.svg'
import featurePartIcon from '@/assets/icons/feature-part.svg'
import featureCodeIcon from '@/assets/icons/icon-code.svg'
import featureAddPlaneIcon from '@/assets/icons/feature-add-plane.svg'
import toolbarPlayIcon from '@/assets/icons/toolbar-play.svg'
import toolbarCopyCodeIcon from '@/assets/icons/toolbar-copy-code.svg'
import toolbarCopyResultIcon from '@/assets/icons/toolbar-copy-result.svg'
import featureImportIcon from '@/assets/icons/icon-upload.svg'
import featureExportIcon from '@/assets/icons/icon-download.svg'

type UndoEntry = { doc: unknown; mutation: Mutation }

interface PartEditorPanelProps {
  children: ReactNode
  mode: string
  setMode: (newMode: 'sketch' | 'feature' | 'code') => void
  codeText: string
  setCodeText: (v: string) => void
  solving: boolean
  solveTime: number | null
  solveResult: string | null
  handleRun: () => void
  solveError: string | null
  setSolveError: (v: string | null) => void
  error: string | null
  setError: (v: string | null) => void
  readOnly: boolean
  loading: boolean
  planeSelectionFeatureId: string | null
  handleAddFeature: (kind: string, extra?: Record<string, unknown>) => void
  handleAddSketch: () => void
  handleAddPlane: () => void
  handleImportStep: () => void
  handleExportStep: () => void
  setViewportReset: React.Dispatch<React.SetStateAction<number>>
  viewportRef: React.RefObject<ViewportHandle | null>
  features: Feature[]
  featureDefs: PartFeature[] | undefined
  rollbackPosition: number | null
  visibleFeatures: Set<string>
  effectiveVisibleBodies: Set<string> | undefined
  solveResults: Record<string, SketchData> | undefined
  viewportReset: number
  activeSketchFeatureId: string | undefined
  handleRightClick: (pos: [number, number], targetId?: string) => void
  showDebugHit: boolean
  otherSketches: Record<string, Sketch>
  bodies: Record<string, BodyResult>
  pickBodies: Record<string, BodyResult>
  partColors: Record<string, string>
  partStyle: Record<string, PartStyleEntry>
  ghostMode: boolean

  userIsAdmin: boolean
  debugOpen: boolean
  debugTab: 'selection' | 'bug-report' | 'undo-redo' | 'ws'
  setDebugTab: React.Dispatch<React.SetStateAction<'selection' | 'bug-report' | 'undo-redo' | 'ws'>>
  hoveredEntityId: string | null
  hoveredVertexId: string | null
  hoveredPlaneId: string | null
  hoveredSurfaceId: string | null
  hovered3DSurfaceId: string | null
  dynamicSelection: Set<string>
  selection: Set<string>
  bugReportForm: { title: string; description: string }
  setBugReportForm: React.Dispatch<React.SetStateAction<{ title: string; description: string }>>
  bugReporting: boolean
  bugReportError: string | null
  bugReportAttachments: BugReportAttachments
  setBugReportAttachments: React.Dispatch<React.SetStateAction<BugReportAttachments>>
  onSubmitBugReport: () => void
  editingFeatureId: string | null
  undoStack: UndoEntry[]
  redoStack: UndoEntry[]
}

export default function PartEditorPanel({
  children,
  mode, setMode,
  codeText, setCodeText,
  solving, solveTime, solveResult,
  handleRun,
  solveError, setSolveError,
  error, setError,
  readOnly,
  loading,
  planeSelectionFeatureId,
  handleAddFeature,
  handleAddSketch,
  handleAddPlane,
  handleImportStep,
  handleExportStep,
  setViewportReset,
  viewportRef,
  features,
  featureDefs,
  rollbackPosition,
  visibleFeatures,
  effectiveVisibleBodies,
  solveResults,
  viewportReset,
  activeSketchFeatureId,
  handleRightClick,
  showDebugHit,
  otherSketches,
  bodies,
  pickBodies,
  partColors,
  partStyle,
  ghostMode,
  userIsAdmin,
  debugOpen, debugTab, setDebugTab,
  hoveredEntityId, hoveredVertexId, hoveredPlaneId, hoveredSurfaceId, hovered3DSurfaceId,
  dynamicSelection, selection,
  bugReportForm, setBugReportForm, bugReporting, bugReportError,
  bugReportAttachments, setBugReportAttachments, onSubmitBugReport,
  editingFeatureId,
  undoStack, redoStack,
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
            <button className={`mode-btn ${mode === 'code' ? 'active' : ''}`} onClick={() => setMode('code')} title="Code mode">
              <img src={featureCodeIcon} alt="Code" />
            </button>
          </div>
          <div className="toolbar-separator" />
          {mode === 'code' && (
            <>
              <button className="editor-btn" title="Run" onClick={handleRun} disabled={solving}>
                <img src={toolbarPlayIcon} alt="Run" />
              </button>
              {solveTime !== null && <span className="solve-time">{solveTime}ms</span>}
              <div className="toolbar-separator" />
              <button className="editor-btn" title="Copy code" onClick={() => navigator.clipboard.writeText(codeText)}>
                <img src={toolbarCopyCodeIcon} alt="Copy code" />
              </button>
              <button className="editor-btn" title="Copy result" onClick={() => navigator.clipboard.writeText(solveResult ?? '')}>
                <img src={toolbarCopyResultIcon} alt="Copy result" />
              </button>
            </>
          )}
          {mode === 'sketch' && <SketchToolbar onResetViewport={() => setViewportReset(v => v + 1)} />}
          {mode === 'feature' && (
            <>
              <button className="editor-btn" title="Add Extrude (E)" onClick={() => handleAddFeature('extrude', { sketchQuery: '', distance: 10 })} disabled={readOnly}><img src={featureExtrudeIcon} alt="Add Extrude" /></button>

              <button className="editor-btn" title="Add Revolve" onClick={() => handleAddFeature('revolve', { sketchQuery: '', angle: 360 })} disabled={readOnly}><img src={featureRevolveIcon} alt="Add Revolve" /></button>

              <button className="editor-btn" title="Add Fillet" onClick={() => handleAddFeature('fillet')} disabled={readOnly}><img src={featureFilletIcon} alt="Add Fillet" /></button>

              <button className="editor-btn" title="Add Chamfer" onClick={() => handleAddFeature('chamfer')} disabled={readOnly}><img src={featureChamferIcon} alt="Add Chamfer" /></button>

              <button className="editor-btn" title="Add Boolean" onClick={() => handleAddFeature('boolean')} disabled={readOnly}><img src={featureBooleanIcon} alt="Add Boolean" /></button>

              <button className="editor-btn" title="Add Array" onClick={() => handleAddFeature('array')} disabled={readOnly}><img src={featureArrayIcon} alt="Add Array" /></button>

              <button className="editor-btn" title="Delete Body" onClick={() => handleAddFeature('delete_body')} disabled={readOnly}><img src={featureDeleteBodyIcon} alt="Delete Body" /></button>

              <button className="editor-btn" title="Add Hole" onClick={() => handleAddFeature('hole')} disabled={readOnly}><img src={featureHoleIcon} alt="Add Hole" /></button>

              <button className="editor-btn" title="Add Transform" onClick={() => handleAddFeature('transform')} disabled={readOnly}><img src={featureTransformIcon} alt="Add Transform" /></button>
              <button className="editor-btn" title="Add Mirror" onClick={() => handleAddFeature('mirror')} disabled={readOnly}><img src={featureMirrorIcon} alt="Add Mirror" /></button>
              <button className={`editor-btn ${planeSelectionFeatureId ? 'active' : ''}`} title="Sketch" onClick={handleAddSketch} disabled={readOnly}><img src={featureSketchIcon} alt="Sketch" /></button>
              <button className="editor-btn" title="Add plane" onClick={handleAddPlane} disabled={readOnly}><img src={featureAddPlaneIcon} alt="Add plane" /></button>
              <button className="editor-btn" title="Import STEP" onClick={handleImportStep} disabled={readOnly}><img src={featureImportIcon} alt="Import STEP" /></button>
              <button className="editor-btn" title="Export" onClick={handleExportStep}><img src={featureExportIcon} alt="Export" /></button>
            </>
          )}
        </div>

        {solveError && (
          <div className="solve-error-banner">
            Solver error: {solveError}
            <button className="solve-error-dismiss" onClick={() => setSolveError(null)}>×</button>
          </div>
        )}
        {error && (
          <div className="error-banner">
            <p className="error-banner-text">Error loading document: {error}</p>
            <button className="error-banner-dismiss" onClick={() => setError(null)}>×</button>
          </div>
        )}
        {!loading && !error && mode === 'code' && (
          <div className="code-split">
            <textarea className="code-input" value={codeText} onChange={e => setCodeText(e.target.value)} placeholder="Document content..." spellCheck="false" />
            <div className="code-result">
              {solving ? <span className="code-result-status">Solving...</span> : solveResult ? <pre>{solveResult}</pre> : <span className="code-result-status">Press Run to solve</span>}
            </div>
          </div>
        )}
        {mode !== 'code' && (
          <div style={{ position: 'relative', width: '100%', height: '100%' }}>
            <Viewport ref={viewportRef} features={features} featureDefs={featureDefs} rollbackPosition={rollbackPosition ?? undefined} visibleFeatures={visibleFeatures} visibleBodies={effectiveVisibleBodies} solveResults={solveResults} resetTrigger={viewportReset} activeFeatureId={activeSketchFeatureId} onRightClick={(pos) => handleRightClick(pos)} showDebugHit={showDebugHit} otherSketches={otherSketches} bodies={bodies} pickBodies={pickBodies} partColors={partColors} partStyle={partStyle} ghostMode={ghostMode} />
            <LoadingOverlay isDocumentLoading={loading} />
          </div>
        )}
      </div>

      <PartDebugPanel
        debugOpen={debugOpen && userIsAdmin}
        debugTab={debugTab}
        setDebugTab={setDebugTab}
        hoveredEntityId={hoveredEntityId}
        hoveredVertexId={hoveredVertexId}
        hoveredPlaneId={hoveredPlaneId}
        hoveredSurfaceId={hoveredSurfaceId}
        hovered3DSurfaceId={hovered3DSurfaceId}
        dynamicSelection={dynamicSelection}
        selection={selection}
        bugReportForm={bugReportForm}
        setBugReportForm={setBugReportForm}
        bugReporting={bugReporting}
        bugReportError={bugReportError}
        bugReportAttachments={bugReportAttachments}
        setBugReportAttachments={setBugReportAttachments}
        onSubmitBugReport={onSubmitBugReport}
        editingFeatureId={editingFeatureId}
        solveResults={solveResults}
        undoStack={undoStack}
        redoStack={redoStack}
      />
    </div>
  )
}
