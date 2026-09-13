import type { ReactNode } from 'react'
import { PartDocumentPanel } from '@/components/layout/PartDocumentPanel'
import '@/pages/Part.css'
import '@/components/layout/Sidebar.css'

interface SidebarProps {
  // undefined keeps today's part stack, so the part editor and its tests render
  // <Sidebar /> unchanged; any other node is the open editor's own navigator
  // (AssemblyTree).
  documentPanel?: ReactNode
}

// The editor's navigator, and nothing else. The workspace layer used to live
// here behind an activity bar, one 288px rail switching Workspace / Document /
// Origins; it now has a surface of its own at `/workspaces/:workspace`, which
// has room for a thumbnail per entry. With one panel left there was nothing to
// switch, so the rail went with it and this is a plain host again: the aside is
// the flex column and the navigator is its only child, flexing to fill it.
export function Sidebar({ documentPanel }: SidebarProps) {
  return (
    <aside className="doc-sidebar">
      {documentPanel === undefined ? <PartDocumentPanel /> : documentPanel}
    </aside>
  )
}
