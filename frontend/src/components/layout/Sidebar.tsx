import type { ReactNode } from 'react'
import { ActivityBar } from '@/components/layout/ActivityBar'
import { PartDocumentPanel } from '@/components/layout/PartDocumentPanel'
import { WorkspaceTree } from '@/components/layout/WorkspaceTree'
import { FilesPanel } from '@/components/layout/FilesPanel'
import { PANEL_DEFS } from '@/components/layout/panelRegistry'
import { useLayoutStore } from '@/stores/layoutStore'
import '@/pages/Part.css'
import '@/components/layout/Sidebar.css'

interface SidebarProps {
  // undefined keeps today's part stack, so the part editor and its tests render
  // <Sidebar /> unchanged; null means "no open document", the no-entry workspace
  // route, and any other node is the open editor's own navigator (AssemblyTree).
  documentPanel?: ReactNode
}

// The panel host. A narrow activity bar switches between the Workspace panel
// (the tree plus the files view) and the open document's navigator, one visible
// at a time. Both panels stay mounted once opened and toggle the `hidden`
// attribute, so each navigator's DOM scrollTop and split percent survive a
// switch with no lifted view state. The workspace panel is lazy-mounted on its
// first activation (the store's `visited`), so opening an editor does not list a
// workspace nobody asked to see.
export function Sidebar({ documentPanel }: SidebarProps) {
  const activePanel = useLayoutStore(s => s.activePanel)
  const visited = useLayoutStore(s => s.visited)
  const setPanel = useLayoutStore(s => s.setPanel)

  return (
    <aside className="doc-sidebar">
      <ActivityBar panels={PANEL_DEFS} active={activePanel} onSelect={setPanel} />
      {visited.includes('workspace') && (
        <div className="sidebar-panel" hidden={activePanel !== 'workspace'}>
          <WorkspaceTree />
          <FilesPanel />
        </div>
      )}
      <div className="sidebar-panel" hidden={activePanel !== 'document'}>
        {documentPanel === undefined ? <PartDocumentPanel /> : documentPanel}
      </div>
    </aside>
  )
}
