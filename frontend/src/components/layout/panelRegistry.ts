// The activity-bar panel list. Data only, so the rail renders whatever panels
// exist without knowing what any of them are. C6 appends an 'origins' entry
// here and nothing else moves.
export type PanelId = 'workspace' | 'document' | 'origins'

export interface PanelDef {
  id: PanelId
  label: string
  icon: string  // a material-icons ligature, the same naming the rest of the UI uses
}

export const PANEL_DEFS: PanelDef[] = [
  { id: 'workspace', label: 'Workspace', icon: 'account_tree' },
  { id: 'document', label: 'Document', icon: 'description' },
  { id: 'origins', label: 'Origins', icon: 'cloud_sync' },
]
