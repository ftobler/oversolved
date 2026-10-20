import { create } from 'zustand'
import type { PartFeature } from '@/types/cad'
import { editorState } from '@/stores/editorState'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { queryLabel } from '@/utils/query/queryLabel'
import { renameReference, SET_NAME_PATTERN } from '@/utils/core/reportReferences'

// The bug-report draft is interaction state, not document state: it outlives the
// floating panel, follows the user between part editors and into an assembly,
// and never produces a Mutation or an undo entry. A store is also what keeps the
// report rules (names, seeding, references) out of the view, so they are tested
// without a Viewport.
export interface ReportPick {
  // What the user clicked, verbatim: the same string a pick chip holds.
  query: string
  // Readable at pick time; feature labels may be renamed later.
  label: string
  // The rollback bar and the feature it exposed when the pick was made. Two
  // sets named `before` and `after` are what carries a before/after comparison;
  // nothing here is invalidated by moving the bar later.
  rollback: number | null
  barFeatureId: string | null
  // The feature editor that was open during the pick, if any.
  editingFeatureId: string | null
}

export interface SelectionSet {
  id: string
  name: string
  picks: ReportPick[]
}

export interface ReportAttachments {
  doc: boolean
  history: boolean
  historyCount: number
}

export interface BugReportDraft {
  open: boolean
  title: string
  description: string
  sets: SelectionSet[]
  attachments: ReportAttachments
}

export interface PickContext {
  rollback: number | null
  barFeatureId: string | null
  editingFeatureId: string | null
  features: PartFeature[]
  partLabels: Record<string, string>
}

const DEFAULT_ATTACHMENTS: ReportAttachments = {
  doc: true,
  history: true,
  historyCount: 5,
}

export function emptyDraft(): BugReportDraft {
  return {
    open: false,
    title: '',
    description: '',
    sets: [],
    attachments: { ...DEFAULT_ATTACHMENTS },
  }
}

// The last feature the bar exposes, the way the tree reads the slot before the
// bar. A null bar is the end of the stack; 0 exposes nothing.
export function barFeatureIdAt(features: readonly PartFeature[], rollback: number | null): string | null {
  if (rollback === null) return features.length > 0 ? features[features.length - 1].id : null
  if (rollback <= 0) return null
  return features[rollback - 1]?.id ?? null
}

export function livePickContext(): PickContext {
  const state = editorState.getState()
  const { features, partLabels } = usePartEditorStore.getState()
  return {
    rollback: state.rollbackPosition,
    barFeatureId: barFeatureIdAt(features, state.rollbackPosition),
    editingFeatureId: state.editingFeatureId,
    features,
    partLabels,
  }
}

export function reportPick(query: string, ctx: PickContext): ReportPick {
  return {
    query,
    label: queryLabel(query, ctx.features, ctx.partLabels),
    rollback: ctx.rollback,
    barFeatureId: ctx.barFeatureId,
    editingFeatureId: ctx.editingFeatureId,
  }
}

// Identity within one draft is monotonic. A generated name or id is never
// reused after its set is removed or renamed, so a dangling `#reference` can
// never silently re-bind to a new set that happened to take the old name.
function nextSetIdentity(nextNumber: number, sets: readonly SelectionSet[]): {
  id: string
  name: string
  nextNumber: number
} {
  let n = Math.max(1, nextNumber)
  const liveNames = new Set(sets.map(s => s.name))
  while (liveNames.has(`set${n}`)) n++
  return { id: `set-${n}`, name: `set${n}`, nextNumber: n + 1 }
}

// A draft is worth confirming before it is thrown away when it holds anything
// the user typed or picked. An empty added set alone counts: the user made it.
export function isDraftEmpty(draft: BugReportDraft): boolean {
  return draft.title.trim() === ''
    && draft.description.trim() === ''
    && draft.sets.length === 0
}

