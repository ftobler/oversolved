// The editor-state port a headless run passes to the part command table. A
// drive session has no sketch editor: selection, the active tool and the value
// dialog are all idle, so the commands that read them see the same defaults the
// browser store starts with. The mutation commands never go through here.
import type { PartCommandState } from '@/session/partCommandSpecs'

export const HEADLESS_EDITOR_FACTS = {
  editingFeatureId: null,
  rollbackPosition: null,
} as const

export function createHeadlessCommandState(): PartCommandState {
  return {
    activeFeatureId: null,
    normalSelection: new Set(),
    entityKindMap: {},
    constructionEntityKeys: new Set(),
    filletCornerMap: {},
    activeTool: null,
    drawPoints: [],
    dimensionPicks: [],
    activePickField: null,
    pendingDialog: null,
    setActiveTool: () => {},
    setActivePickField: () => {},
    clearDraw: () => {},
    finishDraw: () => false,
    cancelPlacementGesture: () => {},
    clearDimensionPicks: () => {},
    toggleConstruction: () => {},
    mirrorSelection: () => 'mirror is an editor action',
    filletCorners: () => 'fillet is an editor action',
    patternEntities: () => 'pattern is an editor action',
    applyOffset: () => {},
    applyConstraint: () => 'constraints are authored through mutations headlessly',
    freezeProjection: () => {},
  }
}
