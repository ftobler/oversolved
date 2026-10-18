import type { ReactNode } from 'react'
import '@/pages/Part.css'

interface SidebarProps {
  // The navigator to host. The assembly editor hands in its AssemblyTree and
  // that is the only production caller: the part editor's navigator floats
  // over the viewport instead (PartDocumentPanel in pages/PartEditorPanel.tsx).
  documentPanel: ReactNode
}

// The assembly editor's navigator host, and nothing else. The workspace layer
// used to live here behind an activity bar, one 288px rail switching
// Workspace / Document / Origins; it now has a surface of its own at
// `/workspaces/:workspace`, which has room for a thumbnail per entry. With one
// panel left there was nothing to switch, so the rail went with it and this is
// a plain host again: the aside is the flex column and the navigator is its
// only child, flexing to fill it. The part editor stopped using it with the
// floating panels (phase 1); phase 2 moves the assembly to the same cards and
// retires this host with the `.doc-sidebar` column.
export function Sidebar({ documentPanel }: SidebarProps) {
  return <aside className="doc-sidebar">{documentPanel}</aside>
}