interface BugReportState extends BugReportDraft {
  // Monotonic within a draft, so addSet never hands out a name or id that was
  // already used even after that set was removed or renamed.
  nextSetNumber: number
  openReport: (seedSelection?: readonly string[], ctx?: PickContext) => void
  // Hide the panel but keep the draft; the header button brings it back.
  close: () => void
  // Throw the draft away. The panel's Discard runs this, after a confirmation
  // when the draft is not empty.
  discard: () => void
  addSet: () => string
  // Returns null on success, or the reason the name was refused. A refusal
  // leaves the whole draft untouched, description references included.
  renameSet: (id: string, name: string) => string | null
  removeSet: (id: string) => void
  addPick: (setId: string, pick: ReportPick) => void
  removePick: (setId: string, query: string) => void
  reorderPick: (setId: string, fromIndex: number, toIndex: number) => void
  setText: (patch: { title?: string; description?: string }) => void
  setAttachments: (patch: Partial<ReportAttachments>) => void
}

export const useBugReportStore = create<BugReportState>((set, get) => ({
  ...emptyDraft(),
  nextSetNumber: 1,

  openReport: (seedSelection = [], ctx) => set(state => {
    // An existing draft wins over a fresh selection: reopening after a close
    // must not replace the sets the user already named. An empty open panel,
    // though, still takes the selection the user made before pressing the
    // header button.
    const hasDraft = state.sets.length > 0 || state.title !== '' || state.description !== ''
    if (hasDraft) return { open: true }
    if (seedSelection.length === 0) return { open: true }
    const identity = nextSetIdentity(state.nextSetNumber, state.sets)
    const context = ctx ?? livePickContext()
    return {
      open: true,
      nextSetNumber: identity.nextNumber,
      sets: [{
        id: identity.id,
        name: 'selection',
        picks: seedSelection.map(query => reportPick(query, context)),
      }],
    }
  }),

  close: () => set({ open: false }),

  discard: () => set({ ...emptyDraft(), nextSetNumber: 1 }),

  addSet: () => {
    const identity = nextSetIdentity(get().nextSetNumber, get().sets)
    set(state => ({
      sets: [...state.sets, { id: identity.id, name: identity.name, picks: [] }],
      nextSetNumber: identity.nextNumber,
    }))
    return identity.id
  },

  renameSet: (id, name) => {
    const state = get()
    const target = state.sets.find(s => s.id === id)
    if (!target) return null
    if (!SET_NAME_PATTERN.test(name)) return 'use letters, digits, - and _'
    if (state.sets.some(s => s.id !== id && s.name === name)) return 'name already used'
    if (target.name === name) return null
    const oldName = target.name
    set(s => ({
      sets: s.sets.map(entry => entry.id === id ? { ...entry, name } : entry),
      // The description is the only place a set name is written down, so a
      // rename rewrites it in the same action; a reference never dangles
      // merely because the name changed.
      description: renameReference(s.description, oldName, name),
    }))
    return null
  },

  removeSet: (id) => set(state => ({ sets: state.sets.filter(s => s.id !== id) })),

  addPick: (setId, pick) => set(state => ({
    sets: state.sets.map(s => {
      if (s.id !== setId) return s
      // The chip toggles a query off on a second click, so a set holds each
      // query once. The same face in a second set is how before/after is shown.
      if (s.picks.some(p => p.query === pick.query)) return s
      return { ...s, picks: [...s.picks, pick] }
    }),
  })),

  removePick: (setId, query) => set(state => ({
    sets: state.sets.map(s =>
      s.id === setId ? { ...s, picks: s.picks.filter(p => p.query !== query) } : s,
    ),
  })),

  reorderPick: (setId, fromIndex, toIndex) => set(state => ({
    sets: state.sets.map(s => {
      if (s.id !== setId) return s
      if (fromIndex < 0 || fromIndex >= s.picks.length) return s
      const picks = [...s.picks]
      const [moved] = picks.splice(fromIndex, 1)
      const target = Math.max(0, Math.min(toIndex, picks.length))
      picks.splice(target, 0, moved)
      return { ...s, picks }
    }),
  })),

  setText: (patch) => set(patch),

  setAttachments: (patch) => set(state => ({
    attachments: {
      ...state.attachments,
      ...patch,
      historyCount: Math.max(1, Math.floor(patch.historyCount ?? state.attachments.historyCount)),
    },
  })),
}))
