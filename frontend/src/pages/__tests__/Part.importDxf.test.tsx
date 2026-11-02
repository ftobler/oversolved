// The sketch toolbar's DXF import at the page seam: the picker reads the file,
// the page parses it before dispatch so a refusal names the cause, and a good
// file lands as one import_dxf mutation against the open sketch. The undo
// contract itself is pinned in utils/__tests__/dxfImportMutation.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { Wrapper } from '@/__tests__/test-utils'
import { usePartEditorStore, DEFAULT_PART_EDITOR_DATA } from '@/stores/partEditorStore'
import { useSketchUiStore } from '@/stores/sketchEditorStore'
import { useDevSettingsStore } from '@/stores/devSettingsStore'
import { useEditorState } from '@/hooks/useEditorState'
import { MAX_DXF_IMPORT_BYTES } from '@/utils/dxfImport'
import type { PartDoc } from '@/types/cad'

const F = vi.hoisted(() => {
  const doc: PartDoc = {
    version: 1,
    kind: 'part',
    features: [
      { id: 'Origin', kind: 'origin' },
      { id: 'Front', kind: 'plane' },
      { id: 'sketch1', kind: 'sketch', label: 'Sketch 1', plane: '@builtin_plane_front', auto_hidden: true },
    ],
  }
  return { doc, bodies: {}, solve: { sketch1: { solved: {} } } }
})

const h = vi.hoisted(() => ({
  requestSolve: vi.fn(),
  handleMutation: vi.fn(),
  saveDoc: vi.fn(async () => true),
  renameDoc: vi.fn(async () => true),
  setError: vi.fn(),
  startPreviewMode: vi.fn(),
  commitPreview: vi.fn(),
  cancelPreview: vi.fn(),
}))

vi.mock('@/hooks/usePartDoc', async () =>
  (await import('@/__tests__/test-utils')).partDocMockModule({
    doc: F.doc,
    docRef: { current: F.doc },
    bodies: F.bodies,
    solveResults: F.solve,
    requestSolve: h.requestSolve,
    handleMutation: h.handleMutation,
    saveDoc: h.saveDoc,
    renameDoc: h.renameDoc,
    setError: h.setError,
    startPreviewMode: h.startPreviewMode,
    commitPreview: h.commitPreview,
    cancelPreview: h.cancelPreview,
    docName: 'Bracket',
  }))

vi.mock('@/components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule())
vi.mock('@/components/layout/PartDocumentPanel', () => ({ PartDocumentPanel: () => null }))
vi.mock('@/components/layout/MeasurementDisplay', () => ({ default: () => null }))
vi.mock('@/components/dialogs/LoadingOverlay', () => ({ default: () => null }))
vi.mock('@/components/dialogs/RightClickMenu', async () =>
  (await import('@/__tests__/test-utils')).rightClickMenuMockModule())
vi.mock('@/hooks/useWorkspaceName', () => ({ useWorkspaceName: () => 'WS' }))
vi.mock('@/pages/PartExportImport', async () => {
  const React = await import('react')
  return {
    __esModule: true,
    default: React.forwardRef(function PartExportImportMock(_props: unknown, ref: import('react').Ref<unknown>) {
      React.useImperativeHandle(ref, () => ({ openExport: vi.fn() }))
      return null
    }),
  }
})

const DXF = '0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n0\n20\n0\n11\n10\n21\n0\n0\nENDSEC\n0\nEOF\n'

function renderPart() {
  return render(
    <MemoryRouter initialEntries={['/workspaces/ws-1/entries/doc-1']}>
      <Routes>
        <Route path="/workspaces/:workspaceId/entries/:entryId" element={<Part />} />
      </Routes>
    </MemoryRouter>,
    { wrapper: Wrapper },
  )
}

async function pickDxf(file: { name: string; size: number; text: () => Promise<string> }) {
  const created: HTMLInputElement[] = []
  const make = document.createElement.bind(document)
  const createSpy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string, opts?: ElementCreationOptions) => {
    const el = make(tag as never, opts)
    if (tag === 'input') created.push(el as HTMLInputElement)
    return el
  }) as typeof document.createElement)
  const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})

  fireEvent.click(screen.getByTitle('Import DXF into this sketch'))

  const input = created[0]
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => { await input.onchange?.(new Event('change')) })

  createSpy.mockRestore()
  clickSpy.mockRestore()
}

describe('Part DXF import', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    usePartEditorStore.setState({
      ...DEFAULT_PART_EDITOR_DATA,
      features: F.doc.features,
      doc: F.doc,
      bodies: F.bodies,
      solveResults: F.solve,
    })
    useEditorState.setState({
      editingFeatureId: 'sketch1',
      rollbackPosition: null,
      pickBoundary: null,
      normalSelection: new Set(),
      hoveredSelectionId: null,
      hoveredVertexId: null,
      hoveredFaceNormal: null,
      hoveredFaceCenter: null,
      activeTool: null,
      activePickField: null,
      modeStack: [],
    })
    useSketchUiStore.setState({ showConstraintTiles: false })
    useDevSettingsStore.setState({ validateOnRebuild: false })
  })

  it('reads the picked file and dispatches one import_dxf against the open sketch', async () => {
    renderPart()
    await pickDxf({ name: 'bracket.dxf', size: DXF.length, text: async () => DXF })

    expect(h.handleMutation).toHaveBeenCalledTimes(1)
    expect(h.handleMutation).toHaveBeenCalledWith({ type: 'import_dxf', featureId: 'sketch1', content: DXF })
    expect(h.setError).not.toHaveBeenCalledWith(expect.stringContaining('Failed'))
  })

  it('reports a malformed file and dispatches nothing', async () => {
    renderPart()
    await pickDxf({ name: 'broken.dxf', size: 12, text: async () => 'not a dxf file' })

    expect(h.setError).toHaveBeenCalledWith(expect.stringContaining('malformed DXF'))
    expect(h.handleMutation).not.toHaveBeenCalled()
  })

  it('rejects an oversize file before reading it', async () => {
    renderPart()
    const text = vi.fn(async () => DXF)
    await pickDxf({ name: 'huge.dxf', size: MAX_DXF_IMPORT_BYTES + 1, text })

    expect(h.setError).toHaveBeenCalledWith(expect.stringContaining('too large'))
    expect(text).not.toHaveBeenCalled()
    expect(h.handleMutation).not.toHaveBeenCalled()
  })

  it('reports an unreadable file rather than importing it', async () => {
    renderPart()
    await pickDxf({ name: 'broken.dxf', size: 12, text: async () => { throw new Error('io') } })

    expect(h.setError).toHaveBeenCalledWith('Failed to read DXF file')
    expect(h.handleMutation).not.toHaveBeenCalled()
  })

  it('refuses when the open sketch changed while the picker was open', async () => {
    renderPart()
    await pickDxf({
      name: 'bracket.dxf',
      size: DXF.length,
      text: async () => {
        useEditorState.setState({ editingFeatureId: null })
        return DXF
      },
    })

    expect(h.setError).toHaveBeenCalledWith('The open sketch changed; import the DXF again')
    expect(h.handleMutation).not.toHaveBeenCalled()
  })
})
