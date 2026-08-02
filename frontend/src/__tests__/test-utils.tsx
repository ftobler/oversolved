// This module exports one component (`Wrapper`) alongside plain helpers, which
// the Fast Refresh rule forbids. It is test-only and never enters the HMR graph,
// so the rule has nothing to protect here; splitting it would only cost every
// call site a second import.
/* eslint-disable react-refresh/only-export-components */
/**
 * Shared test scaffolding for the React-level suites.
 *
 * Every block below used to be copy-pasted per test file (727 duplicated lines
 * across the 12 `Part.*.test.tsx` files), so a change to a mocked module's shape
 * meant twelve edits and, in practice, twelve slightly diverging copies.
 *
 * Note the calling convention for the `*MockModule` helpers: they RETURN a
 * module shape instead of calling `vi.mock` themselves. `vi.mock` is hoisted
 * above the imports by vitest's transform, so a helper invoked from the test
 * file's body would register its mock after the module under test was already
 * imported. Call them from inside an async factory instead, which vitest only
 * runs when the mocked module is first imported:
 *
 *   vi.mock('@/components/Viewport', async () =>
 *     (await import('@/__tests__/test-utils')).viewportMockModule())
 *
 * The plain helpers (`Wrapper`, `partDocFetchMock`) have no such constraint and
 * are imported normally.
 *
 * Because of that, a `vi.mock` factory reaching in here pulls this module's own
 * imports (MUI, ToastContext) into the graph before the module under test has
 * finished loading. Fine today; the day a suite needs to mock ToastContext, the
 * factories below have to move to a leaf file of their own.
 */
import React, { forwardRef, useImperativeHandle, type ReactNode } from 'react'
import { vi } from 'vitest'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import { ToastProvider } from '@/contexts/ToastContext'

const theme = createTheme()

/** The provider stack a page gets under `main.tsx`, minus the router. */
export function Wrapper({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ToastProvider>{children}</ToastProvider>
    </ThemeProvider>
  )
}

/** An empty part, the content most Part page tests load. */
const EMPTY_PART_YAML = 'version: 1\nkind: part\nfeatures: []\n'

interface PartDocFetchOptions {
  // Raw YAML served as the document body.
  content?: string
  permission?: string
  name?: string
}

/**
 * A `fetch` stub for the Part page's two boot requests: the session probe and
 * the document itself. Anything else 404s, which is what keeps a test honest
 * about which endpoints the page really touches.
 *
 * Use with `vi.stubGlobal('fetch', partDocFetchMock({ content: DOC }))`.
 */
export function partDocFetchMock({
  content = EMPTY_PART_YAML,
  permission = 'owner',
  name = 'TestDoc',
}: PartDocFetchOptions = {}) {
  return vi.fn((url: string) => {
    if (url === '/api/auth/me') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ user: { id: 1, username: 'admin', must_change_password: false } }),
      } as Response)
    }
    if (url === '/api/documents/doc-1') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ uuid: 'doc-1', name, content, permission }),
      } as Response)
    }
    return Promise.resolve({ ok: false, status: 404 } as Response)
  })
}

/**
 * Module shape for `vi.mock('.../components/Viewport', ...)`: a component that
 * renders nothing but still answers the imperative handle the Part page drives
 * the camera through. Pass `handle` to swap in a spy the test can assert on;
 * keys absent from the default set (e.g. `cancelPendingFit`) only exist on the
 * mock when a test asks for them, so a page calling one unguarded stays visible
 * as a failure.
 */
export function viewportMockModule(handle: Record<string, unknown> = {}) {
  return {
    __esModule: true,
    default: forwardRef(function MockViewport(_props: Record<string, unknown>, ref: React.Ref<unknown>) {
      useImperativeHandle(ref, () => ({
        autoZoomToFit: vi.fn(),
        captureScreenshot: vi.fn(),
        captureScreenshotForSaving: vi.fn(),
        alignCameraToPlane: vi.fn(),
        alignCameraToFace: vi.fn(),
        ...handle,
      }))
      return null
    }),
  }
}

