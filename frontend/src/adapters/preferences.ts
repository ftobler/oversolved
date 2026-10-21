// Preferences capability: where user preferences (e.g. document sort) live.
//
// localStorage, not IndexedDB: these are a handful of small scalars read during
// the first render of the documents grid, and localStorage is the only browser
// store that can answer that synchronously. Putting them in the document
// database would cost an async hop and a loading flicker on every page load to
// remember which way a sort arrow points.
//
// Still a port rather than direct localStorage calls at the call site: the hook
// asks `backendBundle.preferences`, so preferences can later move (into the
// document store, into a synced profile) without touching the hook.
//
// `read` is deliberately synchronous, which is a real constraint on any future
// implementation, not an accident of this one: an async read would put a loading
// state and a first-render flicker into every consumer. A store that cannot
// answer synchronously has to cache into memory at boot and serve from there.

export type DocumentSort = 'alphabetical' | 'date_newest_first' | 'date_oldest_first'

const DOCUMENT_SORTS: ReadonlySet<string> = new Set(['alphabetical', 'date_newest_first', 'date_oldest_first'])

// A persisted value is untrusted: a stale or corrupted localStorage entry can
// carry anything, and the read is the only place it can be caught before the
// grid's sort switch sees a non-member.
function isDocumentSort(value: unknown): value is DocumentSort {
  return typeof value === 'string' && DOCUMENT_SORTS.has(value)
}

// ─── viewer options ───
// The viewport's viewer options travel with the same key. They are checked one
// field at a time so a single stale value cannot reset the rest of the view.
export type CurvatureKind = 'mean' | 'gaussian'

export const MIN_BRIGHTNESS = 0.5
export const MAX_BRIGHTNESS = 2
export const MIN_ZEBRA_STRIPES = 2
export const MAX_ZEBRA_STRIPES = 40

export interface ViewPreferences {
  shading: boolean
  edges: boolean
  // The renderer's toneMappingExposure: one global multiplier over every
  // tone-mapped material (bodies, edges, sketches), not over HTML chrome.
  brightness: number
  zebra: boolean
  // Whole stripe periods across the reflected view direction. Higher is finer.
  zebra_stripes: number
  curvature: boolean
  curvature_kind: CurvatureKind
  // null means "auto from the scene, with the outliers clamped".
  curvature_range: [number, number] | null
  // A right-drag turns about the body point under the cursor instead of the
  // camera target. On by default: it is how the user asked to reach a corner
  // the fixed pivot cannot.
  orbit_around_cursor: boolean
}

export const DEFAULT_VIEW_PREFERENCES: Readonly<ViewPreferences> = Object.freeze({
  // Today's look, exactly: a solution upgrade must not change the image.
  shading: true,
  edges: true,
  brightness: 1,
  zebra: false,
  zebra_stripes: 12,
  curvature: false,
  curvature_kind: 'mean',
  curvature_range: null,
  orbit_around_cursor: true,
})

export interface UserPreferences {
  document_sort: DocumentSort
  view: ViewPreferences
}

export const DEFAULT_PREFS: UserPreferences = {
  document_sort: 'date_newest_first',
  view: { ...DEFAULT_VIEW_PREFERENCES },
}

export interface PreferencesAdapter {
  read(): UserPreferences
  // `next` is the full updated set; `key`/`value` is the single changed field,
  // for a store that can write one field without rewriting the rest. Async
  // because writing may be slow or may fail -- the caller applies the change
  // optimistically and reverts if this rejects.
  save(next: UserPreferences, key: keyof UserPreferences, value: unknown): Promise<void>
}

const LS_KEY = 'oversolved.preferences'

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function isCurvatureKind(value: unknown): value is CurvatureKind {
  return value === 'mean' || value === 'gaussian'
}

function isRange(value: unknown): value is [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return false
  const [lo, hi] = value
  return typeof lo === 'number' && typeof hi === 'number'
    && Number.isFinite(lo) && Number.isFinite(hi) && lo < hi
}

/**
 * The cross-field rules, applied to whatever the record claims. Both layers off
 * would draw nothing, and both analysis materials cannot own the one body
 * material, so a hand-edited record is normalized rather than trusted.
 */
function normalizeView(view: ViewPreferences): ViewPreferences {
  const { shading } = view
  let { edges, zebra, curvature } = view
  if (!shading && !edges) edges = true
  if (!shading) { zebra = false; curvature = false }
  if (zebra && curvature) curvature = false
  return { ...view, shading, edges, zebra, curvature }
}

type RawView = { [field: string]: unknown }

function readView(raw: unknown): ViewPreferences {
  const record: RawView = raw !== null && typeof raw === 'object' ? raw as RawView : {}
  const d = DEFAULT_VIEW_PREFERENCES
  return normalizeView({
    shading: isBoolean(record.shading) ? record.shading : d.shading,
    edges: isBoolean(record.edges) ? record.edges : d.edges,
    brightness: clampNumber(record.brightness, MIN_BRIGHTNESS, MAX_BRIGHTNESS, d.brightness),
    zebra: isBoolean(record.zebra) ? record.zebra : d.zebra,
    zebra_stripes: Math.round(clampNumber(record.zebra_stripes, MIN_ZEBRA_STRIPES, MAX_ZEBRA_STRIPES, d.zebra_stripes)),
    curvature: isBoolean(record.curvature) ? record.curvature : d.curvature,
    curvature_kind: isCurvatureKind(record.curvature_kind) ? record.curvature_kind : d.curvature_kind,
    curvature_range: record.curvature_range === null || record.curvature_range === undefined
      ? null
      : isRange(record.curvature_range) ? [record.curvature_range[0], record.curvature_range[1]] : null,
    orbit_around_cursor: isBoolean(record.orbit_around_cursor) ? record.orbit_around_cursor : d.orbit_around_cursor,
  })
}

export function readLocalPrefs(): UserPreferences {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return { ...DEFAULT_PREFS, view: { ...DEFAULT_VIEW_PREFERENCES } }
    const parsed = JSON.parse(raw) as Partial<UserPreferences>
    return {
      document_sort: isDocumentSort(parsed.document_sort) ? parsed.document_sort : DEFAULT_PREFS.document_sort,
      view: readView(parsed.view),
    }
  } catch {
    return { ...DEFAULT_PREFS, view: { ...DEFAULT_VIEW_PREFERENCES } }
  }
}

export class LocalPreferences implements PreferencesAdapter {
  read(): UserPreferences { return readLocalPrefs() }
  async save(next: UserPreferences): Promise<void> {
    // A browser with site data disabled throws here. Losing a view preference is
    // not worth an error banner over, let alone an unhandled rejection, so the
    // write is best-effort and the in-memory value stands for this session.
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)) } catch {  /* quota / disabled */ }
  }
}
