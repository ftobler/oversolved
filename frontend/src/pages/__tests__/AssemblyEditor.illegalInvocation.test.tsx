import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { forwardRef, useImperativeHandle, type ReactNode } from 'react'
import { fireEvent, screen, act } from '@testing-library/react'

// Install a receiver-checking structuredClone BEFORE any import evaluates:
// assemblyHistory builds its module-level singleton at import, which is where
// the browser-only "Illegal invocation" originated. When a command later pushes
// an undo entry, the clone must be called free or this throws like Chrome does.
const cloneStub = vi.hoisted(() => {
  const original = globalThis.structuredClone
  globalThis.structuredClone = function (this: unknown, value: unknown, options?: StructuredSerializeOptions) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation')
    return original(value, options)
  } as typeof structuredClone
  return { original }
})

const navigateSpy = vi.fn()
vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/workspaces/ws/entries/asm-1' }),
  useParams: () => ({ workspaceId: 'ws', entryId: 'asm-1' }),
  useNavigate: () => navigateSpy,
  useHref: (to: string) => `/base${to}`,
  Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) =>
    <a href={to} {...props}>{children}</a>,
}))

const h = vi.hoisted(() => ({
  loadContent: 'kind: assembly\nfeatures: []',
  list: [] as Array<{ uuid: string; name: string; kind?: string; meta?: { rev: number } }>,
  save: vi.fn(),
  previewPut: vi.fn(),
  captureScreenshotForSaving: vi.fn(),
  solveAssemblyViaWorker: vi.fn(),
  setRelayHandlers: vi.fn(),
  clearRelayHandlers: vi.fn(),
  buildBundleViaWorker: vi.fn(),
  exportAssemblyViaWorker: vi.fn(),
  downloadBlob: vi.fn(),
  addStepPart: vi.fn(),
  addStepAssembly: vi.fn(),
  splitStepViaWorker: vi.fn(),
}))

vi.mock('@/workspace/stepPart', () => ({
  addStepPart: h.addStepPart,
  addStepAssembly: h.addStepAssembly,
  STEP_NO_SOLIDS: 'no solids',
}))
vi.mock('@/adapters/backend', () => ({
  backendBundle: {
    documents: {
      load: vi.fn(async (id: string) => ({
        content: id === 'asm-1' ? h.loadContent : 'features: []',
        name: 'My Assembly',
      })),
      list: vi.fn(async () => h.list),
      save: h.save,
      thumbnailUrl: () => null,
    },
    cloudDocuments: null,
  },
}))
vi.mock('@/components/Viewport/AssemblyViewport', () => ({
  default: forwardRef((_props, ref) => {
    useImperativeHandle(ref, () => ({ captureScreenshotForSaving: h.captureScreenshotForSaving }))
    return <div data-testid="assembly-viewport" />
  }),
}))
vi.mock('@/kernel/worker/anchorSolverClient', () => ({
  solveAssemblyViaWorker: h.solveAssemblyViaWorker,
  setRelayHandlers: h.setRelayHandlers,
  clearRelayHandlers: h.clearRelayHandlers,
}))
vi.mock('@/kernel/worker/solverClient', () => ({
  buildBundleViaWorker: h.buildBundleViaWorker,
  exportAssemblyViaWorker: h.exportAssemblyViaWorker,
  splitStepViaWorker: h.splitStepViaWorker,
}))
vi.mock('@/utils/core/downloadBlob', () => ({ downloadBlob: h.downloadBlob }))
vi.mock('@/persistence/previewStore', () => ({
  getPreviewStore: () => ({ put: h.previewPut, get: vi.fn(), remove: vi.fn() }),
}))
vi.mock('@/hooks/usePreview', () => ({ usePreview: () => undefined }))

import { setEditorCommandRegistry } from '@/hooks/commandRegistry'
import { CommandRegistry, objectParams, Field } from '@/utils/core/commandSpec'
import { errorResult } from '@/session/result'
import { assemblyContext } from './commandFixtures'
import type { AssemblyCommandContext } from '@/session/assemblyCommandSpecs'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'
import { DEFAULT_SECTION_STATE, useSectionStore } from '@/stores/sectionStore'
import { tick, renderEditor, installSessionFromList, insertPart } from './AssemblyEditor.harness'

function bannerMessage(): string | null {
  return document.querySelector('.error-banner-message')?.textContent ?? null
}

describe('AssemblyEditor with a receiver-checking structuredClone', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.loadContent = 'kind: assembly\nfeatures: []'
    h.list = [{ uuid: 'part-1', name: 'Bracket', kind: 'part', meta: { rev: 5 } }]
    h.solveAssemblyViaWorker.mockResolvedValue({ payload: { transforms: {}, bodies: {} } })
    h.save.mockResolvedValue(undefined)
    h.previewPut.mockResolvedValue(undefined)
    h.captureScreenshotForSaving.mockResolvedValue('data:image/png;base64,QVNN')
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().selectPart(null)
    useAssemblyStore.getState().setActiveMateField(null)
    useAssemblyStore.getState().selectMate(null)
    useAssemblyStore.setState({ editingSubject: { kind: 'none' } })
    useSectionStore.setState({ ...DEFAULT_SECTION_STATE })
    installSessionFromList(h)
  })

  afterAll(() => { globalThis.structuredClone = cloneStub.original })

  async function renderLoaded() {
    renderEditor()
    await tick()
    await tick()
  }

  it('picking a part adds one instance and leaves the error banner empty', async () => {
    await renderLoaded()
    await insertPart('Bracket')

    expect(useAssemblyStore.getState().instances.map(inst => inst.doc_id)).toEqual(['part-1'])
    expect(bannerMessage()).toBeNull()
  })

  it('flips a plane visible from the tree eye without a banner', async () => {
    await renderLoaded()

    fireEvent.click(screen.getByLabelText('Show Top'))
    await tick()

    expect(screen.getByLabelText('Hide Top')).toBeTruthy()
    const top = (useAssemblyStore.getState().doc?.features ?? []).find(f => f.id === 'AssemblyTop')
    expect(top?.visible).toBe(true)
    expect(bannerMessage()).toBeNull()
  })

  // The tree used to discard failed Results, so a refused operation looked dead.
  // The one page-level helper puts the refusal in the banner instead.
  it('shows a refused tree action message in the banner', async () => {
    await renderLoaded()

    const refusing = new CommandRegistry<AssemblyCommandContext>(() => assemblyContext())
    refusing.register({
      id: 'set_builtin_visible',
      label: 'Set builtin visibility',
      params: objectParams({ id: Field.string(), visible: Field.boolean() }),
      enabled: () => true,
      run: () => errorResult('refused', 'Cannot change this reference plane'),
      undoable: true,
    })
    act(() => { setEditorCommandRegistry('assembly', refusing) })

    fireEvent.click(screen.getByLabelText('Show Top'))
    await tick()

    expect(bannerMessage()).toContain('Cannot change this reference plane')
  })
})