/** Module shape for `vi.mock('.../contexts/AuthContext', ...)`: signed in, not admin. */
export function authMockModule(user: Record<string, unknown> = { is_admin: false }) {
  return {
    useAuth: () => ({
      user,
      isAuthenticated: true,
      login: vi.fn(),
      logout: vi.fn(),
    }),
  }
}

/**
 * Module shape for `vi.mock('.../hooks/usePartDoc', ...)`. UNLIKE
 * `viewportMockModule`, this one stubs EVERY field of the hook's return rather
 * than only what a test asks for: the Part page reads all of them on mount, so a
 * missing key is a crash, not a visible gap. `overrides` replaces the few a given
 * test actually drives (a doc, a spy it asserts on).
 *
 * `doc` is rebuilt per hook call, matching the object literal each inline copy
 * used to return. An override, by contrast, is shared by identity across renders
 * AND across `it()` blocks, so a test must never mutate one in place.
 *
 * The builtins come from the real module, so a mocked Part page cannot silently
 * disagree with production about what a fresh document starts with.
 */
export async function partDocMockModule(overrides: Record<string, unknown> = {}) {
  const { BUILTIN_FEATURE_DEFAULTS, BUILTIN_FEATURE_IDS } = await import('@/utils/builtins')
  const emptyDoc = () => ({ version: 1, kind: 'part', features: [], part_style: {} })
  return {
    BUILTIN_FEATURE_DEFAULTS,
    BUILTIN_FEATURE_IDS,
    usePartDoc: () => ({
      doc: emptyDoc(),
      setDoc: vi.fn(),
      docRef: { current: emptyDoc() },
      loading: false,
      error: null,
      setError: vi.fn(),
      solveResults: {},
      bodies: {},
      pickBodies: {},
      solving: false,
      solveTime: null,
      solveError: null,
      setSolveError: vi.fn(),
      solveResult: '',
      undoStack: [],
      redoStack: [],
      reSolve: vi.fn(),
      handleMutation: vi.fn(),
      handleUndo: vi.fn(),
      handleRedo: vi.fn(),
      saveDoc: vi.fn(),
      renameDoc: vi.fn(),
      cloneDoc: vi.fn(),
      docName: 'Test Doc',
      ownerUsername: 'user',
      permission: 'owner',
      setPickBoundary: vi.fn(),
      setRollbackPos: vi.fn(),
      startPreviewMode: vi.fn(),
      commitPreview: vi.fn(),
      cancelPreview: vi.fn(),
      registerUndoTeardown: vi.fn(),
      ...overrides,
    }),
  }
}

/**
 * Module shape for `vi.mock('.../components/layout/Sidebar', ...)`: one row per
 * body with a button that fires the page's body context menu, which is the only
 * part of the real sidebar these tests reach through.
 */
export async function sidebarMockModule() {
  const { usePartEditorStore } = await import('@/stores/partEditorStore')
  const { usePartEditorCallbacks } = await import('@/contexts/PartEditorContext')
  return {
    Sidebar: vi.fn(() => {
      const bodies = usePartEditorStore(s => s.bodies)
      const { onRightClick } = usePartEditorCallbacks()
      return (
        <div data-testid="sidebar">
          {Object.keys(bodies || {}).map((bodyId: string) => (
            <div key={bodyId} data-testid={`body-${bodyId}`}>
              <button
                data-testid={`context-btn-${bodyId}`}
                onClick={(e: React.MouseEvent) => onRightClick([e.clientX, e.clientY], `body:${bodyId}`)}
              >
                Context
              </button>
            </div>
          ))}
        </div>
      )
    }),
  }
}

interface MenuItem {
  label: string
  onClick: () => void
}

/**
 * Module shape for `vi.mock('.../components/dialogs/RightClickMenu', ...)`: the
 * menu flattened to plain buttons, so a test clicks an item by index instead of
 * driving a portal-hosted MUI menu.
 */
export function rightClickMenuMockModule() {
  return {
    default: vi.fn(({ items }: { items: MenuItem[] }) => (
      <div data-testid="context-menu">
        {items.map((item: MenuItem, i: number) => (
          <button key={i} data-testid={`menu-item-${i}`} onClick={() => item.onClick()}>
            {item.label}
          </button>
        ))}
      </div>
    )),
  }
}
