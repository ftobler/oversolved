// The viewport's viewer options: how the scene is drawn, not what it contains.
//
// This is browser-local preference, not document state. The document already
// stores what is visible (a feature's `visible` flag); these options are the
// pair of glasses the user looks through, so they carry no undo entry and are
// not written into a document. Persisting through the preferences port keeps
// them synchronous on first paint, the same reason document_sort lives there.
//
// The defaults ARE today's look: shading on, edges on, no analysis material,
// exposure 1. An upgrade must not move anyone's view, which is why the
// normalization below never invents a non-default from a malformed record.
//
// Seeding happens once at boot (`main.tsx` calls `syncViewOptionsFromPreferences`
// before the first render), not as a side effect of importing this module: an
// import-time localStorage read makes every test that stubs the backend bundle
// for an unrelated page pay for a port it did not ask about.
import { create } from 'zustand'
import { backendBundle } from '@/adapters/backend'
import {
  DEFAULT_VIEW_PREFERENCES,
  MAX_BRIGHTNESS,
  MIN_BRIGHTNESS,
  normalizeViewPreferences,
  type CurvatureKind,
  type UserPreferences,
  type ViewPreferences,
} from '@/adapters/preferences'

export interface ViewOptionsState extends ViewPreferences {
  // The ID-buffer debug renderpass. Deliberately NOT persisted: a debug overlay
  // returning after a reload would look like a rendering fault.
  collisionDebug: boolean
  // The auto range the live scene produced, published by the viewport that
  // computed it so the dropdown's legend can name the numbers the bodies are
  // actually painted with. Transient, never persisted.
  curvatureAutoRange: [number, number] | null
  // The stripe count of the zebra material, in whole periods across the
  // reflected view direction. Not a document value either.
  setShading: (on: boolean) => void
  setEdges: (on: boolean) => void
  setBrightness: (value: number) => void
  resetBrightness: () => void
  setZebra: (on: boolean) => void
  setZebraStripes: (value: number) => void
  setCurvature: (on: boolean) => void
  setCurvatureKind: (kind: CurvatureKind) => void
  setCurvatureRange: (range: [number, number] | null) => void
  setCurvatureAutoRange: (range: [number, number] | null) => void
  setCollisionDebug: (on: boolean) => void
  setOrbitAroundCursor: (on: boolean) => void
}

/** The persisted half of the state, as the port stores it. */
export function toViewPreferences(state: ViewPreferences): ViewPreferences {
  return {
    shading: state.shading,
    edges: state.edges,
    brightness: state.brightness,
    zebra: state.zebra,
    zebra_stripes: state.zebra_stripes,
    curvature: state.curvature,
    curvature_kind: state.curvature_kind,
    curvature_range: state.curvature_range,
    orbit_around_cursor: state.orbit_around_cursor,
  }
}

/**
 * A persisted record as the live view options: every field checked on its own,
 * so one stale value cannot reset the others. The cross-field rules are
 * reapplied too -- a hand-edited record claiming both shading and edges off, or
 * both analysis modes on, is normalized to the nearest legal view.
 */
export function viewOptionsFromPreferences(prefs: UserPreferences): ViewPreferences {
  return toViewPreferences(normalizeViewPreferences(prefs.view))
}

function persist(get: () => ViewOptionsState): void {
  const state = get()
  const next: UserPreferences = {
    ...backendBundle.preferences.read(),
    view: toViewPreferences(state),
  }
  // Best-effort, like the sort preference: the value already changed in memory
  // and this session keeps it. A rejected write must not become an unhandled
  // rejection either, hence the explicit catch.
  void backendBundle.preferences.save(next, 'view', next.view).catch(() => {})
}

/**
 * Clamp the two layers apart. The last one on cannot be turned off: with both
 * off the viewport would draw no solid at all, which reads as a broken scene
 * rather than a chosen wireframe. Callers that ask for the illegal pair get the
 * other layer kept on.
 */
export function normalizeLayers(shading: boolean, edges: boolean): { shading: boolean; edges: boolean } {
  if (shading || edges) return { shading, edges }
  return { shading: false, edges: true }
}

/**
 * `zebra` and `curvature` replace the same body material, so one owns it at a
 * time. `prefer` names the one the caller just turned on.
 */
export function normalizeAnalysis(
  zebra: boolean,
  curvature: boolean,
  prefer: 'zebra' | 'curvature',
): { zebra: boolean; curvature: boolean } {
  if (!zebra || !curvature) return { zebra, curvature }
  return prefer === 'curvature' ? { zebra: false, curvature: true } : { zebra: true, curvature: false }
}

export const useViewOptionsStore = create<ViewOptionsState>((set, get) => {
  return {
    ...DEFAULT_VIEW_PREFERENCES,
    collisionDebug: false,
    curvatureAutoRange: null,

    setShading: (on) => {
      const layers = normalizeLayers(on, get().edges)
      // An analysis material needs faces to paint on.
      const analysis = layers.shading ? { zebra: get().zebra, curvature: get().curvature } : { zebra: false, curvature: false }
      set({ ...layers, ...analysis })
      persist(get)
    },

    setEdges: (on) => {
      set(normalizeLayers(get().shading, on))
      persist(get)
    },

    setBrightness: (value) => {
      const next = Number.isFinite(value) ? Math.min(MAX_BRIGHTNESS, Math.max(MIN_BRIGHTNESS, value)) : 1
      set({ brightness: next })
      persist(get)
    },

    resetBrightness: () => {
      set({ brightness: 1 })
      persist(get)
    },

    setZebra: (on) => {
      // The analysis material needs drawn faces, so it cannot be armed alone.
      const next = on && get().shading
      set(normalizeAnalysis(next, get().curvature, 'zebra'))
      persist(get)
    },

    setZebraStripes: (value) => {
      const next = Number.isFinite(value) ? Math.round(Math.min(40, Math.max(2, value))) : DEFAULT_VIEW_PREFERENCES.zebra_stripes
      set({ zebra_stripes: next })
      persist(get)
    },

    setCurvature: (on) => {
      const next = on && get().shading
      set(normalizeAnalysis(get().zebra, next, 'curvature'))
      persist(get)
    },

    setCurvatureKind: (kind) => {
      set({ curvature_kind: kind })
      persist(get)
    },

    setCurvatureRange: (range) => {
      // An inverted or non-finite range is not a user choice; keep the previous
      // one so the shader never divides by a negative span.
      if (range !== null && (!Number.isFinite(range[0]) || !Number.isFinite(range[1]) || range[0] >= range[1])) return
      set({ curvature_range: range })
      persist(get)
    },

    setCurvatureAutoRange: (range) => {
      // A derived value from the scene, so it is not a user edit and does not
      // touch the preferences port.
      set({ curvatureAutoRange: range })
    },

    setOrbitAroundCursor: (on) => {
      set({ orbit_around_cursor: on })
      persist(get)
    },

    // The public exception to "options follow the layers": this flag exists
    // only to debug the ID buffer, so it is kept even while shading is off.
    setCollisionDebug: (on) => set({ collisionDebug: on }),
  }
})

/** Re-seed the live state from the port. Boot calls this once before the first
 *  render; tests and a future profile switch can call it again. */
export function syncViewOptionsFromPreferences(): void {
  useViewOptionsStore.setState(viewOptionsFromPreferences(backendBundle.preferences.read()))
}
